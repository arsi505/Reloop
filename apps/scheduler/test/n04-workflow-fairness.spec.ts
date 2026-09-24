import * as dotenv from 'dotenv';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import {
  ApprovalStatus,
  PrismaClient,
  RecoveryCaseStatus,
  RecoveryCaseType,
  RecoveryLevel,
  WorkflowStatus,
  WorkflowStepStatus,
} from '@prisma/client';
import { WorkflowTemplateRegistry, registerSystemTemplates } from '@reloop/workflow-core';
import { WorkflowCoordinator } from '../src/workflow-coordinator';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';

describe('N-04 workflow coordinator fairness', () => {
  let prisma: PrismaClient;
  let organizationId: string;
  let registry: WorkflowTemplateRegistry;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
    registry = new WorkflowTemplateRegistry();
    registerSystemTemplates(registry);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.approval.deleteMany({});
    await prisma.workflowStep.deleteMany({});
    await prisma.workflow.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const organization = await prisma.organization.create({
      data: { name: `N04 Fairness ${runId}`, slug: `n04-fairness-${runId}` },
    });
    organizationId = organization.id;
  });

  afterEach(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
  });

  it('processes a newer actionable workflow without touching 20 old passive approvals', async () => {
    const passiveCaseId = await createCase(RecoveryCaseStatus.WAITING_APPROVAL);
    const passive = await createPassiveApprovalWorkflows(
      20,
      passiveCaseId,
      new Date('2025-01-01T00:00:00.000Z'),
    );
    const actionableCaseId = await createCase(RecoveryCaseStatus.OPEN);
    const [actionable] = await createLinearWorkflows(
      1,
      actionableCaseId,
      WorkflowStatus.PENDING,
      new Date('2025-01-02T00:00:00.000Z'),
    );
    const coordinator = new WorkflowCoordinator(prisma, registry, {
      workflowScanBatchSize: 20,
    });

    const result = await coordinator.tick();

    expect(result.scanned).toBe(1);
    expect(
      (await prisma.workflow.findUniqueOrThrow({ where: { id: actionable.workflowId } })).status,
    ).toBe(WorkflowStatus.RUNNING);
    expect(
      (await prisma.workflowStep.findUniqueOrThrow({ where: { id: actionable.firstStepId } }))
        .status,
    ).toBe(WorkflowStepStatus.READY);
    expect(await prisma.job.count({ where: { workflowId: actionable.workflowId } })).toBe(1);
    expect(
      await prisma.workflow.count({
        where: { id: { in: passive.workflowIds }, status: WorkflowStatus.WAITING },
      }),
    ).toBe(20);
    expect(await prisma.job.count({ where: { workflowId: { in: passive.workflowIds } } })).toBe(0);
    expect(
      await prisma.approval.count({
        where: {
          workflowId: { in: passive.workflowIds },
          status: ApprovalStatus.PENDING,
        },
      }),
    ).toBe(20);
  });

  it('eventually progresses 45 actionable workflows across bounded scan pages', async () => {
    const recoveryCaseId = await createCase(RecoveryCaseStatus.OPEN);
    const workflows = await createLinearWorkflows(
      45,
      recoveryCaseId,
      WorkflowStatus.PENDING,
      new Date('2025-02-01T00:00:00.000Z'),
    );
    const coordinator = new WorkflowCoordinator(prisma, registry, {
      workflowScanBatchSize: 20,
    });

    const results = [await coordinator.tick(), await coordinator.tick(), await coordinator.tick()];

    expect(results.map((result) => result.scanned)).toEqual([20, 20, 5]);
    expect(
      await prisma.workflowStep.count({
        where: {
          id: { in: workflows.map((workflow) => workflow.firstStepId) },
          status: WorkflowStepStatus.READY,
        },
      }),
    ).toBe(45);
    expect(
      await prisma.job.count({
        where: { workflowId: { in: workflows.map((workflow) => workflow.workflowId) } },
      }),
    ).toBe(45);
    const jobsByStep = await prisma.job.groupBy({
      by: ['workflowStepId'],
      where: { workflowId: { in: workflows.map((workflow) => workflow.workflowId) } },
      _count: { _all: true },
    });
    expect(jobsByStep).toHaveLength(45);
    expect(jobsByStep.every((group) => group._count._all === 1)).toBe(true);
  });

  it('scans only actionable mixed states and still handles a decided WAITING approval', async () => {
    const passiveCaseId = await createCase(RecoveryCaseStatus.WAITING_APPROVAL);
    const passive = await createPassiveApprovalWorkflows(
      3,
      passiveCaseId,
      new Date('2025-03-01T00:00:00.000Z'),
    );
    const activeCaseId = await createCase(RecoveryCaseStatus.OPEN);
    const [pending] = await createLinearWorkflows(
      1,
      activeCaseId,
      WorkflowStatus.PENDING,
      new Date('2025-03-02T00:00:00.000Z'),
    );
    const [running] = await createLinearWorkflows(
      1,
      activeCaseId,
      WorkflowStatus.RUNNING,
      new Date('2025-03-02T00:00:01.000Z'),
    );
    const approvedCaseId = await createCase(RecoveryCaseStatus.WAITING_APPROVAL);
    const approved = await createPassiveApprovalWorkflows(
      1,
      approvedCaseId,
      new Date('2025-03-02T00:00:02.000Z'),
    );
    await prisma.approval.update({
      where: { id: approved.approvalIds[0] },
      data: { status: ApprovalStatus.APPROVED, decidedAt: new Date() },
    });
    const terminalCaseId = await createCase(RecoveryCaseStatus.BLOCKED);
    const [blocked] = await createLinearWorkflows(
      1,
      terminalCaseId,
      WorkflowStatus.BLOCKED,
      new Date('2025-03-02T00:00:03.000Z'),
    );
    const [succeeded] = await createLinearWorkflows(
      1,
      terminalCaseId,
      WorkflowStatus.SUCCEEDED,
      new Date('2025-03-02T00:00:04.000Z'),
    );
    const coordinator = new WorkflowCoordinator(prisma, registry, {
      workflowScanBatchSize: 20,
    });

    const result = await coordinator.tick();

    expect(result.scanned).toBe(3);
    expect(await prisma.job.count({ where: { workflowId: pending.workflowId } })).toBe(1);
    expect(await prisma.job.count({ where: { workflowId: running.workflowId } })).toBe(1);
    expect(await prisma.job.count({ where: { workflowId: approved.workflowIds[0] } })).toBe(1);
    expect(await prisma.job.count({ where: { workflowId: { in: passive.workflowIds } } })).toBe(0);
    expect(await prisma.job.count({ where: { workflowId: blocked.workflowId } })).toBe(0);
    expect(await prisma.job.count({ where: { workflowId: succeeded.workflowId } })).toBe(0);
    expect(
      await prisma.workflow.count({
        where: { id: { in: passive.workflowIds }, status: WorkflowStatus.WAITING },
      }),
    ).toBe(3);
    expect(
      (await prisma.workflow.findUniqueOrThrow({ where: { id: approved.workflowIds[0] } })).status,
    ).toBe(WorkflowStatus.RUNNING);
  });

  async function createCase(status: RecoveryCaseStatus): Promise<string> {
    const recoveryCase = await prisma.recoveryCase.create({
      data: {
        organizationId,
        type: RecoveryCaseType.TEMPORARY_API_FAILURE,
        recoveryLevel:
          status === RecoveryCaseStatus.WAITING_APPROVAL
            ? RecoveryLevel.REQUIRE_APPROVAL
            : RecoveryLevel.AUTO_RECOVER,
        status,
        summary: `N04 ${status} case`,
      },
    });
    return recoveryCase.id;
  }

  async function createLinearWorkflows(
    count: number,
    recoveryCaseId: string,
    status: WorkflowStatus,
    createdAt: Date,
  ): Promise<Array<{ workflowId: string; firstStepId: string }>> {
    const workflows = Array.from({ length: count }, (_, index) => {
      const workflowId = randomUUID();
      const firstStepId = randomUUID();
      const secondStepId = randomUUID();
      const thirdStepId = randomUUID();
      return {
        workflowId,
        firstStepId,
        workflow: {
          id: workflowId,
          organizationId,
          recoveryCaseId,
          templateKey: 'SYSTEM_LINEAR',
          templateVersion: 1,
          status,
          createdAt: new Date(createdAt.getTime() + index),
        },
        steps: [
          {
            id: firstStepId,
            organizationId,
            workflowId,
            key: 'STEP_A',
            name: 'Step A',
            position: 1,
            status: WorkflowStepStatus.PENDING,
          },
          {
            id: secondStepId,
            organizationId,
            workflowId,
            key: 'STEP_B',
            name: 'Step B',
            position: 2,
            status: WorkflowStepStatus.PENDING,
            dependsOnStepId: firstStepId,
          },
          {
            id: thirdStepId,
            organizationId,
            workflowId,
            key: 'STEP_C',
            name: 'Step C',
            position: 3,
            status: WorkflowStepStatus.PENDING,
            dependsOnStepId: secondStepId,
          },
        ],
      };
    });
    await prisma.workflow.createMany({ data: workflows.map((entry) => entry.workflow) });
    await prisma.workflowStep.createMany({ data: workflows.flatMap((entry) => entry.steps) });
    return workflows.map(({ workflowId, firstStepId }) => ({ workflowId, firstStepId }));
  }

  async function createPassiveApprovalWorkflows(
    count: number,
    recoveryCaseId: string,
    createdAt: Date,
  ): Promise<{ workflowIds: string[]; approvalStepIds: string[]; approvalIds: string[] }> {
    const workflows = Array.from({ length: count }, (_, index) => {
      const workflowId = randomUUID();
      const checkStepId = randomUUID();
      const approvalStepId = randomUUID();
      const executeStepId = randomUUID();
      const verifyStepId = randomUUID();
      return {
        workflowId,
        approvalStepId,
        workflow: {
          id: workflowId,
          organizationId,
          recoveryCaseId,
          templateKey: 'SYSTEM_APPROVAL',
          templateVersion: 1,
          status: WorkflowStatus.WAITING,
          createdAt: new Date(createdAt.getTime() + index),
        },
        steps: [
          {
            id: checkStepId,
            organizationId,
            workflowId,
            key: 'STEP_CHECK',
            name: 'Check',
            position: 1,
            status: WorkflowStepStatus.SUCCEEDED,
            output: { verified: true },
            completedAt: createdAt,
          },
          {
            id: approvalStepId,
            organizationId,
            workflowId,
            key: 'STEP_APPROVAL',
            name: 'Approval',
            position: 2,
            status: WorkflowStepStatus.WAITING,
            dependsOnStepId: checkStepId,
          },
          {
            id: executeStepId,
            organizationId,
            workflowId,
            key: 'STEP_EXECUTE',
            name: 'Execute',
            position: 3,
            status: WorkflowStepStatus.PENDING,
            dependsOnStepId: approvalStepId,
          },
          {
            id: verifyStepId,
            organizationId,
            workflowId,
            key: 'STEP_VERIFY',
            name: 'Verify',
            position: 4,
            status: WorkflowStepStatus.PENDING,
            dependsOnStepId: executeStepId,
          },
        ],
        approval: {
          id: randomUUID(),
          organizationId,
          recoveryCaseId,
          workflowId,
          workflowStepId: approvalStepId,
          status: ApprovalStatus.PENDING,
          previewSnapshot: { verifiedContext: { verified: true } },
        },
      };
    });
    await prisma.workflow.createMany({ data: workflows.map((entry) => entry.workflow) });
    await prisma.workflowStep.createMany({ data: workflows.flatMap((entry) => entry.steps) });
    await prisma.approval.createMany({ data: workflows.map((entry) => entry.approval) });
    return {
      workflowIds: workflows.map((entry) => entry.workflowId),
      approvalStepIds: workflows.map((entry) => entry.approvalStepId),
      approvalIds: workflows.map((entry) => entry.approval.id),
    };
  }
});
