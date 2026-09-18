import * as dotenv from 'dotenv';
import * as path from 'path';
import Redis from 'ioredis';
import {
  PrismaClient,
  JobStatus,
  JobAttemptStatus,
  JobErrorCategory,
  WorkerStatus,
} from '@prisma/client';
import { loadWorkerConfig } from '../src/config';
import { JobClaimService } from '../src/job-claim';
import { JobExecutorRegistry } from '../src/executor';
import { WorkerService } from '../src/worker-service';
import { StaleMessageRecoveryService } from '../src/stale-message-recovery';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

describe('Day 9: Worker Crash, Stale PEL & Expired Lease Recovery', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let testOrgId: string;
  let runId: string;
  let testStreamKey: string;
  let testGroup: string;
  const activeWorkers: WorkerService[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
    redis = new Redis(redisUrl);
  });

  afterAll(async () => {
    for (const worker of activeWorkers) {
      if (worker.getIsRunning()) {
        await worker.stop().catch(() => {});
      }
    }
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(async () => {
    runId = Math.random().toString(36).substring(2, 9);
    testStreamKey = `reloop:test:recovery:${runId}:jobs:ready`;
    testGroup = `test-recovery-group-${runId}`;

    const org = await prisma.organization.create({
      data: {
        name: `Recovery Test Org ${runId}`,
        slug: `recovery-org-${runId}`,
      },
    });
    testOrgId = org.id;

    // Create stream and consumer group
    await redis.xgroup('CREATE', testStreamKey, testGroup, '$', 'MKSTREAM');
  });

  afterEach(async () => {
    while (activeWorkers.length > 0) {
      const worker = activeWorkers.pop();
      if (worker && worker.getIsRunning()) {
        await worker.stop().catch(() => {});
      }
    }

    const keys = await redis.keys(`reloop:test:recovery:${runId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  function createWorker(
    overrides: Partial<Parameters<typeof loadWorkerConfig>[0]> = {},
    executorRegistry?: JobExecutorRegistry,
  ): WorkerService {
    const config = loadWorkerConfig({
      redisUrl,
      jobStreamKey: testStreamKey,
      jobConsumerGroup: testGroup,
      workerKey: `worker-${runId}-${Math.random().toString(36).substring(2, 7)}`,
      workerConsumerName: `consumer-${runId}-${Math.random().toString(36).substring(2, 7)}`,
      workerConcurrency: 5,
      jobLeaseDurationMs: 15000,
      jobLeaseRenewIntervalMs: 5000,
      workerHeartbeatIntervalMs: 1000,
      workerShutdownTimeoutMs: 5000,
      blockTimeoutMs: 100,
      workerRecoveryScanIntervalMs: 5000,
      workerPelMinIdleMs: 50,
      workerRecoveryBatchSize: 20,
      ...overrides,
    });
    const worker = new WorkerService(config, prisma, { executorRegistry });
    activeWorkers.push(worker);
    return worker;
  }

  async function createTestJob(data: {
    type?: string;
    status?: JobStatus;
    payload?: any;
    attemptCount?: number;
    maxAttempts?: number;
    claimedByWorkerId?: string;
    leaseExpiresAt?: Date;
    nextRunAt?: Date;
    completedAt?: Date;
    idempotencyKey?: string;
  } = {}) {
    return prisma.job.create({
      data: {
        organizationId: testOrgId,
        type: data.type ?? 'SYSTEM_NOOP',
        status: data.status ?? JobStatus.QUEUED,
        payload: data.payload ?? {},
        attemptCount: data.attemptCount ?? 0,
        maxAttempts: data.maxAttempts ?? 3,
        claimedByWorkerId: data.claimedByWorkerId ?? null,
        leaseExpiresAt: data.leaseExpiresAt ?? null,
        nextRunAt: data.nextRunAt,
        completedAt: data.completedAt,
        idempotencyKey: data.idempotencyKey ?? `idemp-${runId}-${Math.random().toString(36).substring(2, 9)}`,
      },
    });
  }

  async function createTestWorkerRecord(name: string = 'dead-worker') {
    return prisma.worker.create({
      data: {
        workerKey: `${name}-${runId}-${Math.random().toString(36).substring(2, 7)}`,
        status: WorkerStatus.OFFLINE,
        startedAt: new Date(Date.now() - 60000),
        lastHeartbeatAt: new Date(Date.now() - 60000),
      },
    });
  }

  /**
   * Simulates a message delivered to a consumer and abandoned in PEL (without XACK).
   */
  async function simulateAbandonedPelMessage(
    consumerName: string,
    jobId: string,
    type: string = 'SYSTEM_NOOP',
  ): Promise<string> {
    // 1. Publish to stream
    const msgId = (await redis.xadd(testStreamKey, '*', 'jobId', jobId, 'type', type)) as string;
    // 2. Read by simulated worker (enters PEL)
    await redis.xreadgroup('GROUP', testGroup, consumerName, 'COUNT', 1, 'STREAMS', testStreamKey, '>');
    return msgId;
  }

  /**
   * Checks pending entries in consumer group PEL.
   */
  async function getPelCount(): Promise<number> {
    const summary = (await redis.xpending(testStreamKey, testGroup)) as any[];
    return summary ? summary[0] : 0;
  }

  // =========================================================================
  // 1. PEL Discovery & Verification
  // =========================================================================
  it('1. discovers abandoned PEL messages via XAUTOCLAIM after minIdleMs', async () => {
    const deadConsumer = 'crashed-worker-1';
    const job = await createTestJob();
    const msgId = await simulateAbandonedPelMessage(deadConsumer, job.id);

    // Verify it is in PEL
    const initialPel = await getPelCount();
    expect(initialPel).toBe(1);

    // Wait for minIdleMs (60ms)
    await new Promise((r) => setTimeout(r, 70));

    const worker = createWorker({ workerPelMinIdleMs: 50 });
    await worker.start();

    // Trigger recovery scan
    const recoveryService = worker.getRecoveryService();
    const result = await recoveryService.scanOnce();

    expect(result.claimedCount).toBeGreaterThanOrEqual(1);

    // Verify worker executed and XACKed
    await new Promise((r) => setTimeout(r, 200));
    const finalPel = await getPelCount();
    expect(finalPel).toBe(0);

    const updatedJob = await prisma.job.findUnique({ where: { id: job.id } });
    expect(updatedJob!.status).toBe(JobStatus.SUCCEEDED);
  });

  // =========================================================================
  // 2. Malformed Redis Message -> XACK immediately, 0 DB mutations
  // =========================================================================
  it('2. acknowledges and clears malformed Redis messages (missing/invalid jobId) from PEL', async () => {
    const deadConsumer = 'crashed-worker-2';

    // Malformed message 1: no jobId field
    const msgId1 = (await redis.xadd(testStreamKey, '*', 'badField', 'nonsense')) as string;
    await redis.xreadgroup('GROUP', testGroup, deadConsumer, 'COUNT', 1, 'STREAMS', testStreamKey, '>');

    // Malformed message 2: non-UUID jobId
    const msgId2 = (await redis.xadd(testStreamKey, '*', 'jobId', 'not-a-uuid-123')) as string;
    await redis.xreadgroup('GROUP', testGroup, deadConsumer, 'COUNT', 1, 'STREAMS', testStreamKey, '>');

    expect(await getPelCount()).toBe(2);

    await new Promise((r) => setTimeout(r, 70));

    const worker = createWorker({ workerPelMinIdleMs: 50 });
    await worker.start();

    const result = await worker.getRecoveryService().scanOnce();
    expect(result.ackedTerminalCount).toBe(2);

    // PEL should now be clean
    expect(await getPelCount()).toBe(0);
  });

  // =========================================================================
  // 3. Missing Job (Valid UUID not in DB) -> XACK immediately
  // =========================================================================
  it('3. acknowledges stale message when jobId does not exist in PostgreSQL', async () => {
    const deadConsumer = 'crashed-worker-3';
    const nonExistentJobId = '00000000-0000-0000-0000-000000000099';

    await simulateAbandonedPelMessage(deadConsumer, nonExistentJobId);
    expect(await getPelCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 70));

    const worker = createWorker({ workerPelMinIdleMs: 50 });
    await worker.start();

    const result = await worker.getRecoveryService().scanOnce();
    expect(result.ackedTerminalCount).toBe(1);
    expect(await getPelCount()).toBe(0);
  });

  // =========================================================================
  // 4. Stale QUEUED Message (Worker crashed before atomic claim)
  // =========================================================================
  it('4. recovers stale QUEUED message through normal atomic claim pipeline to SUCCEEDED', async () => {
    const deadConsumer = 'crashed-worker-4';
    const job = await createTestJob({ status: JobStatus.QUEUED });
    const msgId = await simulateAbandonedPelMessage(deadConsumer, job.id);

    expect(await getPelCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 70));

    let executed = false;
    const registry = new JobExecutorRegistry();
    registry.register('SYSTEM_NOOP', async () => {
      executed = true;
    });

    const worker = createWorker({ workerPelMinIdleMs: 50 }, registry);
    await worker.start();

    await worker.getRecoveryService().scanOnce();
    await new Promise((r) => setTimeout(r, 300));

    expect(executed).toBe(true);
    expect(await getPelCount()).toBe(0);

    const updatedJob = await prisma.job.findUnique({
      where: { id: job.id },
      include: { attempts: true },
    });
    expect(updatedJob!.status).toBe(JobStatus.SUCCEEDED);
    expect(updatedJob!.attemptCount).toBe(1);
    expect(updatedJob!.attempts.length).toBe(1);
    expect(updatedJob!.attempts[0].status).toBe(JobAttemptStatus.SUCCEEDED);
  });

  // =========================================================================
  // 5. Expired CLAIMED (Attempts Remain) -> ABANDON old attempt, create new, execute
  // =========================================================================
  it('5. recovers expired CLAIMED job: marks previous attempt ABANDONED, creates attempt 2, executes to SUCCEEDED', async () => {
    const deadWorker = await createTestWorkerRecord('crashed-worker-5');
    const deadConsumer = deadWorker.workerKey;

    // Job was claimed by dead worker, attempt 1 was created, lease is in past (expired)
    const job = await createTestJob({
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000), // expired 5s ago
    });

    const oldAttempt = await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: deadWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 10000),
      },
    });

    const msgId = await simulateAbandonedPelMessage(deadConsumer, job.id);
    expect(await getPelCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 70));

    let executedAttemptCount = 0;
    const registry = new JobExecutorRegistry();
    registry.register('SYSTEM_NOOP', async () => {
      executedAttemptCount++;
    });

    const recoveringWorker = createWorker({ workerPelMinIdleMs: 50 }, registry);
    await recoveringWorker.start();

    const result = await recoveringWorker.getRecoveryService().scanOnce();
    expect(result.recoveredClaimedCount).toBe(1);

    // Wait for pipeline execution
    await new Promise((r) => setTimeout(r, 300));

    expect(executedAttemptCount).toBe(1);
    expect(await getPelCount()).toBe(0);

    const updatedJob = await prisma.job.findUnique({
      where: { id: job.id },
      include: {
        attempts: {
          orderBy: { attemptNumber: 'asc' },
        },
      },
    });

    expect(updatedJob!.status).toBe(JobStatus.SUCCEEDED);
    expect(updatedJob!.attemptCount).toBe(2);
    expect(updatedJob!.attempts.length).toBe(2);

    // Verify Attempt #1 was durably ABANDONED
    const attempt1 = updatedJob!.attempts[0];
    expect(attempt1.attemptNumber).toBe(1);
    expect(attempt1.status).toBe(JobAttemptStatus.ABANDONED);
    expect(attempt1.errorCode).toBe('WORKER_LEASE_EXPIRED_BEFORE_EXECUTION');
    expect(attempt1.errorCategory).toBe(JobErrorCategory.UNKNOWN);
    expect(attempt1.finishedAt).not.toBeNull();

    // Verify Attempt #2 was executed to SUCCEEDED
    const attempt2 = updatedJob!.attempts[1];
    expect(attempt2.attemptNumber).toBe(2);
    expect(attempt2.workerId).toBe(recoveringWorker.getWorkerDbId());
    expect(attempt2.status).toBe(JobAttemptStatus.SUCCEEDED);
  });

  // =========================================================================
  // 6. Expired CLAIMED (Max Attempts Exhausted) -> ABANDON attempt, DEAD_LETTERED, 0 executions
  // =========================================================================
  it('6. recovers expired CLAIMED job with exhausted attempts: marks ABANDONED, transitions to DEAD_LETTERED, XACKs without execution', async () => {
    const deadWorker = await createTestWorkerRecord('crashed-worker-6');
    const deadConsumer = deadWorker.workerKey;

    // attemptCount = 3, maxAttempts = 3 -> no attempts remain!
    const job = await createTestJob({
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 3,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000), // expired
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: deadWorker.id,
        attemptNumber: 3,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 10000),
      },
    });

    const msgId = await simulateAbandonedPelMessage(deadConsumer, job.id);
    expect(await getPelCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 70));

    let handlerRan = false;
    const registry = new JobExecutorRegistry();
    registry.register('SYSTEM_NOOP', async () => {
      handlerRan = true;
    });

    const recoveringWorker = createWorker({ workerPelMinIdleMs: 50 }, registry);
    await recoveringWorker.start();

    const result = await recoveringWorker.getRecoveryService().scanOnce();
    expect(result.recoveredClaimedCount).toBe(1);
    expect(result.ackedTerminalCount).toBe(1);

    expect(handlerRan).toBe(false);
    expect(await getPelCount()).toBe(0);

    const updatedJob = await prisma.job.findUnique({
      where: { id: job.id },
      include: { attempts: true },
    });

    expect(updatedJob!.status).toBe(JobStatus.DEAD_LETTERED);
    expect(updatedJob!.completedAt).not.toBeNull();
    expect(updatedJob!.leaseExpiresAt).toBeNull();
    expect(updatedJob!.claimedByWorkerId).toBeNull();

    const lastAttempt = updatedJob!.attempts.find((a) => a.attemptNumber === 3);
    expect(lastAttempt!.status).toBe(JobAttemptStatus.ABANDONED);
    expect(lastAttempt!.errorCode).toBe('WORKER_LEASE_EXPIRED_BEFORE_EXECUTION');
  });

  // =========================================================================
  // 7. Expired RUNNING -> ABANDON attempt (AMBIGUOUS_WORKER_CRASH), BLOCKED, 0 executions
  // =========================================================================
  it('7. recovers expired RUNNING job: marks attempt ABANDONED (AMBIGUOUS_WORKER_CRASH), transitions to BLOCKED, completedAt=NULL, 0 executions', async () => {
    const deadWorker = await createTestWorkerRecord('crashed-worker-7');
    const deadConsumer = deadWorker.workerKey;

    // Worker crashed during RUNNING; lease expired
    const job = await createTestJob({
      status: JobStatus.RUNNING,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000), // expired
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: deadWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 15000),
      },
    });

    const msgId = await simulateAbandonedPelMessage(deadConsumer, job.id);
    expect(await getPelCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 70));

    let handlerRan = false;
    const registry = new JobExecutorRegistry();
    registry.register('SYSTEM_NOOP', async () => {
      handlerRan = true;
    });

    const recoveringWorker = createWorker({ workerPelMinIdleMs: 50 }, registry);
    await recoveringWorker.start();

    const result = await recoveringWorker.getRecoveryService().scanOnce();
    expect(result.blockedRunningCount).toBe(1);
    expect(result.ackedTerminalCount).toBe(1);

    expect(handlerRan).toBe(false);
    expect(await getPelCount()).toBe(0);

    const updatedJob = await prisma.job.findUnique({
      where: { id: job.id },
      include: { attempts: true },
    });

    expect(updatedJob!.status).toBe(JobStatus.BLOCKED);
    expect(updatedJob!.completedAt).toBeNull();
    expect(updatedJob!.leaseExpiresAt).toBeNull();
    expect(updatedJob!.claimedByWorkerId).toBeNull();

    const attempt = updatedJob!.attempts[0];
    expect(attempt.status).toBe(JobAttemptStatus.ABANDONED);
    expect(attempt.errorCode).toBe('AMBIGUOUS_WORKER_CRASH');
    expect(attempt.errorMessage).toContain('ambiguous state requires external verification');
  });

  // =========================================================================
  // 8. Active CLAIMED Lease Protection
  // =========================================================================
  it('8. leaves active CLAIMED lease untouched (no DB mutation, no execution, no XACK)', async () => {
    const liveWorker = await createTestWorkerRecord('live-worker-8');
    const liveConsumer = liveWorker.workerKey;

    // Lease valid for 60 seconds into the future
    const futureLease = new Date(Date.now() + 60000);
    const job = await createTestJob({
      status: JobStatus.CLAIMED,
      claimedByWorkerId: liveWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: futureLease,
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: liveWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(),
      },
    });

    const msgId = await simulateAbandonedPelMessage(liveConsumer, job.id);
    expect(await getPelCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 70));

    let handlerRan = false;
    const registry = new JobExecutorRegistry();
    registry.register('SYSTEM_NOOP', async () => {
      handlerRan = true;
    });

    const recoveringWorker = createWorker({ workerPelMinIdleMs: 50 }, registry);
    await recoveringWorker.start();

    const result = await recoveringWorker.getRecoveryService().scanOnce();
    expect(result.recoveredClaimedCount).toBe(0);
    expect(result.ackedTerminalCount).toBe(0);
    expect(handlerRan).toBe(false);

    // Message must still be in PEL for the holding worker
    expect(await getPelCount()).toBe(1);

    // DB state must be identical
    const jobCheck = await prisma.job.findUnique({ where: { id: job.id } });
    expect(jobCheck!.status).toBe(JobStatus.CLAIMED);
    expect(jobCheck!.claimedByWorkerId).toBe(liveWorker.id);
  });

  // =========================================================================
  // 9. Active RUNNING Lease Protection
  // =========================================================================
  it('9. leaves active RUNNING lease untouched (no DB mutation, no execution, no XACK)', async () => {
    const liveWorker = await createTestWorkerRecord('live-worker-9');
    const liveConsumer = liveWorker.workerKey;

    const futureLease = new Date(Date.now() + 60000);
    const job = await createTestJob({
      status: JobStatus.RUNNING,
      claimedByWorkerId: liveWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: futureLease,
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: liveWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(),
      },
    });

    const msgId = await simulateAbandonedPelMessage(liveConsumer, job.id);
    expect(await getPelCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 70));

    const recoveringWorker = createWorker({ workerPelMinIdleMs: 50 });
    await recoveringWorker.start();

    const result = await recoveringWorker.getRecoveryService().scanOnce();
    expect(result.blockedRunningCount).toBe(0);
    expect(result.ackedTerminalCount).toBe(0);

    // Message must remain in PEL
    expect(await getPelCount()).toBe(1);

    const jobCheck = await prisma.job.findUnique({ where: { id: job.id } });
    expect(jobCheck!.status).toBe(JobStatus.RUNNING);
    expect(jobCheck!.claimedByWorkerId).toBe(liveWorker.id);
  });

  // =========================================================================
  // 10. RETRY_WAITING Stale Message -> XACK only, nextRunAt untouched
  // =========================================================================
  it('10. acknowledges stale RETRY_WAITING message without early execution, leaving nextRunAt intact', async () => {
    const deadConsumer = 'crashed-worker-10';
    const futureNextRun = new Date(Date.now() + 300000); // 5 minutes in future

    const job = await createTestJob({
      status: JobStatus.RETRY_WAITING,
      attemptCount: 1,
      maxAttempts: 3,
      nextRunAt: futureNextRun,
    });

    await simulateAbandonedPelMessage(deadConsumer, job.id);
    expect(await getPelCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 70));

    let handlerRan = false;
    const registry = new JobExecutorRegistry();
    registry.register('SYSTEM_NOOP', async () => {
      handlerRan = true;
    });

    const recoveringWorker = createWorker({ workerPelMinIdleMs: 50 }, registry);
    await recoveringWorker.start();

    const result = await recoveringWorker.getRecoveryService().scanOnce();
    expect(result.ackedTerminalCount).toBe(1);
    expect(handlerRan).toBe(false);

    // PEL cleaned
    expect(await getPelCount()).toBe(0);

    const jobCheck = await prisma.job.findUnique({ where: { id: job.id } });
    expect(jobCheck!.status).toBe(JobStatus.RETRY_WAITING);
    expect(jobCheck!.nextRunAt!.getTime()).toBe(futureNextRun.getTime());
    expect(jobCheck!.attemptCount).toBe(1);
  });

  // =========================================================================
  // 11. Terminal Signals in PEL (SUCCEEDED, FAILED, DEAD_LETTERED, BLOCKED)
  // =========================================================================
  it('11. acknowledges and cleans stale PEL messages for terminal/non-executable job states', async () => {
    const deadConsumer = 'crashed-worker-11';

    const terminalStatuses: JobStatus[] = [
      JobStatus.SUCCEEDED,
      JobStatus.FAILED,
      JobStatus.DEAD_LETTERED,
      JobStatus.BLOCKED,
      JobStatus.CANCELLED,
      JobStatus.WAITING_APPROVAL,
    ];

    for (const status of terminalStatuses) {
      const job = await createTestJob({
        status,
        completedAt: status === JobStatus.WAITING_APPROVAL || status === JobStatus.BLOCKED ? undefined : new Date(),
      });
      await simulateAbandonedPelMessage(deadConsumer, job.id);
    }

    expect(await getPelCount()).toBe(terminalStatuses.length);
    await new Promise((r) => setTimeout(r, 70));

    let handlerRan = false;
    const registry = new JobExecutorRegistry();
    registry.register('SYSTEM_NOOP', async () => {
      handlerRan = true;
    });

    const recoveringWorker = createWorker({ workerPelMinIdleMs: 50 }, registry);
    await recoveringWorker.start();

    const result = await recoveringWorker.getRecoveryService().scanOnce();
    expect(result.ackedTerminalCount).toBe(terminalStatuses.length);
    expect(handlerRan).toBe(false);
    expect(await getPelCount()).toBe(0);
  });

  // =========================================================================
  // 12. 3-Worker Race on Expired CLAIMED Job
  // =========================================================================
  it('12. resolves concurrent recovery race on expired CLAIMED job: exactly 1 worker wins, 1 new attempt created, 1 execution', async () => {
    const deadWorker = await createTestWorkerRecord('dead-worker-12');

    const job = await createTestJob({
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000), // expired
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: deadWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 10000),
      },
    });

    const worker1 = await createTestWorkerRecord('recovery-worker-12A');
    const worker2 = await createTestWorkerRecord('recovery-worker-12B');
    const worker3 = await createTestWorkerRecord('recovery-worker-12C');

    const claimService = new JobClaimService(prisma);

    // Concurrently trigger recoverExpiredClaimedJob from 3 different workers
    const results = await Promise.all([
      claimService.recoverExpiredClaimedJob(job.id, worker1.id, 15000),
      claimService.recoverExpiredClaimedJob(job.id, worker2.id, 15000),
      claimService.recoverExpiredClaimedJob(job.id, worker3.id, 15000),
    ]);

    const successfulRecoveries = results.filter((r) => r.recovered && r.execute);
    expect(successfulRecoveries.length).toBe(1);

    const updatedJob = await prisma.job.findUnique({
      where: { id: job.id },
      include: {
        attempts: { orderBy: { attemptNumber: 'asc' } },
      },
    });

    const winningWorkerId = updatedJob!.claimedByWorkerId!;
    expect([worker1.id, worker2.id, worker3.id]).toContain(winningWorkerId);

    expect(updatedJob!.status).toBe(JobStatus.CLAIMED);
    expect(updatedJob!.attemptCount).toBe(2);
    expect(updatedJob!.attempts.length).toBe(2);

    expect(updatedJob!.attempts[0].status).toBe(JobAttemptStatus.ABANDONED);
    expect(updatedJob!.attempts[1].status).toBe(JobAttemptStatus.STARTED);
    expect(updatedJob!.attempts[1].workerId).toBe(winningWorkerId);
  });

  // =========================================================================
  // 13. 3-Worker Race on Expired RUNNING Job
  // =========================================================================
  it('13. resolves concurrent recovery race on expired RUNNING job: exactly 1 transitions to BLOCKED, 0 duplicate transitions', async () => {
    const deadWorker = await createTestWorkerRecord('dead-worker-13');

    const job = await createTestJob({
      status: JobStatus.RUNNING,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000), // expired
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: deadWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 10000),
      },
    });

    const claimService = new JobClaimService(prisma);

    // Concurrently trigger recoverExpiredRunningJob from 3 workers
    const results = await Promise.all([
      claimService.recoverExpiredRunningJob(job.id),
      claimService.recoverExpiredRunningJob(job.id),
      claimService.recoverExpiredRunningJob(job.id),
    ]);

    const winners = results.filter((r) => r === true);
    expect(winners.length).toBe(1);

    const updatedJob = await prisma.job.findUnique({
      where: { id: job.id },
      include: { attempts: true },
    });

    expect(updatedJob!.status).toBe(JobStatus.BLOCKED);
    expect(updatedJob!.completedAt).toBeNull();
    expect(updatedJob!.attempts.length).toBe(1);
    expect(updatedJob!.attempts[0].status).toBe(JobAttemptStatus.ABANDONED);
    expect(updatedJob!.attempts[0].errorCode).toBe('AMBIGUOUS_WORKER_CRASH');
  });

  // =========================================================================
  // 14. Transaction Ordering: DB commit occurs BEFORE XACK
  // =========================================================================
  it('14. guarantees DB commit occurs before XACK and subsequent scan is idempotent if XACK was delayed', async () => {
    const deadWorker = await createTestWorkerRecord('dead-worker-14');
    const deadConsumer = deadWorker.workerKey;

    const job = await createTestJob({
      status: JobStatus.RUNNING,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000),
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: deadWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 10000),
      },
    });

    const msgId = await simulateAbandonedPelMessage(deadConsumer, job.id);
    expect(await getPelCount()).toBe(1);

    // Step 1: Execute DB recovery directly (simulating crash before XACK)
    const claimService = new JobClaimService(prisma);
    const recovered = await claimService.recoverExpiredRunningJob(job.id);
    expect(recovered).toBe(true);

    // Verify DB committed BLOCKED
    const jobMid = await prisma.job.findUnique({ where: { id: job.id } });
    expect(jobMid!.status).toBe(JobStatus.BLOCKED);

    // Message is still in PEL!
    expect(await getPelCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 70));

    // Step 2: Next recovery scan discovers stale PEL message for BLOCKED job
    const recoveringWorker = createWorker({ workerPelMinIdleMs: 50 });
    await recoveringWorker.start();

    const scanResult = await recoveringWorker.getRecoveryService().scanOnce();
    // It should identify it as terminal/blocked, XACK it, and clear the PEL
    expect(scanResult.ackedTerminalCount).toBe(1);
    expect(await getPelCount()).toBe(0);
  });

  // =========================================================================
  // 15. Recovery Concurrency Limit: Recovered jobs strictly obey WORKER_CONCURRENCY
  // =========================================================================
  it('15. recovered executable jobs strictly respect WORKER_CONCURRENCY budget (concurrency = 2 with 5 expired CLAIMED jobs)', async () => {
    const deadWorker = await createTestWorkerRecord('dead-worker-15');
    const deadConsumer = deadWorker.workerKey;

    const jobs = [];
    for (let i = 0; i < 5; i++) {
      const j = await createTestJob({
        status: JobStatus.CLAIMED,
        claimedByWorkerId: deadWorker.id,
        attemptCount: 1,
        maxAttempts: 3,
        leaseExpiresAt: new Date(Date.now() - 5000),
      });
      await prisma.jobAttempt.create({
        data: {
          jobId: j.id,
          workerId: deadWorker.id,
          attemptNumber: 1,
          status: JobAttemptStatus.STARTED,
          startedAt: new Date(Date.now() - 10000),
        },
      });
      await simulateAbandonedPelMessage(deadConsumer, j.id);
      jobs.push(j);
    }

    expect(await getPelCount()).toBe(5);
    await new Promise((r) => setTimeout(r, 70));

    let activeRunning = 0;
    let maxSimultaneous = 0;
    const completedJobs: string[] = [];

    const registry = new JobExecutorRegistry();
    registry.register('SYSTEM_NOOP', async (ctx) => {
      activeRunning++;
      maxSimultaneous = Math.max(maxSimultaneous, activeRunning);
      // Controlled delay
      await new Promise((r) => setTimeout(r, 120));
      activeRunning--;
      completedJobs.push(ctx.jobId);
    });

    // Worker with concurrency 2
    const worker = createWorker({ workerConcurrency: 2, workerPelMinIdleMs: 50, workerRecoveryBatchSize: 10 }, registry);
    await worker.start();

    // First scan pass will discover the jobs and claim up to concurrency limit (2)
    const scanResult1 = await worker.getRecoveryService().scanOnce();
    expect(scanResult1.recoveredClaimedCount).toBeLessThanOrEqual(2);

    // Give some time for jobs to run
    await new Promise((r) => setTimeout(r, 60));
    expect(activeRunning).toBeLessThanOrEqual(2);
    expect(maxSimultaneous).toBeLessThanOrEqual(2);

    // Wait for the first batch to finish
    await new Promise((r) => setTimeout(r, 200));
    expect(completedJobs.length).toBeGreaterThanOrEqual(2);

    // Trigger second scan pass for remaining jobs
    await worker.getRecoveryService().scanOnce();
    await new Promise((r) => setTimeout(r, 250));

    // Trigger third scan pass if needed
    if (completedJobs.length < 5) {
      await worker.getRecoveryService().scanOnce();
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(maxSimultaneous).toBe(2);
    expect(maxSimultaneous).toBeLessThanOrEqual(2);
  });

  // =========================================================================
  // 16. Normal + Recovery Shared Concurrency Limit
  // =========================================================================
  it('16. mixed workload of normal XREADGROUP jobs and XAUTOCLAIM recovered jobs shares single WORKER_CONCURRENCY limit', async () => {
    const deadWorker = await createTestWorkerRecord('dead-worker-16');
    const deadConsumer = deadWorker.workerKey;

    // 1 recovered job in PEL
    const recoveredJob = await createTestJob({
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000),
    });
    await prisma.jobAttempt.create({
      data: {
        jobId: recoveredJob.id,
        workerId: deadWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 10000),
      },
    });
    await simulateAbandonedPelMessage(deadConsumer, recoveredJob.id);

    // 2 normal jobs in stream
    const normalJob1 = await createTestJob({ status: JobStatus.QUEUED });
    const normalJob2 = await createTestJob({ status: JobStatus.QUEUED });
    await redis.xadd(testStreamKey, '*', 'jobId', normalJob1.id, 'type', 'SYSTEM_NOOP');
    await redis.xadd(testStreamKey, '*', 'jobId', normalJob2.id, 'type', 'SYSTEM_NOOP');

    await new Promise((r) => setTimeout(r, 70));

    let activeRunning = 0;
    let maxSimultaneous = 0;

    const registry = new JobExecutorRegistry();
    registry.register('SYSTEM_NOOP', async () => {
      activeRunning++;
      maxSimultaneous = Math.max(maxSimultaneous, activeRunning);
      await new Promise((r) => setTimeout(r, 120));
      activeRunning--;
    });

    // Concurrency is 2
    const worker = createWorker({ workerConcurrency: 2, workerPelMinIdleMs: 50 }, registry);
    await worker.start();

    // Trigger recovery scan concurrently with normal consumer loop
    await worker.getRecoveryService().scanOnce();

    // Wait until all 3 jobs complete
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      const pel = await getPelCount();
      if (pel === 0 && activeRunning === 0) {
        const j1 = await prisma.job.findUnique({ where: { id: normalJob1.id } });
        const j2 = await prisma.job.findUnique({ where: { id: normalJob2.id } });
        const jr = await prisma.job.findUnique({ where: { id: recoveredJob.id } });
        if (j1?.status === 'SUCCEEDED' && j2?.status === 'SUCCEEDED' && jr?.status === 'SUCCEEDED') {
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(maxSimultaneous).toBeLessThanOrEqual(2);
    expect(maxSimultaneous).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // 17. Recovery Slot Safety: No-slot situation does not strand newly recovered CLAIMED ownership
  // =========================================================================
  it('17. no-slot situation reserves capacity first and prevents stranding newly recovered CLAIMED ownership', async () => {
    const deadWorker = await createTestWorkerRecord('dead-worker-17');
    const deadConsumer = deadWorker.workerKey;

    const job = await createTestJob({
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000),
    });
    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: deadWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 10000),
      },
    });
    await simulateAbandonedPelMessage(deadConsumer, job.id);
    expect(await getPelCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 70));

    // Worker with concurrency 1
    let longJobRunning = false;
    let releaseLongJob: (() => void) | null = null;
    const registry = new JobExecutorRegistry();
    registry.register('LONG_TASK', async () => {
      longJobRunning = true;
      await new Promise<void>((resolve) => {
        releaseLongJob = resolve;
      });
    });

    const worker = createWorker({ workerConcurrency: 1, workerPelMinIdleMs: 50 }, registry);
    await worker.start();

    // Put a long job in the worker to consume its only available slot
    const blockingJob = await createTestJob({ type: 'LONG_TASK', status: JobStatus.QUEUED });
    await redis.xadd(testStreamKey, '*', 'jobId', blockingJob.id, 'type', 'LONG_TASK');

    // Wait for blocking job to occupy the slot
    while (!longJobRunning) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(worker.getActiveJobCount()).toBe(1);

    // Now run recovery scan pass while worker has 0 available slots
    const scanResult = await worker.getRecoveryService().scanOnce();
    expect(scanResult.recoveredClaimedCount).toBe(0);

    // Verify the expired CLAIMED job was NOT touched or transferred!
    const jobCheck = await prisma.job.findUnique({
      where: { id: job.id },
      include: { attempts: true },
    });

    // Must still be claimed by dead worker, attemptCount remains 1, 0 new attempts created
    expect(jobCheck!.status).toBe(JobStatus.CLAIMED);
    expect(jobCheck!.claimedByWorkerId).toBe(deadWorker.id);
    expect(jobCheck!.attemptCount).toBe(1);
    expect(jobCheck!.attempts.length).toBe(1);
    expect(jobCheck!.attempts[0].attemptNumber).toBe(1);

    // Release long job to allow clean shutdown
    if (releaseLongJob) (releaseLongJob as () => void)();
    await new Promise((r) => setTimeout(r, 100));
  });

  // =========================================================================
  // 18. Graceful Shutdown Recovery: Stop prevents new recovery while active execution drains
  // =========================================================================
  it('18. graceful shutdown prevents new recovery scans while allowing active recovered execution to drain under lease renewal', async () => {
    const deadWorker = await createTestWorkerRecord('dead-worker-18');
    const deadConsumer = deadWorker.workerKey;

    // Job 1: To be recovered and actively executed
    const job1 = await createTestJob({
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000),
    });
    await prisma.jobAttempt.create({
      data: {
        jobId: job1.id,
        workerId: deadWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 10000),
      },
    });
    await simulateAbandonedPelMessage(deadConsumer, job1.id);

    // Job 2: To remain unrecovered during drain
    const job2 = await createTestJob({
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000),
    });
    await prisma.jobAttempt.create({
      data: {
        jobId: job2.id,
        workerId: deadWorker.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 10000),
      },
    });

    await new Promise((r) => setTimeout(r, 70));

    let job1Executing = false;
    let job1Finished = false;

    const registry = new JobExecutorRegistry();
    registry.register('SYSTEM_NOOP', async (ctx) => {
      if (ctx.jobId === job1.id) {
        job1Executing = true;
        // Controlled delay to allow shutdown to begin while job is in-flight
        await new Promise((r) => setTimeout(r, 200));
        job1Finished = true;
      }
    });

    const worker = createWorker({ workerConcurrency: 2, workerPelMinIdleMs: 50, workerShutdownTimeoutMs: 5000 }, registry);
    await worker.start();

    // Trigger recovery of job 1
    await worker.getRecoveryService().scanOnce();

    // Wait until job 1 is actively running
    while (!job1Executing) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(worker.getActiveJobCount()).toBe(1);

    // Now put job 2 in PEL right as shutdown begins
    await simulateAbandonedPelMessage(deadConsumer, job2.id);

    // Initiate stop() (graceful shutdown / drain)
    const stopPromise = worker.stop();

    // While draining, attempt a recovery scan
    const drainScan = await worker.getRecoveryService().scanOnce();
    // Must return 0 recoveries because worker is draining
    expect(drainScan.recoveredClaimedCount).toBe(0);

    // Wait for shutdown to finish
    await stopPromise;

    // Verify job 1 completed cleanly
    expect(job1Finished).toBe(true);
    const updatedJob1 = await prisma.job.findUnique({ where: { id: job1.id } });
    expect(updatedJob1!.status).toBe(JobStatus.SUCCEEDED);

    // Verify job 2 was NOT recovered
    const updatedJob2 = await prisma.job.findUnique({ where: { id: job2.id } });
    expect(updatedJob2!.status).toBe(JobStatus.CLAIMED);
    expect(updatedJob2!.claimedByWorkerId).toBe(deadWorker.id);

    // Verify worker row reached OFFLINE
    const workerRow = await prisma.worker.findUnique({ where: { id: worker.getWorkerDbId() } });
    expect(workerRow!.status).toBe(WorkerStatus.OFFLINE);
    expect(workerRow!.stoppedAt).not.toBeNull();
  });
});
