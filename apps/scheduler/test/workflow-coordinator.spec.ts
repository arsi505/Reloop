import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  PrismaClient,
  WorkflowStatus,
  WorkflowStepStatus,
  JobStatus,
  ApprovalStatus,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
} from '@prisma/client';
import {
  WorkflowTemplateRegistry,
  registerSystemTemplates,
  SYSTEM_LINEAR_V1,
  SYSTEM_PARALLEL_JOIN_V1,
  SYSTEM_CONDITIONAL_V1,
  SYSTEM_RETRY_V1,
  SYSTEM_APPROVAL_V1,
} from '@reloop/workflow-core';
import { WorkflowCoordinator } from '../src/workflow-coordinator';
import { WorkflowCreationService } from '../src/workflow-creator';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';

describe('Day 10: Workflow Coordination Engine', () => {
  let prisma: PrismaClient;
  let templateRegistry: WorkflowTemplateRegistry;
  let coordinator: WorkflowCoordinator;
  let creationService: WorkflowCreationService;
  let testOrgId: string;
  let runId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();

    templateRegistry = new WorkflowTemplateRegistry();
    registerSystemTemplates(templateRegistry);
  });

  afterAll(async () => {
    if (coordinator && coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    await prisma.$disconnect().catch(() => {});
  });

  let testRecoveryCaseId: string;

  async function createWorkflow(overrides: Partial<Parameters<WorkflowCreationService['createWorkflowInstance']>[0]> = {}) {
    return creationService.createWorkflowInstance({
      organizationId: testOrgId,
      templateKey: 'SYSTEM_LINEAR',
      templateVersion: 1,
      recoveryCaseId: testRecoveryCaseId,
      ...overrides,
    });
  }

  beforeEach(async () => {
    runId = Math.random().toString(36).substring(2, 9);

    // Clean tables in dependency order
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.workflowStep.deleteMany({});
    await prisma.workflow.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});

    const org = await prisma.organization.create({
      data: {
        name: `Workflow Test Org ${runId}`,
        slug: `wf-test-org-${runId}`,
      },
    });
    testOrgId = org.id;

    const rCase = await prisma.recoveryCase.create({
      data: {
        organizationId: testOrgId,
        type: RecoveryCaseType.TEMPORARY_API_FAILURE,
        recoveryLevel: RecoveryLevel.AUTO_RECOVER,
        status: RecoveryCaseStatus.OPEN,
        summary: `Workflow Test Case ${runId}`,
      },
    });
    testRecoveryCaseId = rCase.id;

    coordinator = new WorkflowCoordinator(prisma, templateRegistry, {
      workflowScanIntervalMs: 1000,
      workflowScanBatchSize: 20,
    });
    creationService = new WorkflowCreationService(prisma, templateRegistry);
  });

  afterEach(async () => {
    if (coordinator && coordinator.getIsRunning()) {
      await coordinator.stop();
    }
  });

  describe('1. Transactional Workflow Creation & Idempotency', () => {
    it('transactionally creates Workflow and all WorkflowStep rows in PENDING status', async () => {
      const instance = await createWorkflow();

      expect(instance.id).toBeDefined();
      expect(instance.status).toBe(WorkflowStatus.PENDING);
      expect(instance.steps).toHaveLength(3);

      const dbSteps = await prisma.workflowStep.findMany({
        where: { workflowId: instance.id },
        orderBy: { position: 'asc' },
      });

      expect(dbSteps).toHaveLength(3);
      expect(dbSteps[0].key).toBe('STEP_A');
      expect(dbSteps[0].status).toBe(WorkflowStepStatus.PENDING);
      expect(dbSteps[1].key).toBe('STEP_B');
      expect(dbSteps[1].status).toBe(WorkflowStepStatus.PENDING);
      expect(dbSteps[2].key).toBe('STEP_C');
      expect(dbSteps[2].status).toBe(WorkflowStepStatus.PENDING);
    });

    it('caller-supplied workflowId ensures idempotent workflow creation without duplicates', async () => {
      const stableId = '11111111-2222-3333-4444-555555555555';

      const first = await createWorkflow({ workflowId: stableId });
      const second = await createWorkflow({ workflowId: stableId });

      expect(first.id).toBe(stableId);
      expect(second.id).toBe(stableId);

      const allWfs = await prisma.workflow.findMany({ where: { id: stableId } });
      expect(allWfs).toHaveLength(1);

      const allSteps = await prisma.workflowStep.findMany({ where: { workflowId: stableId } });
      expect(allSteps).toHaveLength(3);
    });

    it('strictly requires recoveryCaseId and rejects missing or non-existent cases', async () => {
      await expect(
        creationService.createWorkflowInstance({
          organizationId: testOrgId,
          templateKey: 'SYSTEM_LINEAR',
          templateVersion: 1,
          recoveryCaseId: '' as any,
        }),
      ).rejects.toThrow('recoveryCaseId is required to create a workflow.');

      const nonExistentId = '00000000-0000-0000-0000-000000000099';
      await expect(
        creationService.createWorkflowInstance({
          organizationId: testOrgId,
          templateKey: 'SYSTEM_LINEAR',
          templateVersion: 1,
          recoveryCaseId: nonExistentId,
        }),
      ).rejects.toThrow(`RecoveryCase "${nonExistentId}" does not exist.`);
    });

    it('rejects cross-tenant recoveryCaseId belonging to another organization', async () => {
      const otherOrg = await prisma.organization.create({
        data: {
          name: `Other Org ${runId}`,
          slug: `other-org-${runId}`,
        },
      });

      const otherCase = await prisma.recoveryCase.create({
        data: {
          organizationId: otherOrg.id,
          type: RecoveryCaseType.TEMPORARY_API_FAILURE,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          status: RecoveryCaseStatus.OPEN,
          summary: 'Other Org Case',
        },
      });

      await expect(
        creationService.createWorkflowInstance({
          organizationId: testOrgId,
          templateKey: 'SYSTEM_LINEAR',
          templateVersion: 1,
          recoveryCaseId: otherCase.id,
        }),
      ).rejects.toThrow(/Tenant mismatch/);
    });

    it('rejects workflowId reuse when caller supplies conflicting parameters', async () => {
      const stableId = '22222222-3333-4444-5555-666666666666';

      await createWorkflow({
        workflowId: stableId,
        templateKey: 'SYSTEM_LINEAR',
        templateVersion: 1,
      });

      // Attempting to reuse the same workflowId with different templateKey
      await expect(
        createWorkflow({
          workflowId: stableId,
          templateKey: 'SYSTEM_PARALLEL_JOIN',
          templateVersion: 1,
        }),
      ).rejects.toThrow(/Conflict: workflow .* already exists with different parameters/);
    });
  });

  describe('2. Linear DAG Progression (A -> B -> C)', () => {
    it('readies STEP_A, waits for completion before B, and transitions workflow to SUCCEEDED', async () => {
      const instance = await createWorkflow();

      // Tick 1: Root STEP_A becomes READY and creates durable Job
      const tick1 = await coordinator.tick();
      expect(tick1.scanned).toBe(1);
      expect(tick1.readiedSteps).toBe(1);
      expect(tick1.createdJobs).toBe(1);

      // Workflow transitions PENDING -> RUNNING
      const wf1 = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(wf1?.status).toBe(WorkflowStatus.RUNNING);
      expect(wf1?.startedAt).toBeDefined();

      const stepA = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_A' } },
      });
      expect(stepA?.status).toBe(WorkflowStepStatus.READY);

      const jobsA = await prisma.job.findMany({
        where: { workflowStepId: stepA?.id },
      });
      expect(jobsA).toHaveLength(1);
      expect(jobsA[0].type).toBe('WORKFLOW_STEP');
      expect(jobsA[0].status).toBe(JobStatus.QUEUED);
      expect(jobsA[0].idempotencyKey).toBe(`workflow-step:${instance.id}:STEP_A:v1`);

      // Steps B and C are still PENDING
      const stepB_before = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_B' } },
      });
      expect(stepB_before?.status).toBe(WorkflowStepStatus.PENDING);

      // Simulate Worker completing STEP_A
      await prisma.job.update({
        where: { id: jobsA[0].id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });
      await prisma.workflowStep.update({
        where: { id: stepA!.id },
        data: {
          status: WorkflowStepStatus.SUCCEEDED,
          output: { stepACompleted: true },
          completedAt: new Date(),
        },
      });

      // Tick 2: Step A is complete, so STEP_B becomes READY and creates durable Job
      const tick2 = await coordinator.tick();
      expect(tick2.readiedSteps).toBe(1);
      expect(tick2.createdJobs).toBe(1);

      const stepB = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_B' } },
      });
      expect(stepB?.status).toBe(WorkflowStepStatus.READY);

      // Simulate Worker completing STEP_B
      const jobsB = await prisma.job.findMany({ where: { workflowStepId: stepB?.id } });
      await prisma.job.update({
        where: { id: jobsB[0].id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });
      await prisma.workflowStep.update({
        where: { id: stepB!.id },
        data: {
          status: WorkflowStepStatus.SUCCEEDED,
          output: { stepBCompleted: true },
          completedAt: new Date(),
        },
      });

      // Tick 3: Step B is complete, so STEP_C becomes READY
      await coordinator.tick();
      const stepC = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_C' } },
      });
      expect(stepC?.status).toBe(WorkflowStepStatus.READY);

      // Simulate Worker completing STEP_C
      const jobsC = await prisma.job.findMany({ where: { workflowStepId: stepC?.id } });
      await prisma.job.update({
        where: { id: jobsC[0].id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });
      await prisma.workflowStep.update({
        where: { id: stepC!.id },
        data: {
          status: WorkflowStepStatus.SUCCEEDED,
          output: { stepCCompleted: true },
          completedAt: new Date(),
        },
      });

      // Tick 4: All steps complete -> Workflow reaches SUCCEEDED
      const tick4 = await coordinator.tick();
      expect(tick4.completedWorkflows).toBe(1);

      const finalWf = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(finalWf?.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(finalWf?.completedAt).toBeDefined();
    });
  });

  describe('3. Parallel Branch and Join (A -> (B, C) -> D)', () => {
    it('readies B and C in parallel, and D waits until BOTH B and C succeed', async () => {
      const instance = await createWorkflow({
        templateKey: 'SYSTEM_PARALLEL_JOIN',
        templateVersion: 1,
      });

      // Tick 1: Root STEP_A readies
      await coordinator.tick();
      const stepA = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_A' } },
      });
      const jobA = await prisma.job.findFirst({ where: { workflowStepId: stepA!.id } });
      await prisma.job.update({
        where: { id: jobA!.id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });
      await prisma.workflowStep.update({
        where: { id: stepA!.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, completedAt: new Date() },
      });

      // Tick 2: Both STEP_B and STEP_C become READY simultaneously
      const tick2 = await coordinator.tick();
      expect(tick2.readiedSteps).toBe(2);
      expect(tick2.createdJobs).toBe(2);

      const stepB = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_B' } },
      });
      const stepC = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_C' } },
      });
      const stepD = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_D' } },
      });

      expect(stepB?.status).toBe(WorkflowStepStatus.READY);
      expect(stepC?.status).toBe(WorkflowStepStatus.READY);
      expect(stepD?.status).toBe(WorkflowStepStatus.PENDING);

      // Succeeded only STEP_B; STEP_C remains READY/RUNNING
      const jobB = await prisma.job.findFirst({ where: { workflowStepId: stepB!.id } });
      await prisma.job.update({
        where: { id: jobB!.id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });
      await prisma.workflowStep.update({
        where: { id: stepB!.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, completedAt: new Date() },
      });

      // Tick 3: STEP_D must NOT become READY yet because STEP_C is still not SUCCEEDED
      const tick3 = await coordinator.tick();
      expect(tick3.readiedSteps).toBe(0);

      const stepD_stillPending = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_D' } },
      });
      expect(stepD_stillPending?.status).toBe(WorkflowStepStatus.PENDING);

      // Now complete STEP_C
      const jobC = await prisma.job.findFirst({ where: { workflowStepId: stepC!.id } });
      await prisma.job.update({
        where: { id: jobC!.id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });
      await prisma.workflowStep.update({
        where: { id: stepC!.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, completedAt: new Date() },
      });

      // Tick 4: Both B and C are complete, so STEP_D becomes READY!
      const tick4 = await coordinator.tick();
      expect(tick4.readiedSteps).toBe(1);

      const stepD_ready = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_D' } },
      });
      expect(stepD_ready?.status).toBe(WorkflowStepStatus.READY);

      // Complete STEP_D
      const jobD = await prisma.job.findFirst({ where: { workflowStepId: stepD!.id } });
      await prisma.job.update({
        where: { id: jobD!.id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });
      await prisma.workflowStep.update({
        where: { id: stepD!.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, completedAt: new Date() },
      });

      // Final Tick: Workflow SUCCEEDED
      await coordinator.tick();
      const finalWf = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(finalWf?.status).toBe(WorkflowStatus.SUCCEEDED);
    });
  });

  describe('4. Safe Declarative Conditions (A -> B conditionally -> C)', () => {
    it('condition false: transitions B to SKIPPED, unlocks C without creating Job for B', async () => {
      const instance = await createWorkflow({
        templateKey: 'SYSTEM_CONDITIONAL',
        templateVersion: 1,
      });

      // Ready and execute STEP_A, outputting { continue: false }
      await coordinator.tick();
      const stepA = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_A' } },
      });
      const jobA = await prisma.job.findFirst({ where: { workflowStepId: stepA!.id } });
      await prisma.job.update({
        where: { id: jobA!.id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });
      await prisma.workflowStep.update({
        where: { id: stepA!.id },
        data: {
          status: WorkflowStepStatus.SUCCEEDED,
          output: { continue: false },
          completedAt: new Date(),
        },
      });

      // Tick 2: Condition for STEP_B evaluates false
      // STEP_B becomes SKIPPED (no Job created for B), and downstream STEP_C immediately becomes READY!
      const tick2 = await coordinator.tick();
      expect(tick2.skippedSteps).toBe(1);
      expect(tick2.readiedSteps).toBe(1);

      const stepB = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_B' } },
      });
      expect(stepB?.status).toBe(WorkflowStepStatus.SKIPPED);

      const jobsB = await prisma.job.findMany({ where: { workflowStepId: stepB!.id } });
      expect(jobsB).toHaveLength(0);

      const stepC = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_C' } },
      });
      expect(stepC?.status).toBe(WorkflowStepStatus.READY);

      // Complete STEP_C
      const jobC = await prisma.job.findFirst({ where: { workflowStepId: stepC!.id } });
      await prisma.job.update({
        where: { id: jobC!.id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });
      await prisma.workflowStep.update({
        where: { id: stepC!.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, completedAt: new Date() },
      });

      // Final Tick: Workflow SUCCEEDED (A SUCCEEDED, B SKIPPED, C SUCCEEDED)
      await coordinator.tick();
      const finalWf = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(finalWf?.status).toBe(WorkflowStatus.SUCCEEDED);
    });

    it('condition true: transitions B to READY, creates Job, executes normally', async () => {
      const instance = await createWorkflow({
        templateKey: 'SYSTEM_CONDITIONAL',
        templateVersion: 1,
      });

      // Execute STEP_A with { continue: true }
      await coordinator.tick();
      const stepA = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_A' } },
      });
      const jobA = await prisma.job.findFirst({ where: { workflowStepId: stepA!.id } });
      await prisma.job.update({
        where: { id: jobA!.id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });
      await prisma.workflowStep.update({
        where: { id: stepA!.id },
        data: {
          status: WorkflowStepStatus.SUCCEEDED,
          output: { continue: true },
          completedAt: new Date(),
        },
      });

      // Tick 2: Condition is met -> STEP_B becomes READY with durable Job
      const tick2 = await coordinator.tick();
      expect(tick2.readiedSteps).toBe(1);
      expect(tick2.createdJobs).toBe(1);

      const stepB = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_B' } },
      });
      expect(stepB?.status).toBe(WorkflowStepStatus.READY);

      const jobsB = await prisma.job.findMany({ where: { workflowStepId: stepB!.id } });
      expect(jobsB).toHaveLength(1);
    });
  });

  describe('5. Resilience: Restarts & Concurrent Coordinator Races', () => {
    it('coordinator restart safety: stops mid-execution, resumes without duplicate Jobs or Steps', async () => {
      const instance = await createWorkflow();

      // Coordinator 1 processes first step
      await coordinator.tick();
      await coordinator.stop();

      // Simulate partial crash recovery: create new coordinator instance
      const coordinator2 = new WorkflowCoordinator(prisma, templateRegistry);
      await coordinator2.tick();

      const jobsA = await prisma.job.findMany({
        where: { workflowId: instance.id },
      });
      expect(jobsA).toHaveLength(1);

      const steps = await prisma.workflowStep.findMany({
        where: { workflowId: instance.id },
      });
      expect(steps).toHaveLength(3);
    });

    it('multi-coordinator race: 3 coordinators concurrently on same workflow create exactly 1 Job per step', async () => {
      const instance = await createWorkflow();

      const coord1 = new WorkflowCoordinator(prisma, templateRegistry);
      const coord2 = new WorkflowCoordinator(prisma, templateRegistry);
      const coord3 = new WorkflowCoordinator(prisma, templateRegistry);

      // Race all 3 coordinators simultaneously on the same tick
      await Promise.all([coord1.tick(), coord2.tick(), coord3.tick()]);

      // Exactly ONE Job must exist for STEP_A
      const jobsA = await prisma.job.findMany({
        where: { workflowId: instance.id },
      });
      expect(jobsA).toHaveLength(1);
      expect(jobsA[0].idempotencyKey).toBe(`workflow-step:${instance.id}:STEP_A:v1`);
    });
  });

  describe('6. Error & Safety Handling', () => {
    it('missing template safety: transitions Workflow to BLOCKED', async () => {
      const instance = await createWorkflow();

      // Alter templateKey to nonexistent template in DB
      await prisma.workflow.update({
        where: { id: instance.id },
        data: { templateKey: 'GHOST_TEMPLATE' },
      });

      await coordinator.tick();

      const blockedWf = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(blockedWf?.status).toBe(WorkflowStatus.BLOCKED);

      // No jobs created for blocked workflow
      const jobs = await prisma.job.findMany({ where: { workflowId: instance.id } });
      expect(jobs).toHaveLength(0);
    });

    it('step permanent failure: reconciles step to FAILED, marks Workflow FAILED, blocks downstream', async () => {
      const instance = await createWorkflow();

      await coordinator.tick();

      const stepA = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_A' } },
      });
      const jobA = await prisma.job.findFirst({ where: { workflowStepId: stepA!.id } });

      // Simulate Job reaching FAILED
      await prisma.job.update({
        where: { id: jobA!.id },
        data: { status: JobStatus.FAILED, completedAt: new Date() },
      });

      // Coordinator tick reconciles failure
      const tick = await coordinator.tick();
      expect(tick.failedWorkflows).toBe(1);

      const failedStepA = await prisma.workflowStep.findUnique({
        where: { id: stepA!.id },
      });
      expect(failedStepA?.status).toBe(WorkflowStepStatus.FAILED);

      const failedWf = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(failedWf?.status).toBe(WorkflowStatus.FAILED);

      // Downstream STEP_B must never have run or received a Job
      const stepB = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_B' } },
      });
      expect(stepB?.status).toBe(WorkflowStepStatus.PENDING);

      const jobsB = await prisma.job.findMany({ where: { workflowStepId: stepB!.id } });
      expect(jobsB).toHaveLength(0);
    });

    it('step BLOCKED propagation: linked Job BLOCKED transitions step to BLOCKED and Workflow to BLOCKED', async () => {
      const instance = await createWorkflow();

      await coordinator.tick();

      const stepA = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_A' } },
      });
      const jobA = await prisma.job.findFirst({ where: { workflowStepId: stepA!.id } });

      // Simulate Job reaching BLOCKED
      await prisma.job.update({
        where: { id: jobA!.id },
        data: { status: JobStatus.BLOCKED },
      });

      await coordinator.tick();

      const blockedStep = await prisma.workflowStep.findUnique({ where: { id: stepA!.id } });
      expect(blockedStep?.status).toBe(WorkflowStepStatus.BLOCKED);

      const blockedWf = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(blockedWf?.status).toBe(WorkflowStatus.BLOCKED);

      // Downstream step B remains PENDING
      const stepB = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_B' } },
      });
      expect(stepB?.status).toBe(WorkflowStepStatus.PENDING);
    });
  });

  describe('7. Authoritative Durability & Safety Invariants', () => {
    it('crash output recovery: restores output from Job payload to RUNNING step without re-executing', async () => {
      const instance = await createWorkflow();
      await coordinator.tick();

      const stepA = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_A' } },
      });
      const jobA = await prisma.job.findFirst({ where: { workflowStepId: stepA!.id } });

      // Simulate worker marked Job SUCCEEDED with payload.result, but crashed before updating WorkflowStep
      await prisma.job.update({
        where: { id: jobA!.id },
        data: {
          status: JobStatus.SUCCEEDED,
          completedAt: new Date(),
          payload: {
            templateKey: 'SYSTEM_LINEAR',
            templateVersion: 1,
            stepKey: 'STEP_A',
            result: { output: { simulatedCrashRecovery: true, answer: 42 } },
          },
        },
      });

      await prisma.workflowStep.update({
        where: { id: stepA!.id },
        data: {
          status: WorkflowStepStatus.RUNNING,
          output: null as any,
        },
      });

      // Coordinator tick reconciles: step becomes SUCCEEDED and output is restored from Job payload
      await coordinator.tick();

      const recoveredStepA = await prisma.workflowStep.findUnique({ where: { id: stepA!.id } });
      expect(recoveredStepA?.status).toBe(WorkflowStepStatus.SUCCEEDED);
      expect(recoveredStepA?.output).toEqual({ simulatedCrashRecovery: true, answer: 42 });

      // And downstream step B now readies
      const stepB = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_B' } },
      });
      expect(stepB?.status).toBe(WorkflowStepStatus.READY);
    });

    it('dependency safety: step marked SUCCEEDED but Job still RUNNING does not ready downstream step', async () => {
      const instance = await createWorkflow();
      await coordinator.tick();

      const stepA = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_A' } },
      });
      const jobA = await prisma.job.findFirst({ where: { workflowStepId: stepA!.id } });

      // Inconsistent state: step marked SUCCEEDED in DB, but Job is still RUNNING
      await prisma.job.update({
        where: { id: jobA!.id },
        data: { status: JobStatus.RUNNING },
      });
      await prisma.workflowStep.update({
        where: { id: stepA!.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { ok: true } },
      });

      // Coordinator tick must NOT ready STEP_B because stepA's job is not SUCCEEDED
      await coordinator.tick();

      const stepB = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_B' } },
      });
      expect(stepB?.status).toBe(WorkflowStepStatus.PENDING);
    });

    it('completion safety: all steps marked SUCCEEDED but one Job still RUNNING prevents Workflow SUCCEEDED', async () => {
      const instance = await createWorkflow();
      await coordinator.tick();

      const stepA = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_A' } },
      });
      const stepB = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_B' } },
      });
      const stepC = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_C' } },
      });

      // Mark all steps SUCCEEDED, but leave jobA in RUNNING
      const jobA = await prisma.job.findFirst({ where: { workflowStepId: stepA!.id } });
      await prisma.job.update({
        where: { id: jobA!.id },
        data: { status: JobStatus.RUNNING },
      });

      await prisma.workflowStep.update({
        where: { id: stepA!.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { a: 1 } },
      });
      await prisma.workflowStep.update({
        where: { id: stepB!.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { b: 2 } },
      });
      await prisma.workflowStep.update({
        where: { id: stepC!.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { c: 3 } },
      });

      await coordinator.tick();

      const wf = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(wf?.status).not.toBe(WorkflowStatus.SUCCEEDED);
    });
  });

  describe('Human-in-the-Loop Approval Workflow (SYSTEM_APPROVAL_V1)', () => {
    beforeEach(async () => {
      await prisma.recoveryCase.update({
        where: { id: testRecoveryCaseId },
        data: { status: RecoveryCaseStatus.WAITING_APPROVAL },
      });
    });

    it('pauses workflow in WAITING and creates Approval record with previewSnapshot when approval step readied, creating ZERO jobs for approval step', async () => {
      const instance = await createWorkflow({
        templateKey: 'SYSTEM_APPROVAL',
        templateVersion: 1,
      });

      // Tick 1: Step 1 (STEP_CHECK) readies and creates Job
      const tick1 = await coordinator.tick();
      expect(tick1.readiedSteps).toBe(1);
      expect(tick1.createdJobs).toBe(1);

      const stepCheck = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_CHECK' } },
        include: { jobs: true },
      });
      expect(stepCheck?.status).toBe(WorkflowStepStatus.READY);
      expect(stepCheck?.jobs).toHaveLength(1);

      // Complete STEP_CHECK Job
      const checkJob = stepCheck!.jobs[0];
      await prisma.job.update({
        where: { id: checkJob.id },
        data: {
          status: JobStatus.SUCCEEDED,
          payload: { result: { output: { verified: true } } },
          completedAt: new Date(),
        },
      });

      // Tick 2: Reconciles STEP_CHECK to SUCCEEDED; readies STEP_APPROVAL
      const tick2 = await coordinator.tick();
      expect(tick2.createdJobs).toBe(0); // ZERO jobs created for approval step!

      const stepApproval = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_APPROVAL' } },
        include: { jobs: true, approvals: true },
      });

      // Step and Workflow are both in WAITING
      expect(stepApproval?.status).toBe(WorkflowStepStatus.WAITING);
      expect(stepApproval?.jobs).toHaveLength(0); // Durable proof: ZERO jobs created
      expect(stepApproval?.approvals).toHaveLength(1);

      const wf = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(wf?.status).toBe(WorkflowStatus.WAITING);

      // Verify immutable Approval record snapshot
      const approvalRecord = stepApproval!.approvals[0];
      expect(approvalRecord.status).toBe(ApprovalStatus.PENDING);
      expect(approvalRecord.organizationId).toBe(testOrgId);
      expect(approvalRecord.recoveryCaseId).toBe(testRecoveryCaseId);
      expect(approvalRecord.workflowId).toBe(instance.id);
      expect(approvalRecord.workflowStepId).toBe(stepApproval!.id);
      expect(approvalRecord.previewSnapshot).toBeDefined();

      const snapshot = approvalRecord.previewSnapshot as any;
      expect(snapshot.version).toBe(1);
      expect(snapshot.problem).toContain('carrier delivery exception');
      expect(snapshot.proposedAction).toContain('replacement shipment');
      expect(snapshot.safetyChecks).toBeInstanceOf(Array);
      expect(snapshot.changes).toBeInstanceOf(Array);
      expect(snapshot.verifiedContext).toEqual({ verified: true });
    });

    it('multi-coordinator idempotency: subsequent ticks do not duplicate Approval or create jobs', async () => {
      const instance = await createWorkflow({
        templateKey: 'SYSTEM_APPROVAL',
        templateVersion: 1,
      });

      await coordinator.tick();
      const stepCheck = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_CHECK' } },
        include: { jobs: true },
      });
      await prisma.job.update({
        where: { id: stepCheck!.jobs[0].id },
        data: {
          status: JobStatus.SUCCEEDED,
          payload: { result: { output: { verified: true } } },
          completedAt: new Date(),
        },
      });

      // First tick creates approval
      await coordinator.tick();

      // Subsequent ticks should be idempotent no-ops
      for (let i = 0; i < 3; i++) {
        const tick = await coordinator.tick();
        expect(tick.createdJobs).toBe(0);
      }

      const stepApproval = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_APPROVAL' } },
        include: { jobs: true, approvals: true },
      });
      expect(stepApproval?.status).toBe(WorkflowStepStatus.WAITING);
      expect(stepApproval?.approvals).toHaveLength(1);
      expect(stepApproval?.jobs).toHaveLength(0);

      const wf = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(wf?.status).toBe(WorkflowStatus.WAITING);
    });

    it('coordinator restart safety: fresh coordinator preserves WAITING state', async () => {
      const instance = await createWorkflow({
        templateKey: 'SYSTEM_APPROVAL',
        templateVersion: 1,
      });

      await coordinator.tick();
      const stepCheck = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_CHECK' } },
        include: { jobs: true },
      });
      await prisma.job.update({
        where: { id: stepCheck!.jobs[0].id },
        data: {
          status: JobStatus.SUCCEEDED,
          payload: { result: { output: { verified: true } } },
          completedAt: new Date(),
        },
      });
      await coordinator.tick();

      // Simulate coordinator restart by instantiating a fresh coordinator
      const freshCoordinator = new WorkflowCoordinator(prisma, templateRegistry, {
        workflowScanIntervalMs: 50,
      });

      const tick = await freshCoordinator.tick();
      expect(tick.createdJobs).toBe(0);

      const wf = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(wf?.status).toBe(WorkflowStatus.WAITING);
    });

    it('approved decision unlocks downstream STEP_EXECUTE and completes full workflow', async () => {
      const instance = await createWorkflow({
        templateKey: 'SYSTEM_APPROVAL',
        templateVersion: 1,
      });

      // 1. Run STEP_CHECK
      await coordinator.tick();
      const stepCheck = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_CHECK' } },
        include: { jobs: true },
      });
      await prisma.job.update({
        where: { id: stepCheck!.jobs[0].id },
        data: {
          status: JobStatus.SUCCEEDED,
          payload: { result: { output: { verified: true } } },
          completedAt: new Date(),
        },
      });

      // 2. Step pauses in WAITING
      await coordinator.tick();
      const stepApproval = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_APPROVAL' } },
        include: { approvals: true },
      });
      const approval = stepApproval!.approvals[0];

      // 3. Human decision: APPROVE
      await prisma.approval.update({
        where: { id: approval.id },
        data: {
          status: ApprovalStatus.APPROVED,
          decidedAt: new Date(),
        },
      });

      // 4. Coordinator tick reconciles APPROVED: STEP_APPROVAL -> SUCCEEDED, Workflow -> RUNNING, STEP_EXECUTE -> READY (job created)
      const tickApproved = await coordinator.tick();
      expect(tickApproved.readiedSteps).toBe(1); // STEP_EXECUTE readied
      expect(tickApproved.createdJobs).toBe(1); // STEP_EXECUTE Job created

      const stepExecute = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_EXECUTE' } },
        include: { jobs: true },
      });
      expect(stepExecute?.status).toBe(WorkflowStepStatus.READY);
      expect(stepExecute?.jobs).toHaveLength(1);

      const wfRunning = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(wfRunning?.status).toBe(WorkflowStatus.RUNNING);

      // 5. Complete STEP_EXECUTE Job
      await prisma.job.update({
        where: { id: stepExecute!.jobs[0].id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });

      // 6. Coordinator tick readies STEP_VERIFY
      const tickVerify = await coordinator.tick();
      expect(tickVerify.readiedSteps).toBe(1);
      expect(tickVerify.createdJobs).toBe(1);

      const stepVerify = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_VERIFY' } },
        include: { jobs: true },
      });
      expect(stepVerify?.status).toBe(WorkflowStepStatus.READY);

      // 7. Complete STEP_VERIFY Job
      await prisma.job.update({
        where: { id: stepVerify!.jobs[0].id },
        data: { status: JobStatus.SUCCEEDED, completedAt: new Date() },
      });

      // 8. Coordinator tick completes workflow
      const tickFinal = await coordinator.tick();
      expect(tickFinal.completedWorkflows).toBe(1);

      const wfCompleted = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(wfCompleted?.status).toBe(WorkflowStatus.SUCCEEDED);
    });

    it('rejected decision blocks workflow and creates zero downstream jobs', async () => {
      const instance = await createWorkflow({
        templateKey: 'SYSTEM_APPROVAL',
        templateVersion: 1,
      });

      // 1. Run STEP_CHECK
      await coordinator.tick();
      const stepCheck = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_CHECK' } },
        include: { jobs: true },
      });
      await prisma.job.update({
        where: { id: stepCheck!.jobs[0].id },
        data: {
          status: JobStatus.SUCCEEDED,
          payload: { result: { output: { verified: true } } },
          completedAt: new Date(),
        },
      });

      // 2. Step pauses in WAITING
      await coordinator.tick();
      const stepApproval = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_APPROVAL' } },
        include: { approvals: true },
      });
      const approval = stepApproval!.approvals[0];

      // 3. Human decision: REJECT
      await prisma.approval.update({
        where: { id: approval.id },
        data: {
          status: ApprovalStatus.REJECTED,
          reason: 'Manual inspection failed safety threshold',
          decidedAt: new Date(),
        },
      });

      // 4. Coordinator tick reconciles REJECTED
      const tickRejected = await coordinator.tick();
      expect(tickRejected.blockedWorkflows).toBe(1);
      expect(tickRejected.createdJobs).toBe(0);

      const stepApprovalBlocked = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_APPROVAL' } },
      });
      expect(stepApprovalBlocked?.status).toBe(WorkflowStepStatus.BLOCKED);

      const wfBlocked = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(wfBlocked?.status).toBe(WorkflowStatus.BLOCKED);

      // 5. Verify zero downstream jobs created
      const stepExecute = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_EXECUTE' } },
        include: { jobs: true },
      });
      expect(stepExecute?.status).toBe(WorkflowStepStatus.PENDING);
      expect(stepExecute?.jobs).toHaveLength(0);

      const stepVerify = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_VERIFY' } },
        include: { jobs: true },
      });
      expect(stepVerify?.status).toBe(WorkflowStepStatus.PENDING);
      expect(stepVerify?.jobs).toHaveLength(0);
    });

    it('expired approval blocks step, workflow, and case, creating zero jobs', async () => {
      const instance = await createWorkflow({
        templateKey: 'SYSTEM_APPROVAL',
        templateVersion: 1,
      });

      // 1. Run STEP_CHECK to success
      await coordinator.tick();
      const stepCheck = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_CHECK' } },
        include: { jobs: true },
      });
      await prisma.job.update({
        where: { id: stepCheck!.jobs[0].id },
        data: {
          status: JobStatus.SUCCEEDED,
          payload: { result: { output: { verified: true } } },
          completedAt: new Date(),
        },
      });

      // 2. Pause in WAITING
      await coordinator.tick();
      const stepApproval = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_APPROVAL' } },
        include: { approvals: true },
      });
      const approval = stepApproval!.approvals[0];

      // 3. Mark approval EXPIRED
      await prisma.approval.update({
        where: { id: approval.id },
        data: {
          status: ApprovalStatus.EXPIRED,
          expiresAt: new Date(Date.now() - 1000),
        },
      });

      // 4. Coordinator tick
      const tickExpired = await coordinator.tick();
      expect(tickExpired.createdJobs).toBe(0);
      expect(tickExpired.blockedWorkflows).toBe(1);

      // 5. Verify stale approval cannot leave an executable graph waiting forever
      const stepApprovalCheck = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_APPROVAL' } },
      });
      expect(stepApprovalCheck?.status).toBe(WorkflowStepStatus.BLOCKED);

      const wfCheck = await prisma.workflow.findUnique({ where: { id: instance.id } });
      expect(wfCheck?.status).toBe(WorkflowStatus.BLOCKED);

      const caseCheck = await prisma.recoveryCase.findUnique({
        where: { id: testRecoveryCaseId },
      });
      expect(caseCheck?.status).toBe(RecoveryCaseStatus.BLOCKED);

      const stepExecute = await prisma.workflowStep.findUnique({
        where: { workflowId_key: { workflowId: instance.id, key: 'STEP_EXECUTE' } },
        include: { jobs: true },
      });
      expect(stepExecute?.status).toBe(WorkflowStepStatus.PENDING);
      expect(stepExecute?.jobs).toHaveLength(0);
    });
  });
});
