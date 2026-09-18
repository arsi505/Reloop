import * as dotenv from 'dotenv';
import * as path from 'path';
import Redis from 'ioredis';
import { PrismaClient, JobStatus, WorkerStatus, JobAttemptStatus } from '@prisma/client';
import { loadWorkerConfig } from '../src/config';
import { JobClaimService } from '../src/job-claim';
import { JobExecutorRegistry } from '../src/executor';
import { WorkerService } from '../src/worker-service';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

describe('Day 7: Distributed Worker Engine, Atomic Claims & Leases', () => {
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
    testStreamKey = `reloop:test:worker:${runId}:jobs:ready`;
    testGroup = `test-worker-group-${runId}`;

    // Clean database in reverse dependency order
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.worker.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});

    const org = await prisma.organization.create({
      data: {
        name: `Test Org ${runId}`,
        slug: `test-org-${runId}`,
      },
    });
    testOrgId = org.id;
  });

  afterEach(async () => {
    while (activeWorkers.length > 0) {
      const worker = activeWorkers.pop();
      if (worker && worker.getIsRunning()) {
        await worker.stop().catch(() => {});
      }
    }

    const keys = await redis.keys(`reloop:test:worker:${runId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  function createWorker(overrides: Partial<Parameters<typeof loadWorkerConfig>[0]> = {}, executorRegistry?: JobExecutorRegistry): WorkerService {
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
    claimedByWorkerId?: string;
    leaseExpiresAt?: Date;
    nextRunAt?: Date;
  } = {}) {
    return prisma.job.create({
      data: {
        organizationId: testOrgId,
        type: data.type ?? 'SYSTEM_NOOP',
        status: data.status ?? JobStatus.QUEUED,
        payload: data.payload ?? {},
        attemptCount: data.attemptCount ?? 0,
        claimedByWorkerId: data.claimedByWorkerId ?? null,
        leaseExpiresAt: data.leaseExpiresAt ?? null,
        nextRunAt: data.nextRunAt,
        idempotencyKey: `idemp-${runId}-${Math.random().toString(36).substring(2, 9)}`,
      },
    });
  }

  async function publishJob(jobId: string, type: string = 'SYSTEM_NOOP'): Promise<string> {
    const id = await redis.xadd(testStreamKey, '*', 'jobId', jobId, 'type', type);
    return id as string;
  }

  // =========================================================================
  // Test A: Worker Registration
  // =========================================================================
  it('A. registers Worker row in PostgreSQL with ONLINE status, metadata, and lastHeartbeatAt', async () => {
    const worker = createWorker();
    await worker.start();

    const workerDbId = worker.getWorkerDbId();
    expect(workerDbId).toBeDefined();

    const workerRow = await prisma.worker.findUnique({
      where: { id: workerDbId },
    });
    expect(workerRow).not.toBeNull();
    expect(workerRow!.status).toBe(WorkerStatus.ONLINE);
    expect(workerRow!.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(workerRow!.startedAt).toBeInstanceOf(Date);
    expect(workerRow!.stoppedAt).toBeNull();

    const metadata = workerRow!.metadata as any;
    expect(metadata).toBeDefined();
    expect(metadata.concurrency).toBe(5);
    expect(metadata.pid).toBe(process.pid);
  });

  // =========================================================================
  // Test B: Heartbeat updates
  // =========================================================================
  it('B. advances lastHeartbeatAt over time via background heartbeat', async () => {
    const worker = createWorker({ workerHeartbeatIntervalMs: 150 });
    await worker.start();

    const workerDbId = worker.getWorkerDbId();
    const initialRow = await prisma.worker.findUniqueOrThrow({ where: { id: workerDbId } });
    const initialHeartbeat = initialRow.lastHeartbeatAt.getTime();

    // Wait for at least 2 heartbeats
    await new Promise((resolve) => setTimeout(resolve, 400));

    const updatedRow = await prisma.worker.findUniqueOrThrow({ where: { id: workerDbId } });
    expect(updatedRow.lastHeartbeatAt.getTime()).toBeGreaterThan(initialHeartbeat);
  });

  // =========================================================================
  // Test C: Consumer Group Initialization
  // =========================================================================
  it('C. creates consumer group if non-existent and handles existing BUSYGROUP gracefully', async () => {
    const worker1 = createWorker();
    await worker1.start();

    // Check group exists in Redis
    const groups = (await redis.xinfo('GROUPS', testStreamKey)) as any[];
    expect(groups.length).toBe(1);
    expect(groups[0][1]).toBe(testGroup);

    // Starting a second worker on same group should not throw (BUSYGROUP handled)
    const worker2 = createWorker({ workerKey: `worker-2-${runId}`, workerConsumerName: `consumer-2-${runId}` });
    await expect(worker2.start()).resolves.not.toThrow();
  });

  // =========================================================================
  // Test D: Message Consumption via XREADGROUP
  // =========================================================================
  it('D. consumes published job from Redis Streams via XREADGROUP', async () => {
    const job = await createTestJob({ type: 'SYSTEM_NOOP' });
    const worker = createWorker();
    await worker.start();

    await publishJob(job.id, 'SYSTEM_NOOP');

    // Wait for job to be picked up and processed
    await new Promise((resolve) => setTimeout(resolve, 500));

    const updatedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(updatedJob.status).toBe(JobStatus.SUCCEEDED);
  });

  // =========================================================================
  // Test E: Atomic Claim
  // =========================================================================
  it('E. atomically claims QUEUED job: status -> CLAIMED, claimedByWorkerId, leaseExpiresAt set, attemptCount incremented, then transitions to RUNNING', async () => {
    const job = await createTestJob({ type: 'SYSTEM_NOOP' });
    const claimService = new JobClaimService(prisma);

    // Simulate worker db row
    const workerRow = await prisma.worker.create({
      data: {
        workerKey: `claim-test-${runId}`,
        status: WorkerStatus.ONLINE,
      },
    });

    const result = await claimService.atomicClaimJob(
      job.id,
      workerRow.id,
      15000,
    );

    expect(result.claimed).toBe(true);
    expect(result.attemptNumber).toBe(1);
    expect(result.attemptId).toBeDefined();

    // 1. Verify CLAIMED status in PostgreSQL
    const claimedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(claimedJob.status).toBe(JobStatus.CLAIMED);
    expect(claimedJob.claimedByWorkerId).toBe(workerRow.id);
    expect(claimedJob.leaseExpiresAt).not.toBeNull();
    expect(claimedJob.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(claimedJob.attemptCount).toBe(1);

    // 2. Verify JobAttempt STARTED exists
    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: job.id } });
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe(JobAttemptStatus.STARTED);
    expect(attempts[0].attemptNumber).toBe(1);

    // 3. Conditional transition to RUNNING before handler execution
    const transitioned = await claimService.transitionToRunning(job.id, workerRow.id);
    expect(transitioned).toBe(true);

    const runningJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(runningJob.status).toBe(JobStatus.RUNNING);
    expect(runningJob.claimedByWorkerId).toBe(workerRow.id);
  });

  // =========================================================================
  // Test F: Single Attempt Creation
  // =========================================================================
  it('F. creates JobAttempt record with status STARTED and attemptNumber matching attemptCount', async () => {
    const job = await createTestJob({ type: 'SYSTEM_NOOP', attemptCount: 2 });
    const claimService = new JobClaimService(prisma);

    const workerRow = await prisma.worker.create({
      data: {
        workerKey: `attempt-test-${runId}`,
        status: WorkerStatus.ONLINE,
      },
    });

    const result = await claimService.atomicClaimJob(
      job.id,
      workerRow.id,
      15000,
    );

    expect(result.claimed).toBe(true);
    expect(result.attemptNumber).toBe(3);

    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: job.id } });
    expect(attempts.length).toBe(1);
    expect(attempts[0].attemptNumber).toBe(3);
    expect(attempts[0].workerId).toBe(workerRow.id);
    expect(attempts[0].status).toBe(JobAttemptStatus.STARTED);
    expect(attempts[0].startedAt).toBeInstanceOf(Date);
    expect(attempts[0].finishedAt).toBeNull();
  });

  // =========================================================================
  // Test G: SYSTEM_NOOP Execution
  // =========================================================================
  it('G. executes SYSTEM_NOOP to SUCCEEDED with completedAt, finishedAt, and post-commit XACK', async () => {
    const job = await createTestJob({ type: 'SYSTEM_NOOP' });
    const worker = createWorker();
    await worker.start();

    const msgId = await publishJob(job.id, 'SYSTEM_NOOP');

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 500));

    const finishedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(finishedJob.status).toBe(JobStatus.SUCCEEDED);
    expect(finishedJob.completedAt).toBeInstanceOf(Date);
    expect(finishedJob.leaseExpiresAt).toBeNull();
    expect(finishedJob.claimedByWorkerId).toBeNull();

    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: job.id } });
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe(JobAttemptStatus.SUCCEEDED);
    expect(attempts[0].finishedAt).toBeInstanceOf(Date);

    // Verify Redis stream message is ACKed (no pending entry)
    const pending = (await redis.xpending(testStreamKey, testGroup, '-', '+', 10)) as any[];
    const entryForMsg = pending.find((p) => p[0] === msgId);
    expect(entryForMsg).toBeUndefined();
  });

  // =========================================================================
  // Test H: Duplicate stream message (at-least-once simulation)
  // =========================================================================
  it('H. handles duplicate stream message: second worker skips execution, creates NO new attempt, and ACKs', async () => {
    const job = await createTestJob({ type: 'SYSTEM_NOOP' });
    const worker1 = createWorker({ workerKey: `w1-${runId}`, workerConsumerName: `c1-${runId}` });
    await worker1.start();

    // Worker 1 processes the job
    const msgId1 = await publishJob(job.id, 'SYSTEM_NOOP');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const jobAfterW1 = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobAfterW1.status).toBe(JobStatus.SUCCEEDED);

    const worker2 = createWorker({ workerKey: `w2-${runId}`, workerConsumerName: `c2-${runId}` });
    await worker2.start();

    // Now push duplicate message for already SUCCEEDED job
    const msgId2 = await publishJob(job.id, 'SYSTEM_NOOP');
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Must still have exactly 1 attempt
    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: job.id } });
    expect(attempts.length).toBe(1);

    // Duplicate message must be ACKed in Redis
    const pending = (await redis.xpending(testStreamKey, testGroup, '-', '+', 10)) as any[];
    const entryForMsg2 = pending.find((p) => p[0] === msgId2);
    expect(entryForMsg2).toBeUndefined();
  });

  // =========================================================================
  // Test I: 3-Worker Race Condition
  // =========================================================================
  it('I. 3-worker race: 3 workers race on duplicate messages; exactly ONE claims and executes, others ACK and remain idle', async () => {
    const job = await createTestJob({ type: 'SYSTEM_NOOP' });

    const w1 = createWorker({ workerKey: `race-1-${runId}`, workerConsumerName: `c-1-${runId}` });
    const w2 = createWorker({ workerKey: `race-2-${runId}`, workerConsumerName: `c-2-${runId}` });
    const w3 = createWorker({ workerKey: `race-3-${runId}`, workerConsumerName: `c-3-${runId}` });

    await Promise.all([w1.start(), w2.start(), w3.start()]);

    // Push 3 stream entries for the SAME jobId to simulate concurrent delivery
    await Promise.all([
      publishJob(job.id, 'SYSTEM_NOOP'),
      publishJob(job.id, 'SYSTEM_NOOP'),
      publishJob(job.id, 'SYSTEM_NOOP'),
    ]);

    // Wait for all 3 messages to be consumed and processed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const finalJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(finalJob.status).toBe(JobStatus.SUCCEEDED);
    expect(finalJob.attemptCount).toBe(1);

    // Exactly 1 attempt in database
    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: job.id } });
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe(JobAttemptStatus.SUCCEEDED);

    // All messages in the PEL must be ACKed
    const pending = (await redis.xpending(testStreamKey, testGroup)) as any[];
    expect(pending[0]).toBe(0); // total pending count is 0
  });

  // =========================================================================
  // Test J: Worker Concurrency Limit
  // =========================================================================
  it('J. enforces concurrency limit: concurrency=2 never processes more than 2 jobs simultaneously', async () => {
    let maxObservedConcurrency = 0;

    const worker = createWorker({
      workerConcurrency: 2,
      workerKey: `concurrency-${runId}`,
    });

    // We can monitor active job count
    const interval = setInterval(() => {
      const active = worker.getActiveJobCount();
      if (active > maxObservedConcurrency) {
        maxObservedConcurrency = active;
      }
    }, 20);

    await worker.start();

    // Create 4 SYSTEM_DELAY jobs of 250ms each
    const jobs = await Promise.all([
      createTestJob({ type: 'SYSTEM_DELAY', payload: { delayMs: 250 } }),
      createTestJob({ type: 'SYSTEM_DELAY', payload: { delayMs: 250 } }),
      createTestJob({ type: 'SYSTEM_DELAY', payload: { delayMs: 250 } }),
      createTestJob({ type: 'SYSTEM_DELAY', payload: { delayMs: 250 } }),
    ]);

    for (const j of jobs) {
      await publishJob(j.id, 'SYSTEM_DELAY');
    }

    // Wait until all 4 complete (at concurrency 2, 2 * 250ms ~= 500-800ms)
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const finished = await prisma.job.count({
        where: { id: { in: jobs.map((j) => j.id) }, status: JobStatus.SUCCEEDED },
      });
      if (finished === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    clearInterval(interval);

    const finalCount = await prisma.job.count({
      where: { id: { in: jobs.map((j) => j.id) }, status: JobStatus.SUCCEEDED },
    });
    expect(finalCount).toBe(4);
    expect(maxObservedConcurrency).toBeLessThanOrEqual(2);
    expect(maxObservedConcurrency).toBeGreaterThan(0);
  });

  // =========================================================================
  // Test K: Lease Renewal
  // =========================================================================
  it('K. automatically renews lease for long-running job before lease expires', async () => {
    // Lease 400ms, renew every 150ms
    const worker = createWorker({
      jobLeaseDurationMs: 400,
      jobLeaseRenewIntervalMs: 150,
      workerKey: `lease-worker-${runId}`,
    });

    const job = await createTestJob({
      type: 'SYSTEM_DELAY',
      payload: { delayMs: 500 }, // job lasts 500ms > initial lease 400ms
    });

    await worker.start();
    await publishJob(job.id, 'SYSTEM_DELAY');

    // Wait 250ms (after first renewal interval of 150ms)
    await new Promise((resolve) => setTimeout(resolve, 250));

    const runningJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    // If renewal happened, leaseExpiresAt should have been extended beyond Date.now()
    expect(runningJob.leaseExpiresAt).not.toBeNull();
    expect(runningJob.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 100);

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 500));

    const finalJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(finalJob.status).toBe(JobStatus.SUCCEEDED);
  });

  // =========================================================================
  // Test L: Wrong Worker Cannot Renew Lease
  // =========================================================================
  it('L. rejects lease renewal from a worker that does not own the job lease', async () => {
    const claimService = new JobClaimService(prisma);

    const w1 = await prisma.worker.create({
      data: { workerKey: `w1-${runId}`, status: WorkerStatus.ONLINE },
    });
    const w2 = await prisma.worker.create({
      data: { workerKey: `w2-${runId}`, status: WorkerStatus.ONLINE },
    });

    const job = await createTestJob({
      status: JobStatus.RUNNING,
      claimedByWorkerId: w1.id,
      leaseExpiresAt: new Date(Date.now() + 10000),
    });

    // Attempt renewal with w2 (imposter)
    const renewedByW2 = await claimService.renewLease(job.id, w2.id, 15000);
    expect(renewedByW2).toBe(false);

    // Renewal with real owner w1 succeeds
    const renewedByW1 = await claimService.renewLease(job.id, w1.id, 15000);
    expect(renewedByW1).toBe(true);
  });

  // =========================================================================
  // Test M: Stale Message Handling (Job already SUCCEEDED)
  // =========================================================================
  it('M. ACKs stale message without executing if job is already SUCCEEDED in PostgreSQL', async () => {
    const job = await createTestJob({
      status: JobStatus.SUCCEEDED,
      payload: {},
    });

    const worker = createWorker();
    await worker.start();

    const msgId = await publishJob(job.id, 'SYSTEM_NOOP');
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Zero attempts created
    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: job.id } });
    expect(attempts.length).toBe(0);

    // Message ACKed
    const pending = (await redis.xpending(testStreamKey, testGroup, '-', '+', 10)) as any[];
    const entry = pending.find((p) => p[0] === msgId);
    expect(entry).toBeUndefined();
  });

  // =========================================================================
  // Test N: Handler Failure Handling
  // =========================================================================
  it('N. records FAILED status on Job and JobAttempt when executor throws error, and ACKs stream message', async () => {
    const customRegistry = new JobExecutorRegistry();
    customRegistry.register('FAULTY_JOB', async () => {
      throw new Error('Simulated intentional handler failure');
    });

    const worker = createWorker({}, customRegistry);
    await worker.start();

    const job = await createTestJob({ type: 'FAULTY_JOB' });
    const msgId = await publishJob(job.id, 'FAULTY_JOB');

    await new Promise((resolve) => setTimeout(resolve, 500));

    const failedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(failedJob.status).toBe(JobStatus.FAILED);
    expect(failedJob.leaseExpiresAt).toBeNull();
    expect(failedJob.claimedByWorkerId).toBeNull();

    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: job.id } });
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe(JobAttemptStatus.FAILED);
    expect(attempts[0].errorMessage).toContain('Simulated intentional handler failure');
    expect(attempts[0].finishedAt).toBeInstanceOf(Date);

    // Stream message ACKed
    const pending = (await redis.xpending(testStreamKey, testGroup, '-', '+', 10)) as any[];
    const entry = pending.find((p) => p[0] === msgId);
    expect(entry).toBeUndefined();
  });

  // =========================================================================
  // Test O: Malformed Stream Message
  // =========================================================================
  it('O. ACKs malformed stream message with missing or invalid jobId without crashing', async () => {
    const worker = createWorker();
    await worker.start();

    // 1. Missing jobId
    const msg1 = await redis.xadd(testStreamKey, '*', 'foo', 'bar');
    // 2. Invalid UUID format
    const msg2 = await redis.xadd(testStreamKey, '*', 'jobId', 'not-a-valid-uuid');

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(worker.getIsRunning()).toBe(true);

    // Both should be ACKed
    const pending = (await redis.xpending(testStreamKey, testGroup, '-', '+', 10)) as any[];
    expect(pending.find((p) => p[0] === msg1)).toBeUndefined();
    expect(pending.find((p) => p[0] === msg2)).toBeUndefined();
  });

  // =========================================================================
  // Test P: Missing Job in PostgreSQL
  // =========================================================================
  it('P. ACKs message referencing non-existent jobId in PostgreSQL without crashing', async () => {
    const worker = createWorker();
    await worker.start();

    const fakeJobId = '00000000-0000-0000-0000-000000000000';
    const msgId = await publishJob(fakeJobId, 'SYSTEM_NOOP');

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(worker.getIsRunning()).toBe(true);

    const pending = (await redis.xpending(testStreamKey, testGroup, '-', '+', 10)) as any[];
    expect(pending.find((p) => p[0] === msgId)).toBeUndefined();
  });

  // =========================================================================
  // Test Q: Crash Simulation (PEL Verification)
  // =========================================================================
  it('Q. simulates crash before ACK: message remains in Redis PEL and Job in RUNNING state with expiring lease', async () => {
    const job = await createTestJob({
      type: 'SYSTEM_DELAY',
      payload: { delayMs: 5000 },
    });

    const worker = createWorker({
      jobLeaseDurationMs: 400,
      jobLeaseRenewIntervalMs: 300,
      workerShutdownTimeoutMs: 50, // Force abort active jobs quickly
    });

    await worker.start();
    const msgId = await publishJob(job.id, 'SYSTEM_DELAY');

    // Wait until job is claimed and running (before renewal interval of 300ms)
    await new Promise((resolve) => setTimeout(resolve, 150));

    const claimedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(claimedJob.status).toBe(JobStatus.RUNNING);

    // Simulate sudden crash by stopping worker abruptly without waiting for job completion
    await worker.stop();

    // Verify Redis PEL still holds the message (unacked because of crash)
    const pending = (await redis.xpending(testStreamKey, testGroup, '-', '+', 10)) as any[];
    const entry = pending.find((p) => p[0] === msgId);
    expect(entry).toBeDefined();

    // Wait for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 400));

    const expiredJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(expiredJob.status).toBe(JobStatus.RUNNING);
    expect(expiredJob.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
    // Job remains in RUNNING with expired lease, ready for future crash recovery
  });

  // =========================================================================
  // Test R: Graceful Drain
  // =========================================================================
  it('R. transitions to DRAINING, allows in-flight jobs to complete, and updates status to OFFLINE', async () => {
    const worker = createWorker({
      workerShutdownTimeoutMs: 3000,
    });

    const job = await createTestJob({
      type: 'SYSTEM_DELAY',
      payload: { delayMs: 300 },
    });

    await worker.start();
    await publishJob(job.id, 'SYSTEM_DELAY');

    // Wait for job to be picked up and active
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(worker.getActiveJobCount()).toBe(1);

    // Trigger graceful stop
    const stopPromise = worker.stop();

    expect(worker.getIsDraining()).toBe(true);

    await stopPromise;

    expect(worker.getIsRunning()).toBe(false);
    expect(worker.getActiveJobCount()).toBe(0);

    // Job completed successfully
    const finalJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(finalJob.status).toBe(JobStatus.SUCCEEDED);

    // Worker status is OFFLINE
    const workerRow = await prisma.worker.findUniqueOrThrow({ where: { id: worker.getWorkerDbId() } });
    expect(workerRow.status).toBe(WorkerStatus.OFFLINE);
    expect(workerRow.stoppedAt).toBeInstanceOf(Date);
  });

  // =========================================================================
  // Test S: Crash Between Claim and Run (Proves CLAIMED is a meaningful state)
  // =========================================================================
  it('S. crash between claim and run: Job remains CLAIMED with lease until future recovery, and Redis entry remains in PEL', async () => {
    const job = await createTestJob({ type: 'SYSTEM_NOOP' });
    const claimService = new JobClaimService(prisma);

    const workerRow = await prisma.worker.create({
      data: {
        workerKey: `crash-between-${runId}`,
        status: WorkerStatus.ONLINE,
      },
    });

    // Ensure consumer group exists
    await redis.xgroup('CREATE', testStreamKey, testGroup, '$', 'MKSTREAM').catch(() => {});

    const msgId = await publishJob(job.id, 'SYSTEM_NOOP');

    // 1. Read message with XREADGROUP to place it into consumer PEL
    await redis.xreadgroup('GROUP', testGroup, 'c-crash', 'COUNT', 1, 'STREAMS', testStreamKey, '>');

    // 2. Simulate worker atomically claiming the job in PostgreSQL
    const claim = await claimService.atomicClaimJob(job.id, workerRow.id, 300);
    expect(claim.claimed).toBe(true);

    // Simulate sudden crash immediately BEFORE transitionToRunning or handler invocation:
    // Process terminates without calling transitionToRunning, without handler, without XACK

    // 3. Verify Job remains CLAIMED in PostgreSQL
    const postCrashJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(postCrashJob.status).toBe(JobStatus.CLAIMED);
    expect(postCrashJob.claimedByWorkerId).toBe(workerRow.id);
    expect(postCrashJob.attemptCount).toBe(1);
    expect(postCrashJob.leaseExpiresAt).not.toBeNull();

    // 4. Exactly one STARTED JobAttempt exists
    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: job.id } });
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe(JobAttemptStatus.STARTED);
    expect(attempts[0].attemptNumber).toBe(1);
    expect(attempts[0].finishedAt).toBeNull();

    // 5. Verify entry remains unacknowledged in Redis PEL
    const pending = (await redis.xpending(testStreamKey, testGroup, '-', '+', 10)) as any[];
    expect(pending.find((p) => p[0] === msgId)).toBeDefined();

    // 4. Wait for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 350));

    const expiredJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(expiredJob.status).toBe(JobStatus.CLAIMED);
    expect(expiredJob.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());

    // 5. Verify that another worker CANNOT reclaim this expired CLAIMED job (no recovery in Day 7)
    const worker2 = await prisma.worker.create({
      data: {
        workerKey: `crash-reclaim-check-${runId}`,
        status: WorkerStatus.ONLINE,
      },
    });
    const secondClaim = await claimService.atomicClaimJob(job.id, worker2.id, 15000);
    expect(secondClaim.claimed).toBe(false);

    const untouchedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(untouchedJob.status).toBe(JobStatus.CLAIMED);
    expect(untouchedJob.claimedByWorkerId).toBe(workerRow.id);
    expect(untouchedJob.attemptCount).toBe(1);
  });

  // =========================================================================
  // Test T: Expired CLAIMED Cannot Be Claimed by Another Worker (No Day 7 Recovery)
  // =========================================================================
  it('T. rejects claim on expired CLAIMED job: atomicClaimJob returns false, Job remains CLAIMED and unchanged', async () => {
    const claimService = new JobClaimService(prisma);

    const w1 = await prisma.worker.create({
      data: { workerKey: `w1-t-${runId}`, status: WorkerStatus.ONLINE },
    });
    const w2 = await prisma.worker.create({
      data: { workerKey: `w2-t-${runId}`, status: WorkerStatus.ONLINE },
    });

    const job = await createTestJob({
      status: JobStatus.CLAIMED,
      claimedByWorkerId: w1.id,
      leaseExpiresAt: new Date(Date.now() - 5000), // expired 5 seconds ago
      attemptCount: 1,
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: w1.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
      },
    });

    // Attempt claim by w2
    const claim = await claimService.atomicClaimJob(job.id, w2.id, 15000);
    expect(claim.claimed).toBe(false);

    // Verify Job remains intact and unchanged
    const afterJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterJob.status).toBe(JobStatus.CLAIMED);
    expect(afterJob.claimedByWorkerId).toBe(w1.id);
    expect(afterJob.attemptCount).toBe(1);

    // No new JobAttempt created
    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: job.id } });
    expect(attempts.length).toBe(1);
  });

  // =========================================================================
  // Test U: Expired RUNNING Cannot Be Claimed by Another Worker (No Day 7 Recovery)
  // =========================================================================
  it('U. rejects claim on expired RUNNING job: atomicClaimJob returns false, Job remains RUNNING and unchanged', async () => {
    const claimService = new JobClaimService(prisma);

    const w1 = await prisma.worker.create({
      data: { workerKey: `w1-u-${runId}`, status: WorkerStatus.ONLINE },
    });
    const w2 = await prisma.worker.create({
      data: { workerKey: `w2-u-${runId}`, status: WorkerStatus.ONLINE },
    });

    const job = await createTestJob({
      status: JobStatus.RUNNING,
      claimedByWorkerId: w1.id,
      leaseExpiresAt: new Date(Date.now() - 5000), // expired 5 seconds ago
      attemptCount: 1,
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        workerId: w1.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
      },
    });

    // Attempt claim by w2
    const claim = await claimService.atomicClaimJob(job.id, w2.id, 15000);
    expect(claim.claimed).toBe(false);

    // Verify Job remains intact and unchanged
    const afterJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterJob.status).toBe(JobStatus.RUNNING);
    expect(afterJob.claimedByWorkerId).toBe(w1.id);
    expect(afterJob.attemptCount).toBe(1);

    // No new JobAttempt created
    const attempts = await prisma.jobAttempt.findMany({ where: { jobId: job.id } });
    expect(attempts.length).toBe(1);
  });

  // =========================================================================
  // Test V: Expired CLAIMED Cannot Transition to RUNNING
  // =========================================================================
  it('V. rejects transitionToRunning when lease has expired: returns false, Job remains CLAIMED', async () => {
    const claimService = new JobClaimService(prisma);

    const w1 = await prisma.worker.create({
      data: { workerKey: `w1-v-${runId}`, status: WorkerStatus.ONLINE },
    });

    const job = await createTestJob({
      status: JobStatus.CLAIMED,
      claimedByWorkerId: w1.id,
      leaseExpiresAt: new Date(Date.now() - 2000), // expired 2 seconds ago
    });

    const transitioned = await claimService.transitionToRunning(job.id, w1.id);
    expect(transitioned).toBe(false);

    const afterJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterJob.status).toBe(JobStatus.CLAIMED);
  });

  // =========================================================================
  // Test W: Expired Lease Cannot Be Renewed
  // =========================================================================
  it('W. rejects lease renewal when lease has expired: returns false, lease is NOT extended', async () => {
    const claimService = new JobClaimService(prisma);

    const w1 = await prisma.worker.create({
      data: { workerKey: `w1-w-${runId}`, status: WorkerStatus.ONLINE },
    });

    const expiredDate = new Date(Date.now() - 3000);
    const job = await createTestJob({
      status: JobStatus.RUNNING,
      claimedByWorkerId: w1.id,
      leaseExpiresAt: expiredDate,
    });

    const renewed = await claimService.renewLease(job.id, w1.id, 15000);
    expect(renewed).toBe(false);

    const afterJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterJob.leaseExpiresAt!.getTime()).toBe(expiredDate.getTime());
  });

  // =========================================================================
  // Test X: Expired Lease Cannot Finalize SUCCEEDED or FAILED
  // =========================================================================
  it('X. rejects markJobSucceeded and markJobFailed when lease has expired: returns false, Job remains RUNNING', async () => {
    const claimService = new JobClaimService(prisma);

    const w1 = await prisma.worker.create({
      data: { workerKey: `w1-x-${runId}`, status: WorkerStatus.ONLINE },
    });

    // 1. Success rejection with expired lease
    const jobSuccess = await createTestJob({
      status: JobStatus.RUNNING,
      claimedByWorkerId: w1.id,
      leaseExpiresAt: new Date(Date.now() - 3000),
    });

    const attemptSuccess = await prisma.jobAttempt.create({
      data: {
        jobId: jobSuccess.id,
        workerId: w1.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
      },
    });

    const markedSuccess = await claimService.markJobSucceeded(
      jobSuccess.id,
      attemptSuccess.id,
      w1.id,
      100,
    );
    expect(markedSuccess).toBe(false);

    const afterSuccess = await prisma.job.findUniqueOrThrow({ where: { id: jobSuccess.id } });
    expect(afterSuccess.status).toBe(JobStatus.RUNNING);
    expect(afterSuccess.claimedByWorkerId).toBe(w1.id);

    const afterAttemptSuccess = await prisma.jobAttempt.findUniqueOrThrow({
      where: { id: attemptSuccess.id },
    });
    expect(afterAttemptSuccess.status).toBe(JobAttemptStatus.STARTED);

    // 2. Failure rejection with expired lease
    const jobFail = await createTestJob({
      status: JobStatus.RUNNING,
      claimedByWorkerId: w1.id,
      leaseExpiresAt: new Date(Date.now() - 3000),
    });

    const attemptFail = await prisma.jobAttempt.create({
      data: {
        jobId: jobFail.id,
        workerId: w1.id,
        attemptNumber: 1,
        status: JobAttemptStatus.STARTED,
      },
    });

    const markedFail = await claimService.markJobFailed(
      jobFail.id,
      attemptFail.id,
      w1.id,
      100,
      new Error('test failure'),
    );
    expect(markedFail).toBe(false);

    const afterFail = await prisma.job.findUniqueOrThrow({ where: { id: jobFail.id } });
    expect(afterFail.status).toBe(JobStatus.RUNNING);
    expect(afterFail.claimedByWorkerId).toBe(w1.id);

    const afterAttemptFail = await prisma.jobAttempt.findUniqueOrThrow({
      where: { id: attemptFail.id },
    });
    expect(afterAttemptFail.status).toBe(JobAttemptStatus.STARTED);
  });

  // =========================================================================
  // Test Y: Normal RETRY_WAITING Claim Regression
  // =========================================================================
  it('Y. claims due RETRY_WAITING job: status -> CLAIMED -> RUNNING, and rejects future RETRY_WAITING job', async () => {
    const claimService = new JobClaimService(prisma);

    const w1 = await prisma.worker.create({
      data: { workerKey: `w1-y-${runId}`, status: WorkerStatus.ONLINE },
    });

    // 1. Due RETRY_WAITING job (nextRunAt in the past)
    const dueJob = await createTestJob({
      status: JobStatus.RETRY_WAITING,
      nextRunAt: new Date(Date.now() - 5000),
      attemptCount: 1,
    });

    const dueClaim = await claimService.atomicClaimJob(dueJob.id, w1.id, 15000);
    expect(dueClaim.claimed).toBe(true);
    expect(dueClaim.attemptNumber).toBe(2);

    const claimedDueJob = await prisma.job.findUniqueOrThrow({ where: { id: dueJob.id } });
    expect(claimedDueJob.status).toBe(JobStatus.CLAIMED);
    expect(claimedDueJob.claimedByWorkerId).toBe(w1.id);
    expect(claimedDueJob.attemptCount).toBe(2);

    // Transition to RUNNING succeeds
    const movedToRunning = await claimService.transitionToRunning(dueJob.id, w1.id);
    expect(movedToRunning).toBe(true);

    const runningDueJob = await prisma.job.findUniqueOrThrow({ where: { id: dueJob.id } });
    expect(runningDueJob.status).toBe(JobStatus.RUNNING);

    // 2. Future RETRY_WAITING job (nextRunAt in the future)
    const futureJob = await createTestJob({
      status: JobStatus.RETRY_WAITING,
      nextRunAt: new Date(Date.now() + 60000),
      attemptCount: 1,
    });

    const futureClaim = await claimService.atomicClaimJob(futureJob.id, w1.id, 15000);
    expect(futureClaim.claimed).toBe(false);

    const untouchedFutureJob = await prisma.job.findUniqueOrThrow({ where: { id: futureJob.id } });
    expect(untouchedFutureJob.status).toBe(JobStatus.RETRY_WAITING);
    expect(untouchedFutureJob.attemptCount).toBe(1);
  });
});
