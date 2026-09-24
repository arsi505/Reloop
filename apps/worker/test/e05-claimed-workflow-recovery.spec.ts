import * as dotenv from 'dotenv';
import * as path from 'path';
import Redis from 'ioredis';
import {
  PrismaClient,
  JobStatus,
  JobAttemptStatus,
  WorkflowStatus,
  WorkflowStepStatus,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
  WorkerStatus,
} from '@prisma/client';
import { loadWorkerConfig } from '../src/config';
import { JobClaimService } from '../src/job-claim';
import { WorkerService } from '../src/worker-service';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

describe('Audit Remediation E-05: Recovered CLAIMED Workflow Job Metadata Preservation', () => {
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
    testStreamKey = `reloop:test:e05:${runId}:jobs:ready`;
    testGroup = `test-e05-group-${runId}`;

    const org = await prisma.organization.create({
      data: {
        name: `E05 Test Org ${runId}`,
        slug: `e05-org-${runId}`,
      },
    });
    testOrgId = org.id;

    await redis.xgroup('CREATE', testStreamKey, testGroup, '$', 'MKSTREAM');
  });

  afterEach(async () => {
    while (activeWorkers.length > 0) {
      const worker = activeWorkers.pop();
      if (worker && worker.getIsRunning()) {
        await worker.stop().catch(() => {});
      }
    }

    const keys = await redis.keys(`reloop:test:e05:${runId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

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

  async function createWorkflowAndStep(stepStatus: WorkflowStepStatus = WorkflowStepStatus.READY) {
    const recoveryCase = await prisma.recoveryCase.create({
      data: {
        organizationId: testOrgId,
        type: RecoveryCaseType.TEMPORARY_API_FAILURE,
        recoveryLevel: RecoveryLevel.AUTO_RECOVER,
        status: RecoveryCaseStatus.OPEN,
        summary: `E-05 Test Case ${runId}`,
      },
    });

    const workflow = await prisma.workflow.create({
      data: {
        organizationId: testOrgId,
        recoveryCaseId: recoveryCase.id,
        templateKey: 'SYSTEM_LINEAR',
        templateVersion: 1,
        status: WorkflowStatus.RUNNING,
      },
    });

    const step = await prisma.workflowStep.create({
      data: {
        organizationId: testOrgId,
        workflowId: workflow.id,
        key: 'STEP_A',
        name: 'Step A',
        position: 1,
        status: stepStatus,
      },
    });

    return { workflow, step };
  }

  async function createTestJob(data: Partial<Parameters<typeof prisma.job.create>[0]['data']> = {}) {
    return prisma.job.create({
      data: {
        organizationId: data.organizationId ?? testOrgId,
        type: data.type ?? 'WORKFLOW_STEP',
        payload: data.payload ?? { foo: 'bar' },
        status: data.status ?? JobStatus.QUEUED,
        priority: data.priority ?? 50,
        attemptCount: data.attemptCount ?? 0,
        maxAttempts: data.maxAttempts ?? 3,
        claimedByWorkerId: data.claimedByWorkerId,
        leaseExpiresAt: data.leaseExpiresAt,
        nextRunAt: data.nextRunAt,
        completedAt: data.completedAt,
        workflowId: data.workflowId,
        workflowStepId: data.workflowStepId,
        idempotencyKey: data.idempotencyKey ?? `idemp-${runId}-${Math.random().toString(36).substring(2, 9)}`,
      },
    });
  }

  function createWorker(overrides: Partial<Parameters<typeof loadWorkerConfig>[0]> = {}): WorkerService {
    const config = loadWorkerConfig({
      redisUrl,
      jobStreamKey: testStreamKey,
      jobConsumerGroup: testGroup,
      workerKey: `worker-e05-${runId}-${Math.random().toString(36).substring(2, 7)}`,
      workerConsumerName: `consumer-e05-${runId}-${Math.random().toString(36).substring(2, 7)}`,
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

    const worker = new WorkerService(config, prisma);
    activeWorkers.push(worker);
    return worker;
  }

  async function simulateAbandonedPelMessage(consumerName: string, jobId: string): Promise<string> {
    const msgId = (await redis.xadd(testStreamKey, '*', 'jobId', jobId, 'type', 'WORKFLOW_STEP')) as string;
    await redis.xreadgroup('GROUP', testGroup, consumerName, 'COUNT', 1, 'STREAMS', testStreamKey, '>');
    return msgId;
  }

  async function getPelCount(): Promise<number> {
    const summary = (await redis.xpending(testStreamKey, testGroup)) as any[];
    return summary ? summary[0] : 0;
  }

  // =========================================================================
  // 1. Direct JobClaimService.recoverExpiredClaimedJob preserves metadata
  // =========================================================================
  it('1. preserves workflowId and workflowStepId in recoverExpiredClaimedJob RETURNING clause', async () => {
    const deadWorker = await createTestWorkerRecord('crashed-worker-claim');
    const aliveWorker = await createTestWorkerRecord('alive-worker-claim');
    const { workflow, step } = await createWorkflowAndStep();

    const job = await createTestJob({
      organizationId: testOrgId,
      workflowId: workflow.id,
      workflowStepId: step.id,
      type: 'WORKFLOW_STEP',
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
      payload: {
        templateKey: 'SYSTEM_LINEAR',
        templateVersion: 1,
        stepKey: 'STEP_A',
        handlerKey: 'OUTPUT',
      },
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
    const recoverResult = await claimService.recoverExpiredClaimedJob(job.id, aliveWorker.id, 15000);

    expect(recoverResult.recovered).toBe(true);
    expect(recoverResult.execute).toBe(true);
    expect(recoverResult.job).toBeDefined();

    // CRITICAL: Relational metadata MUST be preserved from PostgreSQL columns
    expect(recoverResult.job?.workflowId).toBe(workflow.id);
    expect(recoverResult.job?.workflowStepId).toBe(step.id);
    expect(recoverResult.job?.organizationId).toBe(testOrgId);
    expect(recoverResult.job?.attemptCount).toBe(2);

    // Verify DB state
    const updatedJob = await prisma.job.findUnique({
      where: { id: job.id },
      include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
    });
    expect(updatedJob?.status).toBe(JobStatus.CLAIMED);
    expect(updatedJob?.claimedByWorkerId).toBe(aliveWorker.id);
    expect(updatedJob?.workflowId).toBe(workflow.id);
    expect(updatedJob?.workflowStepId).toBe(step.id);
    expect(updatedJob?.attemptCount).toBe(2);
    expect(updatedJob?.attempts.length).toBe(2);

    // Attempt 1 abandoned
    expect(updatedJob?.attempts[0].status).toBe(JobAttemptStatus.ABANDONED);
    expect(updatedJob?.attempts[0].errorCode).toBe('WORKER_LEASE_EXPIRED_BEFORE_EXECUTION');

    // Attempt 2 started
    expect(updatedJob?.attempts[1].status).toBe(JobAttemptStatus.STARTED);
    expect(updatedJob?.attempts[1].workerId).toBe(aliveWorker.id);
  });

  // =========================================================================
  // 2. End-to-end execution of recovered WORKFLOW_STEP job
  // =========================================================================
  it('2. executes recovered WORKFLOW_STEP job end-to-end, sets WorkflowStep to SUCCEEDED with durable output', async () => {
    const deadWorker = await createTestWorkerRecord('crashed-worker-e2e');
    const { workflow, step } = await createWorkflowAndStep(WorkflowStepStatus.READY);

    const job = await createTestJob({
      organizationId: testOrgId,
      workflowId: workflow.id,
      workflowStepId: step.id,
      type: 'WORKFLOW_STEP',
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
      payload: {
        templateKey: 'SYSTEM_LINEAR',
        templateVersion: 1,
        stepKey: 'STEP_A',
        handlerKey: 'OUTPUT',
        output: { recoveredAndExecuted: true, marker: 'e05-test' },
      },
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

    // Simulate abandoned PEL entry
    await simulateAbandonedPelMessage(deadWorker.workerKey, job.id);
    expect(await getPelCount()).toBe(1);

    // Allow minIdleMs to elapse
    await new Promise((r) => setTimeout(r, 70));

    // Start recovering worker
    const worker = createWorker({ workerPelMinIdleMs: 50 });
    await worker.start();

    // Trigger recovery scan
    const scanResult = await worker.getRecoveryService().scanOnce();
    expect(scanResult.recoveredClaimedCount).toBe(1);

    // Wait for execution to finalize
    let finalJob = null;
    for (let i = 0; i < 40; i++) {
      finalJob = await prisma.job.findUnique({
        where: { id: job.id },
        include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
      });
      if (finalJob?.status === JobStatus.SUCCEEDED) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(finalJob?.status).toBe(JobStatus.SUCCEEDED);
    expect(finalJob?.attemptCount).toBe(2);
    expect(finalJob?.attempts.length).toBe(2);
    expect(finalJob?.attempts[0].status).toBe(JobAttemptStatus.ABANDONED);
    expect(finalJob?.attempts[1].status).toBe(JobAttemptStatus.SUCCEEDED);

    // CRITICAL: WorkflowStep was successfully found, executed, and updated to SUCCEEDED
    const finalStep = await prisma.workflowStep.findUnique({
      where: { id: step.id },
    });
    expect(finalStep?.status).toBe(WorkflowStepStatus.SUCCEEDED);
    expect(finalStep?.completedAt).toBeDefined();
    expect(finalStep?.output).toEqual({
      completed: true,
      stepKey: 'STEP_A',
      attempt: 2,
      recoveredAndExecuted: true,
      marker: 'e05-test',
    });

    // Redis PEL was acknowledged post-commit
    expect(await getPelCount()).toBe(0);
  });

  // =========================================================================
  // 3. Ambiguous Crash Boundary: Expired RUNNING job is fenced to BLOCKED
  // =========================================================================
  it('3. enforces ambiguous crash boundary: expired RUNNING workflow job transitions to BLOCKED without re-execution', async () => {
    const deadWorker = await createTestWorkerRecord('crashed-running-worker');
    const { workflow, step } = await createWorkflowAndStep(WorkflowStepStatus.READY);

    const job = await createTestJob({
      organizationId: testOrgId,
      workflowId: workflow.id,
      workflowStepId: step.id,
      type: 'WORKFLOW_STEP',
      status: JobStatus.RUNNING,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000), // Expired in RUNNING
      payload: {
        templateKey: 'SYSTEM_LINEAR',
        templateVersion: 1,
        stepKey: 'STEP_A',
        handlerKey: 'OUTPUT',
      },
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

    await simulateAbandonedPelMessage(deadWorker.workerKey, job.id);
    expect(await getPelCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 70));

    const worker = createWorker({ workerPelMinIdleMs: 50 });
    await worker.start();

    const scanResult = await worker.getRecoveryService().scanOnce();
    expect(scanResult.blockedRunningCount).toBe(1);

    const finalJob = await prisma.job.findUnique({
      where: { id: job.id },
      include: { attempts: true },
    });

    expect(finalJob?.status).toBe(JobStatus.BLOCKED);
    expect(finalJob?.completedAt).toBeNull();
    expect(finalJob?.attemptCount).toBe(1); // NEVER incremented or re-executed
    expect(finalJob?.attempts[0].status).toBe(JobAttemptStatus.ABANDONED);
    expect(finalJob?.attempts[0].errorCode).toBe('AMBIGUOUS_WORKER_CRASH');

    // WorkflowStep was NEVER touched
    const finalStep = await prisma.workflowStep.findUnique({ where: { id: step.id } });
    expect(finalStep?.status).toBe(WorkflowStepStatus.READY);
    expect(finalStep?.completedAt).toBeNull();

    // Redis PEL was acknowledged
    expect(await getPelCount()).toBe(0);
  });

  // =========================================================================
  // 4. Non-workflow job recovery works with null relations
  // =========================================================================
  it('4. recovers non-workflow job with null workflowId and workflowStepId', async () => {
    const deadWorker = await createTestWorkerRecord('crashed-nonwf-worker');
    const aliveWorker = await createTestWorkerRecord('alive-nonwf-worker');

    const job = await createTestJob({
      organizationId: testOrgId,
      workflowId: null,
      workflowStepId: null,
      type: 'SYSTEM_NOOP',
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000),
      payload: { action: 'noop' },
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
    const recoverResult = await claimService.recoverExpiredClaimedJob(job.id, aliveWorker.id, 15000);

    expect(recoverResult.recovered).toBe(true);
    expect(recoverResult.job?.workflowId).toBeNull();
    expect(recoverResult.job?.workflowStepId).toBeNull();
    expect(recoverResult.job?.type).toBe('SYSTEM_NOOP');
    expect(recoverResult.job?.attemptCount).toBe(2);
  });

  // =========================================================================
  // 5. Concurrency Race: Exactly one recovering worker wins expired CLAIMED job
  // =========================================================================
  it('5. resolves concurrent recovery attempts with exactly one winner', async () => {
    const deadWorker = await createTestWorkerRecord('crashed-race-worker');
    const workerA = await createTestWorkerRecord('competing-worker-a');
    const workerB = await createTestWorkerRecord('competing-worker-b');
    const { workflow, step } = await createWorkflowAndStep();

    const job = await createTestJob({
      organizationId: testOrgId,
      workflowId: workflow.id,
      workflowStepId: step.id,
      type: 'WORKFLOW_STEP',
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000),
      payload: { stepKey: 'STEP_A' },
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

    const claimServiceA = new JobClaimService(prisma);
    const claimServiceB = new JobClaimService(prisma);

    const [resultA, resultB] = await Promise.all([
      claimServiceA.recoverExpiredClaimedJob(job.id, workerA.id, 15000),
      claimServiceB.recoverExpiredClaimedJob(job.id, workerB.id, 15000),
    ]);

    const winnerCount = (resultA.recovered ? 1 : 0) + (resultB.recovered ? 1 : 0);
    expect(winnerCount).toBe(1);

    const finalJob = await prisma.job.findUnique({
      where: { id: job.id },
      include: { attempts: true },
    });
    expect(finalJob?.attemptCount).toBe(2);
    expect(finalJob?.attempts.length).toBe(2);
  });

  // =========================================================================
  // 6. DB Column Authority: Tampered payload IDs do not override DB relations
  // =========================================================================
  it('6. preserves authoritative PostgreSQL relation columns regardless of payload contents', async () => {
    const deadWorker = await createTestWorkerRecord('crashed-payload-worker');
    const aliveWorker = await createTestWorkerRecord('alive-payload-worker');
    const { workflow, step } = await createWorkflowAndStep();

    const job = await createTestJob({
      organizationId: testOrgId,
      workflowId: workflow.id,
      workflowStepId: step.id,
      type: 'WORKFLOW_STEP',
      status: JobStatus.CLAIMED,
      claimedByWorkerId: deadWorker.id,
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 5000),
      payload: {
        workflowId: '00000000-0000-0000-0000-000000000001', // Tampered in payload
        workflowStepId: '00000000-0000-0000-0000-000000000002', // Tampered in payload
        templateKey: 'SYSTEM_LINEAR',
        templateVersion: 1,
        stepKey: 'STEP_A',
        handlerKey: 'NOOP',
      },
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
    const recoverResult = await claimService.recoverExpiredClaimedJob(job.id, aliveWorker.id, 15000);

    expect(recoverResult.recovered).toBe(true);
    // Returned job metadata MUST reflect DB column truth, NOT payload contents
    expect(recoverResult.job?.workflowId).toBe(workflow.id);
    expect(recoverResult.job?.workflowStepId).toBe(step.id);
    expect(recoverResult.job?.workflowId).not.toBe('00000000-0000-0000-0000-000000000001');
    expect(recoverResult.job?.workflowStepId).not.toBe('00000000-0000-0000-0000-000000000002');
  });
});
