import * as dotenv from 'dotenv';
import * as path from 'path';
import Redis from 'ioredis';
import {
  PrismaClient,
  WorkflowStatus,
  WorkflowStepStatus,
  JobStatus,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
  JobAttemptStatus,
} from '@prisma/client';
import {
  WorkflowTemplateRegistry,
  registerSystemTemplates,
  SYSTEM_RETRY_V1,
} from '@reloop/workflow-core';
import { WorkerService } from '../src/worker-service';
import { loadWorkerConfig } from '../src/config';
import { WorkflowStepExecutor } from '../src/workflow-step-executor';
import { WorkflowStepHandlerRegistry } from '../src/workflow-step-registry';
import { JobContext } from '../src/executor';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

describe('Day 10: Worker Workflow Step Execution', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let testOrgId: string;
  let runId: string;
  let streamKey: string;
  let consumerGroup: string;
  let worker: WorkerService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
    redis = new Redis(redisUrl);
  });

  afterAll(async () => {
    if (worker && worker.getIsRunning()) {
      await worker.stop();
    }
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(async () => {
    runId = Math.random().toString(36).substring(2, 9);
    streamKey = `reloop:test:wf:${runId}:jobs`;
    consumerGroup = `test-group-${runId}`;

    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.workflowStep.deleteMany({});
    await prisma.workflow.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.worker.deleteMany({});

    const org = await prisma.organization.create({
      data: {
        name: `Worker WF Org ${runId}`,
        slug: `worker-wf-org-${runId}`,
      },
    });
    testOrgId = org.id;
  });

  afterEach(async () => {
    if (worker && worker.getIsRunning()) {
      await worker.stop();
    }
  });

  async function createTestWorkflowAndStep(params: {
    status?: WorkflowStatus;
    stepStatus?: WorkflowStepStatus;
    handlerKey?: string;
    orgId?: string;
  }) {
    const orgId = params.orgId ?? testOrgId;

    const rCase = await prisma.recoveryCase.create({
      data: {
        organizationId: orgId,
        type: RecoveryCaseType.TEMPORARY_API_FAILURE,
        recoveryLevel: RecoveryLevel.AUTO_RECOVER,
        status: RecoveryCaseStatus.OPEN,
        summary: 'Test Workflow Execution',
      },
    });

    const workflow = await prisma.workflow.create({
      data: {
        organizationId: orgId,
        recoveryCaseId: rCase.id,
        templateKey: 'SYSTEM_LINEAR',
        templateVersion: 1,
        status: params.status ?? WorkflowStatus.RUNNING,
      },
    });

    const step = await prisma.workflowStep.create({
      data: {
        organizationId: orgId,
        workflowId: workflow.id,
        key: 'STEP_A',
        name: 'Step A',
        position: 1,
        status: params.stepStatus ?? WorkflowStepStatus.READY,
      },
    });

    return { workflow, step };
  }

  describe('1. Step Execution and Durable State Transitions', () => {
    it('executes WORKFLOW_STEP job, sets WorkflowStep to SUCCEEDED with durable output, and marks Job SUCCEEDED', async () => {
      const { workflow, step } = await createTestWorkflowAndStep({
        stepStatus: WorkflowStepStatus.READY,
      });

      const job = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          workflowId: workflow.id,
          workflowStepId: step.id,
          type: 'WORKFLOW_STEP',
          status: JobStatus.QUEUED,
          priority: 10,
          payload: {
            templateKey: 'SYSTEM_LINEAR',
            templateVersion: 1,
            stepKey: 'STEP_A',
            handlerKey: 'OUTPUT',
            output: { executed: true, data: 123 },
          },
          idempotencyKey: `workflow-step:${workflow.id}:STEP_A:v1`,
        },
      });

      const config = loadWorkerConfig({
        redisUrl,
        jobStreamKey: streamKey,
        jobConsumerGroup: consumerGroup,
        workerConcurrency: 1,
        jobLeaseDurationMs: 15000,
      });

      worker = new WorkerService(config, prisma);
      await worker.start();

      // Dispatch to stream
      await redis.xadd(streamKey, '*', 'jobId', job.id);

      // Wait for job to process
      let updatedJob = null;
      for (let i = 0; i < 30; i++) {
        updatedJob = await prisma.job.findUnique({ where: { id: job.id } });
        if (updatedJob?.status === JobStatus.SUCCEEDED) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(updatedJob?.status).toBe(JobStatus.SUCCEEDED);

      const updatedStep = await prisma.workflowStep.findUnique({ where: { id: step.id } });
      expect(updatedStep?.status).toBe(WorkflowStepStatus.SUCCEEDED);
      expect(updatedStep?.completedAt).toBeDefined();
      expect(updatedStep?.output).toEqual({
        completed: true,
        stepKey: 'STEP_A',
        attempt: 1,
        executed: true,
        data: 123,
      });
    });
  });

  describe('2. Tenant Safety Enforcement', () => {
    it('rejects execution when Job organization does not match Workflow or Step organization', async () => {
      // Create second organization
      const otherOrg = await prisma.organization.create({
        data: {
          name: `Other Org ${runId}`,
          slug: `other-org-${runId}`,
        },
      });

      // Workflow belongs to otherOrg
      const { workflow, step } = await createTestWorkflowAndStep({
        orgId: otherOrg.id,
      });

      const handlerRegistry = new WorkflowStepHandlerRegistry();
      const executor = new WorkflowStepExecutor(prisma, handlerRegistry);

      // Job context claims it is for testOrgId (mismatch!)
      const context: JobContext = {
        jobId: '00000000-0000-0000-0000-000000000001',
        attemptNumber: 1,
        type: 'WORKFLOW_STEP',
        payload: { handlerKey: 'NOOP' },
        workerId: '00000000-0000-0000-0000-000000000002',
        organizationId: testOrgId,
        workflowId: workflow.id,
        workflowStepId: step.id,
      };

      await expect(executor.execute(context)).rejects.toThrow(/Tenant mismatch/);
    });
  });

  describe('3. Terminal Workflow Execution Fence', () => {
    it('fences execution and does not execute handler if Workflow is already FAILED', async () => {
      const { workflow, step } = await createTestWorkflowAndStep({
        status: WorkflowStatus.FAILED,
        stepStatus: WorkflowStepStatus.READY,
      });

      let handlerExecuted = false;
      const handlerRegistry = new WorkflowStepHandlerRegistry();
      handlerRegistry.register('TRACK_EXECUTION', async () => {
        handlerExecuted = true;
        return { output: { executed: true } };
      });

      const executor = new WorkflowStepExecutor(prisma, handlerRegistry);

      const context: JobContext = {
        jobId: '00000000-0000-0000-0000-000000000001',
        attemptNumber: 1,
        type: 'WORKFLOW_STEP',
        payload: { handlerKey: 'TRACK_EXECUTION' },
        workerId: '00000000-0000-0000-0000-000000000002',
        organizationId: testOrgId,
        workflowId: workflow.id,
        workflowStepId: step.id,
      };

      const result = (await executor.execute(context)) as { fenced: boolean; workflowStatus: string };
      expect(result.fenced).toBe(true);
      expect(result.workflowStatus).toBe(WorkflowStatus.FAILED);
      expect(handlerExecuted).toBe(false);

      // Step must NOT be SUCCEEDED
      const stepAfter = await prisma.workflowStep.findUnique({ where: { id: step.id } });
      expect(stepAfter?.status).toBe(WorkflowStepStatus.READY);
    });
  });

  describe('4. Retry in Workflow (SYSTEM_RETRY_V1)', () => {
    it('step stays RUNNING on retryable failure, re-executes on SAME Job and SAME WorkflowStep, and succeeds on attempt 2', async () => {
      const { workflow, step } = await createTestWorkflowAndStep({
        stepStatus: WorkflowStepStatus.READY,
      });

      const job = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          workflowId: workflow.id,
          workflowStepId: step.id,
          type: 'WORKFLOW_STEP',
          status: JobStatus.QUEUED,
          priority: 10,
          maxAttempts: 3,
          payload: {
            templateKey: 'SYSTEM_RETRY',
            templateVersion: 1,
            stepKey: 'STEP_A',
            handlerKey: 'FAIL_TRANSIENT_ONCE',
          },
          idempotencyKey: `workflow-step:${workflow.id}:STEP_A:v1`,
        },
      });

      const config = loadWorkerConfig({
        redisUrl,
        jobStreamKey: streamKey,
        jobConsumerGroup: consumerGroup,
        workerConcurrency: 1,
        jobLeaseDurationMs: 15000,
        jobRetryDelaysMs: [100, 200, 400],
      });

      worker = new WorkerService(config, prisma);
      await worker.start();

      // Dispatch Attempt 1
      await redis.xadd(streamKey, '*', 'jobId', job.id);

      // Wait for Job to enter RETRY_WAITING
      let jobAfterAttempt1 = null;
      for (let i = 0; i < 30; i++) {
        jobAfterAttempt1 = await prisma.job.findUnique({ where: { id: job.id } });
        if (jobAfterAttempt1?.status === JobStatus.RETRY_WAITING) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(jobAfterAttempt1?.status).toBe(JobStatus.RETRY_WAITING);
      expect(jobAfterAttempt1?.attemptCount).toBe(1);

      // Rule 24: WorkflowStep remains RUNNING (not marked FAILED!)
      const stepAfterAttempt1 = await prisma.workflowStep.findUnique({ where: { id: step.id } });
      expect(stepAfterAttempt1?.status).toBe(WorkflowStepStatus.RUNNING);

      // Verify JobAttempt #1 recorded FAILED
      const attempts = await prisma.jobAttempt.findMany({
        where: { jobId: job.id },
        orderBy: { attemptNumber: 'asc' },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe(JobAttemptStatus.FAILED);

      // Fast-forward nextRunAt for retry dispatch
      await prisma.job.update({
        where: { id: job.id },
        data: { nextRunAt: new Date(Date.now() - 1000) },
      });

      // Dispatch Attempt 2 (simulating Scheduler redispatch of the SAME job)
      await redis.xadd(streamKey, '*', 'jobId', job.id);

      // Wait for Job to reach SUCCEEDED on attempt 2
      let jobAfterAttempt2 = null;
      for (let i = 0; i < 30; i++) {
        jobAfterAttempt2 = await prisma.job.findUnique({ where: { id: job.id } });
        if (jobAfterAttempt2?.status === JobStatus.SUCCEEDED) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(jobAfterAttempt2?.status).toBe(JobStatus.SUCCEEDED);
      expect(jobAfterAttempt2?.attemptCount).toBe(2);

      // WorkflowStep now SUCCEEDED!
      const stepAfterAttempt2 = await prisma.workflowStep.findUnique({ where: { id: step.id } });
      expect(stepAfterAttempt2?.status).toBe(WorkflowStepStatus.SUCCEEDED);
      expect(stepAfterAttempt2?.output).toEqual({
        success: true,
        resolvedOnAttempt: 2,
        stepKey: 'STEP_A',
      });

      // Exactly ONE Job and ONE WorkflowStep exist (no duplicate created!)
      const allJobs = await prisma.job.findMany({ where: { workflowId: workflow.id } });
      expect(allJobs).toHaveLength(1);

      const allSteps = await prisma.workflowStep.findMany({ where: { workflowId: workflow.id } });
      expect(allSteps).toHaveLength(1);

      // Two JobAttempts exist on that same Job
      const allAttempts = await prisma.jobAttempt.findMany({
        where: { jobId: job.id },
        orderBy: { attemptNumber: 'asc' },
      });
      expect(allAttempts).toHaveLength(2);
      expect(allAttempts[0].attemptNumber).toBe(1);
      expect(allAttempts[0].status).toBe(JobAttemptStatus.FAILED);
      expect(allAttempts[1].attemptNumber).toBe(2);
      expect(allAttempts[1].status).toBe(JobAttemptStatus.SUCCEEDED);
    });
  });

  describe('5. Step Start Fence & State Validation', () => {
    it('rejects execution when WorkflowStep is in forbidden statuses (PENDING, SKIPPED, SUCCEEDED, FAILED, BLOCKED)', async () => {
      const forbiddenStatuses: WorkflowStepStatus[] = [
        WorkflowStepStatus.PENDING,
        WorkflowStepStatus.SKIPPED,
        WorkflowStepStatus.SUCCEEDED,
        WorkflowStepStatus.FAILED,
        WorkflowStepStatus.BLOCKED,
      ];

      const handlerRegistry = new WorkflowStepHandlerRegistry();
      const executor = new WorkflowStepExecutor(prisma, handlerRegistry);

      for (const status of forbiddenStatuses) {
        const { workflow, step } = await createTestWorkflowAndStep({
          status: WorkflowStatus.RUNNING,
          stepStatus: status,
        });

        const context: JobContext = {
          jobId: '00000000-0000-0000-0000-000000000001',
          attemptNumber: 1,
          type: 'WORKFLOW_STEP',
          payload: { handlerKey: 'NOOP' },
          workerId: '00000000-0000-0000-0000-000000000002',
          organizationId: testOrgId,
          workflowId: workflow.id,
          workflowStepId: step.id,
        };

        await expect(executor.execute(context)).rejects.toThrow(
          new RegExp(`Step execution fenced: WorkflowStep .* has invalid status "${status}"`),
        );
      }
    });

    it('successfully executes and transitions WorkflowStep from READY to RUNNING via CAS', async () => {
      const { workflow, step } = await createTestWorkflowAndStep({
        status: WorkflowStatus.RUNNING,
        stepStatus: WorkflowStepStatus.READY,
      });

      const handlerRegistry = new WorkflowStepHandlerRegistry();
      const executor = new WorkflowStepExecutor(prisma, handlerRegistry);

      const context: JobContext = {
        jobId: '00000000-0000-0000-0000-000000000001',
        attemptNumber: 1,
        type: 'WORKFLOW_STEP',
        payload: { handlerKey: 'NOOP' },
        workerId: '00000000-0000-0000-0000-000000000002',
        organizationId: testOrgId,
        workflowId: workflow.id,
        workflowStepId: step.id,
      };

      const result = await executor.execute(context);
      expect(result).toBeDefined();

      // Step was transitioned to RUNNING by the executor
      const stepAfter = await prisma.workflowStep.findUnique({ where: { id: step.id } });
      expect(stepAfter?.status).toBe(WorkflowStepStatus.RUNNING);
      expect(stepAfter?.startedAt).toBeDefined();
    });
  });

  describe('6. Lease Safety & Durability Invariants', () => {
    it('lost lease or expired ownership prevents marking WorkflowStep as SUCCEEDED', async () => {
      const { workflow, step } = await createTestWorkflowAndStep({
        stepStatus: WorkflowStepStatus.READY,
      });

      const config = loadWorkerConfig({
        redisUrl,
        jobStreamKey: streamKey,
        jobConsumerGroup: consumerGroup,
        workerConcurrency: 1,
        jobLeaseDurationMs: 15000,
      });

      worker = new WorkerService(config, prisma);
      await worker.start();

      // Create a job claimed by worker with an already-expired lease
      const workerRow = await prisma.worker.findUnique({ where: { workerKey: config.workerKey } });
      expect(workerRow).toBeDefined();

      const job = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          workflowId: workflow.id,
          workflowStepId: step.id,
          type: 'WORKFLOW_STEP',
          status: JobStatus.CLAIMED,
          claimedByWorkerId: workerRow!.id,
          leaseExpiresAt: new Date(Date.now() - 5000), // Expired 5s ago!
          priority: 10,
          payload: {
            templateKey: 'SYSTEM_LINEAR',
            templateVersion: 1,
            stepKey: 'STEP_A',
            handlerKey: 'OUTPUT',
            output: { finished: true },
          },
          idempotencyKey: `workflow-step:${workflow.id}:STEP_A:v1`,
        },
      });

      const attempt = await prisma.jobAttempt.create({
        data: {
          jobId: job.id,
          workerId: workerRow!.id,
          attemptNumber: 1,
          status: JobAttemptStatus.STARTED,
        },
      });

      // Attempt to execute the claimed job directly
      await worker.executeClaimedJob(
        {
          id: job.id,
          organizationId: testOrgId,
          workflowId: workflow.id,
          workflowStepId: step.id,
          type: 'WORKFLOW_STEP',
          payload: job.payload,
          attemptCount: 1,
          maxAttempts: 3,
        },
        attempt.id,
        1,
        '1000-0',
      );

      // WorkflowStep must NOT be marked SUCCEEDED because lease was lost/expired!
      const stepAfter = await prisma.workflowStep.findUnique({ where: { id: step.id } });
      expect(stepAfter?.status).not.toBe(WorkflowStepStatus.SUCCEEDED);

      // Job must not be marked SUCCEEDED
      const jobAfter = await prisma.job.findUnique({ where: { id: job.id } });
      expect(jobAfter?.status).not.toBe(JobStatus.SUCCEEDED);
    });
  });
});
