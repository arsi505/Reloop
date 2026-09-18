import * as dotenv from 'dotenv';
import Redis from 'ioredis';
import { PrismaClient, JobStatus, WorkerStatus, JobAttemptStatus } from '@prisma/client';
import { loadWorkerConfig } from '../apps/worker/src/config';
import { WorkerService } from '../apps/worker/src/worker-service';

dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

async function run3WorkerDemo() {
  console.log('===============================================================');
  console.log('  RELOOP DAY 7: 3-WORKER CONCURRENT RACE & LEASE LIVE DEMO   ');
  console.log('===============================================================\n');

  const streamKey = `reloop:demo:jobs:ready`;
  const consumerGroup = `recovery-workers-demo`;

  const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
  await prisma.$connect();
  const redis = new Redis(redisUrl);

  try {
    // 0. Clean up previous demo artifacts
    console.log('[Setup] Cleaning previous demo data from reloop_test and Redis...');
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.worker.deleteMany({});
    await redis.del(streamKey);

    const org = await prisma.organization.create({
      data: {
        name: 'Demo Org ' + Date.now(),
        slug: 'demo-org-' + Date.now(),
      },
    });

    // 1. Create 3 distinct worker configurations
    const workerConfigs = [
      { key: 'worker-alpha', consumer: 'consumer-alpha' },
      { key: 'worker-beta', consumer: 'consumer-beta' },
      { key: 'worker-gamma', consumer: 'consumer-gamma' },
    ];

    const workers: WorkerService[] = [];
    for (const wc of workerConfigs) {
      const config = loadWorkerConfig({
        redisUrl,
        jobStreamKey: streamKey,
        jobConsumerGroup: consumerGroup,
        workerKey: wc.key,
        workerConsumerName: wc.consumer,
        workerConcurrency: 3,
        jobLeaseDurationMs: 15000,
        jobLeaseRenewIntervalMs: 5000,
        workerHeartbeatIntervalMs: 1000,
        workerShutdownTimeoutMs: 5000,
        blockTimeoutMs: 100,
      });
      const worker = new WorkerService(config, prisma);
      workers.push(worker);
    }

    // 2. Start all 3 workers concurrently
    console.log('\n[Phase 1] Starting 3 distributed workers simultaneously...');
    await Promise.all(workers.map((w) => w.start()));

    // Verify worker registration in PostgreSQL
    const registeredWorkers = await prisma.worker.findMany({
      orderBy: { workerKey: 'asc' },
    });
    console.log(`[Phase 1 Result] ${registeredWorkers.length} workers registered in PostgreSQL:`);
    for (const rw of registeredWorkers) {
      console.log(`  - Worker: ${rw.workerKey} (id: ${rw.id}), Status: ${rw.status}, Heartbeat: ${rw.lastHeartbeatAt.toISOString()}`);
    }

    // 3. Create a single test job in PostgreSQL
    console.log('\n[Phase 2] Creating single test job in PostgreSQL (type: SYSTEM_NOOP)...');
    const job = await prisma.job.create({
      data: {
        organizationId: org.id,
        type: 'SYSTEM_NOOP',
        status: JobStatus.QUEUED,
        payload: { simulatedTask: 'Verify zero double-execution race condition' },
        attemptCount: 0,
        idempotencyKey: `demo-job-${Date.now()}`,
      },
    });
    console.log(`[Phase 2 Result] Job created: id=${job.id}, status=${job.status}, attemptCount=${job.attemptCount}`);

    // 4. Dispatch duplicate stream messages for the single job
    console.log('\n[Phase 3] Publishing 3 identical stream entries to simulate at-least-once multi-worker race...');
    const msgIds = await Promise.all([
      redis.xadd(streamKey, '*', 'jobId', job.id, 'type', 'SYSTEM_NOOP'),
      redis.xadd(streamKey, '*', 'jobId', job.id, 'type', 'SYSTEM_NOOP'),
      redis.xadd(streamKey, '*', 'jobId', job.id, 'type', 'SYSTEM_NOOP'),
    ]);
    console.log(`[Phase 3 Result] Stream messages published: ${msgIds.join(', ')}`);

    // 5. Wait for race resolution and execution
    console.log('\n[Phase 4] Observing workers race to claim and execute...');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // 6. Verify final state in PostgreSQL and Redis
    const finalJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const attempts = await prisma.jobAttempt.findMany({
      where: { jobId: job.id },
      include: { worker: true },
    });
    const pendingPEL = (await redis.xpending(streamKey, consumerGroup)) as any[];

    console.log('\n===============================================================');
    console.log('                  VERIFICATION RESULTS                         ');
    console.log('===============================================================');
    console.log(`Job Status:             ${finalJob.status} (Expected: SUCCEEDED)`);
    console.log(`Job Attempt Count:      ${finalJob.attemptCount} (Expected: 1)`);
    console.log(`Completed At:           ${finalJob.completedAt?.toISOString()}`);
    console.log(`Lease Expires At:       ${finalJob.leaseExpiresAt ?? 'NULL (released)'}`);
    console.log(`Claimed Worker:         ${finalJob.claimedByWorkerId ?? 'NULL (released)'}`);
    console.log(`Total Job Attempts:     ${attempts.length} (Expected: 1)`);

    if (attempts.length === 1) {
      const winner = attempts[0];
      console.log(`\nWINNING WORKER:         ${winner.worker?.workerKey} (id: ${winner.workerId})`);
      console.log(`Attempt Status:         ${winner.status}`);
      console.log(`Attempt Started At:     ${winner.startedAt.toISOString()}`);
      console.log(`Attempt Finished At:    ${winner.finishedAt?.toISOString()}`);
      console.log(`Attempt Duration:       ${winner.durationMs}ms`);
    }

    console.log(`\nRedis Stream PEL:       ${pendingPEL[0]} pending messages (Expected: 0)`);

    const racePassed =
      finalJob.status === JobStatus.SUCCEEDED &&
      finalJob.attemptCount === 1 &&
      attempts.length === 1 &&
      attempts[0].status === JobAttemptStatus.SUCCEEDED &&
      pendingPEL[0] === 0;

    console.log(`\nRace Verification Verdict: ${racePassed ? 'PASSED (EXACTLY 1 WINNER)' : 'FAILED'}`);

    // 7. Graceful Shutdown
    console.log('\n[Phase 5] Shutting down all 3 workers gracefully...');
    await Promise.all(workers.map((w) => w.stop()));

    const stoppedWorkers = await prisma.worker.findMany({
      orderBy: { workerKey: 'asc' },
    });
    console.log('[Phase 5 Result] Workers status after shutdown:');
    for (const sw of stoppedWorkers) {
      console.log(`  - Worker: ${sw.workerKey}, Status: ${sw.status}, StoppedAt: ${sw.stoppedAt?.toISOString()}`);
    }

    console.log('\n=== 3-Worker Live Demonstration Completed Successfully ===\n');
  } finally {
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

run3WorkerDemo().catch((err) => {
  console.error('Fatal error in 3-worker demo:', err);
  process.exit(1);
});
