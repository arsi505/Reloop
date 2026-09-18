import * as dotenv from 'dotenv';
import Redis from 'ioredis';
import { PrismaClient, JobStatus, JobAttemptStatus } from '@prisma/client';
import { loadWorkerConfig } from '../apps/worker/src/config';
import { WorkerService } from '../apps/worker/src/worker-service';
import { JobExecutorRegistry } from '../apps/worker/src/executor';

dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

async function runCrashRecoveryDemo() {
  console.log('===============================================================');
  console.log('  RELOOP DAY 9: WORKER CRASH, STALE PEL & LEASE RECOVERY DEMO  ');
  console.log('===============================================================\n');

  const streamKey = `reloop:demo:crash:jobs:ready`;
  const consumerGroup = `crash-recovery-demo-group`;

  const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
  await prisma.$connect();
  const redis = new Redis(redisUrl);

  try {
    // 0. Setup and clean
    console.log('[Setup] Cleaning demo Redis streams and creating consumer group...');
    await redis.del(streamKey);
    try {
      await redis.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
    } catch {
      // Group may already exist
    }

    const org = await prisma.organization.create({
      data: {
        name: 'Crash Demo Org ' + Date.now(),
        slug: 'crash-demo-org-' + Date.now(),
      },
    });

    // =========================================================================
    // SCENARIO A: Worker Crashes in CLAIMED (Before Execution Started)
    // =========================================================================
    console.log('\n---------------------------------------------------------------');
    console.log('SCENARIO A: Worker Crashed in CLAIMED (Before Execution Started)');
    console.log('---------------------------------------------------------------');

    // 1. Create a job in CLAIMED state with an expired lease, simulating Worker A crash
    const deadWorkerKeyA = `worker-crashed-A-${Date.now()}`;
    const deadWorkerA = await prisma.worker.create({
      data: {
        workerKey: deadWorkerKeyA,
        status: 'OFFLINE',
      },
    });

    const jobA = await prisma.job.create({
      data: {
        organizationId: org.id,
        type: 'SYSTEM_NOOP',
        status: JobStatus.CLAIMED,
        attemptCount: 1,
        maxAttempts: 3,
        claimedByWorkerId: deadWorkerA.id,
        leaseExpiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago!
        payload: { task: 'safe-idempotent-task' },
        idempotencyKey: `idemp-demo-A-${Date.now()}`,
      },
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: jobA.id,
        workerId: deadWorkerA.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 10000),
      },
    });

    // Simulate Worker A reading the message into PEL without XACK
    const msgIdA = (await redis.xadd(streamKey, '*', 'jobId', jobA.id, 'type', 'SYSTEM_NOOP')) as string;
    await redis.xreadgroup('GROUP', consumerGroup, deadWorkerKeyA, 'COUNT', 1, 'STREAMS', streamKey, '>');

    console.log(`[Scenario A] Created Job ${jobA.id} in CLAIMED state (attempt 1), lease expired.`);
    console.log(`[Scenario A] Simulated Worker A reading msg ${msgIdA} into PEL without XACK.`);

    const pelBeforeA = ((await redis.xpending(streamKey, consumerGroup)) as any[])[0];
    console.log(`[Scenario A] Current PEL count before recovery: ${pelBeforeA} pending message(s).`);

    // 2. Start Worker B with fast recovery scan
    console.log('[Scenario A] Starting Worker B to scan and recover stale messages...');
    let workerBExecutedA = false;
    const registryB = new JobExecutorRegistry();
    registryB.register('SYSTEM_NOOP', async () => {
      workerBExecutedA = true;
      console.log('  -> Worker B executing recovered job handler successfully!');
    });

    const workerBConfig = loadWorkerConfig({
      redisUrl,
      jobStreamKey: streamKey,
      jobConsumerGroup: consumerGroup,
      workerKey: `worker-recovery-B-${Date.now()}`,
      workerConsumerName: `consumer-recovery-B-${Date.now()}`,
      workerConcurrency: 2,
      jobLeaseDurationMs: 10000,
      jobLeaseRenewIntervalMs: 3000,
      workerHeartbeatIntervalMs: 1000,
      workerShutdownTimeoutMs: 3000,
      blockTimeoutMs: 100,
      workerRecoveryScanIntervalMs: 5000,
      workerPelMinIdleMs: 50, // 50ms for demo speed
      workerRecoveryBatchSize: 10,
    });

    const workerB = new WorkerService(workerBConfig, prisma, { executorRegistry: registryB });
    await workerB.start();

    // Trigger recovery scan
    await new Promise((r) => setTimeout(r, 100)); // wait for minIdleMs
    const recoveryResultA = await workerB.getRecoveryService().scanOnce();
    console.log(`[Scenario A] Recovery scan completed:`, recoveryResultA);

    // Give pipeline a moment to complete execution and commit
    await new Promise((r) => setTimeout(r, 500));

    // 3. Inspect PostgreSQL & Redis state
    const updatedJobA = await prisma.job.findUnique({
      where: { id: jobA.id },
      include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
    });

    const pelAfterA = ((await redis.xpending(streamKey, consumerGroup)) as any[])[0];
    console.log(`[Scenario A] Job final status: ${updatedJobA!.status}`);
    console.log(`[Scenario A] Total attempts in DB: ${updatedJobA!.attempts.length}`);
    console.log(`  - Attempt 1 status: ${updatedJobA!.attempts[0].status} (${updatedJobA!.attempts[0].errorCode})`);
    console.log(`  - Attempt 2 status: ${updatedJobA!.attempts[1]?.status} (worker: ${updatedJobA!.attempts[1]?.workerId})`);
    console.log(`[Scenario A] PEL count after recovery: ${pelAfterA} pending message(s).`);

    if (
      updatedJobA!.status === JobStatus.SUCCEEDED &&
      updatedJobA!.attempts[0].status === JobAttemptStatus.ABANDONED &&
      updatedJobA!.attempts[1].status === JobAttemptStatus.SUCCEEDED &&
      pelAfterA === 0
    ) {
      console.log('>>> SCENARIO A PASSED: Attempt 1 abandoned, Attempt 2 executed to SUCCEEDED, PEL clean! <<<\n');
    } else {
      throw new Error('Scenario A failed verification');
    }

    await workerB.stop();

    // =========================================================================
    // SCENARIO B: Worker Crashes in RUNNING (During Handler Execution)
    // =========================================================================
    console.log('---------------------------------------------------------------');
    console.log('SCENARIO B: Worker Crashed in RUNNING (During Execution)');
    console.log('---------------------------------------------------------------');

    const deadWorkerKeyB = `worker-crashed-B-${Date.now()}`;
    const deadWorkerB = await prisma.worker.create({
      data: {
        workerKey: deadWorkerKeyB,
        status: 'OFFLINE',
      },
    });

    const jobB = await prisma.job.create({
      data: {
        organizationId: org.id,
        type: 'SYSTEM_NOOP',
        status: JobStatus.RUNNING,
        attemptCount: 1,
        maxAttempts: 3,
        claimedByWorkerId: deadWorkerB.id,
        leaseExpiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago!
        payload: { task: 'non-idempotent-payment' },
        idempotencyKey: `idemp-demo-B-${Date.now()}`,
      },
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: jobB.id,
        workerId: deadWorkerB.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 15000),
      },
    });

    const msgIdB = (await redis.xadd(streamKey, '*', 'jobId', jobB.id, 'type', 'SYSTEM_NOOP')) as string;
    await redis.xreadgroup('GROUP', consumerGroup, deadWorkerKeyB, 'COUNT', 1, 'STREAMS', streamKey, '>');

    console.log(`[Scenario B] Created Job ${jobB.id} in RUNNING state, lease expired.`);
    console.log(`[Scenario B] Simulated Worker B reading msg ${msgIdB} into PEL without XACK.`);

    const pelBeforeB = ((await redis.xpending(streamKey, consumerGroup)) as any[])[0];
    console.log(`[Scenario B] Current PEL count before recovery: ${pelBeforeB} pending message(s).`);

    // Start Worker C to recover Scenario B
    console.log('[Scenario B] Starting Worker C to scan and recover stale messages...');
    let workerCRan = false;
    const registryC = new JobExecutorRegistry();
    registryC.register('SYSTEM_NOOP', async () => {
      workerCRan = true;
    });

    const workerCConfig = loadWorkerConfig({
      redisUrl,
      jobStreamKey: streamKey,
      jobConsumerGroup: consumerGroup,
      workerKey: `worker-recovery-C-${Date.now()}`,
      workerConsumerName: `consumer-recovery-C-${Date.now()}`,
      workerConcurrency: 2,
      jobLeaseDurationMs: 10000,
      jobLeaseRenewIntervalMs: 3000,
      workerHeartbeatIntervalMs: 1000,
      workerShutdownTimeoutMs: 3000,
      blockTimeoutMs: 100,
      workerRecoveryScanIntervalMs: 5000,
      workerPelMinIdleMs: 50, // 50ms for demo speed
      workerRecoveryBatchSize: 10,
    });

    const workerC = new WorkerService(workerCConfig, prisma, { executorRegistry: registryC });
    await workerC.start();

    // Trigger recovery scan from Worker C after minIdleMs
    await new Promise((r) => setTimeout(r, 100));
    const recoveryResultB = await workerC.getRecoveryService().scanOnce();
    console.log(`[Scenario B] Recovery scan completed:`, recoveryResultB);

    await new Promise((r) => setTimeout(r, 200));

    // Inspect state
    const updatedJobB = await prisma.job.findUnique({
      where: { id: jobB.id },
      include: { attempts: true },
    });

    const pelAfterB = ((await redis.xpending(streamKey, consumerGroup)) as any[])[0];
    console.log(`[Scenario B] Job final status: ${updatedJobB!.status}`);
    console.log(`[Scenario B] Job completedAt: ${updatedJobB!.completedAt}`);
    console.log(`[Scenario B] Attempt status: ${updatedJobB!.attempts[0].status} (${updatedJobB!.attempts[0].errorCode})`);
    console.log(`[Scenario B] Attempt error message: "${updatedJobB!.attempts[0].errorMessage}"`);
    console.log(`[Scenario B] PEL count after recovery: ${pelAfterB} pending message(s).`);

    if (
      updatedJobB!.status === JobStatus.BLOCKED &&
      updatedJobB!.completedAt === null &&
      updatedJobB!.attempts[0].status === JobAttemptStatus.ABANDONED &&
      updatedJobB!.attempts[0].errorCode === 'AMBIGUOUS_WORKER_CRASH' &&
      workerCRan === false &&
      pelAfterB === 0
    ) {
      console.log('>>> SCENARIO B PASSED: Attempt abandoned with AMBIGUOUS_WORKER_CRASH, Job BLOCKED, 0 re-executions, PEL clean! <<<\n');
    } else {
      throw new Error('Scenario B failed verification');
    }

    await workerC.stop();
    console.log('===============================================================');
    console.log('  ALL CRASH RECOVERY DEMO SCENARIOS VERIFIED SUCCESSFULLY!    ');
    console.log('===============================================================');
  } finally {
    await redis.del(streamKey).catch(() => {});
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

runCrashRecoveryDemo().catch((err) => {
  console.error('[FATAL DEMO ERROR]', err);
  process.exit(1);
});
