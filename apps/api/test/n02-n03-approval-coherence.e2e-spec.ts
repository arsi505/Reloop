import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL is required.');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { randomUUID } from 'node:crypto';
import {
  ApprovalStatus,
  Prisma,
  RecoveryCaseStatus,
  RecoveryCaseType,
  RecoveryLevel,
  Role,
  WorkflowStatus,
  WorkflowStepStatus,
} from '@reloop/database';
import { WorkflowTemplateRegistry, registerRecoveryTemplates } from '@reloop/workflow-core';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApprovalsService } from '../src/approvals/approvals.service';
import { RealtimePublisher } from '../src/realtime/realtime.publisher';
import { WorkflowCoordinator } from '../../scheduler/src/workflow-coordinator';

const verifiedContext = {
  safeToExecute: true,
  orderNumber: 'ORD-VERIFIED-903',
  customer: { name: 'Distinct Customer', email: 'distinct@example.com' },
  shippingAddress: {
    street: '903 Verified Avenue',
    city: 'Portland',
    state: 'OR',
    postalCode: '97205',
    country: 'US',
  },
  lineItems: [
    { sku: 'SKU-VERIFIED-77', name: 'Verified Item', quantity: 7, price: 19.5 },
  ],
  safetyFingerprint: 'verified-fingerprint-903',
};

describe('N-02/N-03 approval recovery coherence', () => {
  let prisma: PrismaService;
  let service: ApprovalsService;
  let organizationId: string;
  let actorUserId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ApprovalsService(
      prisma,
      { publish: jest.fn().mockResolvedValue(undefined) } as unknown as RealtimePublisher,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const organization = await prisma.organization.create({
      data: { name: `N02 N03 ${runId}`, slug: `n02-n03-${runId}` },
    });
    organizationId = organization.id;
    const actor = await prisma.user.create({
      data: {
        email: `n02-n03-${runId}@example.com`,
        name: 'Approval Operator',
        passwordHash: 'not-used-by-service-test',
        memberships: { create: { organizationId, role: Role.OPERATOR } },
      },
    });
    actorUserId = actor.id;
  });

  afterEach(async () => {
    await prisma.auditLog.deleteMany({ where: { organizationId } });
    await prisma.approval.deleteMany({ where: { organizationId } });
    await prisma.jobAttempt.deleteMany({ where: { job: { organizationId } } });
    await prisma.job.deleteMany({ where: { organizationId } });
    await prisma.workflowStep.deleteMany({ where: { organizationId } });
    await prisma.workflow.deleteMany({ where: { organizationId } });
    await prisma.recoveryCase.deleteMany({ where: { organizationId } });
    await prisma.organizationMember.deleteMany({ where: { organizationId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: actorUserId } });
  });

  it('rejects the complete graph atomically and never queues EXECUTE', async () => {
    const fixture = await createFixture();

    await service.rejectApproval(
      organizationId,
      fixture.approvalId,
      actorUserId,
      'Operator rejected the proposed mutation',
    );

    const [approval, approvalStep, workflow, recoveryCase, executeJobs] = await Promise.all([
      prisma.approval.findUniqueOrThrow({ where: { id: fixture.approvalId } }),
      prisma.workflowStep.findUniqueOrThrow({ where: { id: fixture.approvalStepId } }),
      prisma.workflow.findUniqueOrThrow({ where: { id: fixture.workflowId } }),
      prisma.recoveryCase.findUniqueOrThrow({ where: { id: fixture.recoveryCaseId } }),
      prisma.job.count({ where: { workflowStepId: fixture.executeStepId } }),
    ]);
    expect(approval.status).toBe(ApprovalStatus.REJECTED);
    expect(approvalStep.status).toBe(WorkflowStepStatus.BLOCKED);
    expect(workflow.status).toBe(WorkflowStatus.BLOCKED);
    expect(recoveryCase.status).toBe(RecoveryCaseStatus.BLOCKED);
    expect(executeJobs).toBe(0);
  });

  it('preserves exact CHECK context, advances only to RECOVERING, and queues it for EXECUTE', async () => {
    const fixture = await createFixture();

    await service.approveApproval(
      organizationId,
      fixture.approvalId,
      actorUserId,
      'Approved reviewed CHECK output',
    );

    const [approvalStep, recoveryCase] = await Promise.all([
      prisma.workflowStep.findUniqueOrThrow({ where: { id: fixture.approvalStepId } }),
      prisma.recoveryCase.findUniqueOrThrow({ where: { id: fixture.recoveryCaseId } }),
    ]);
    expect(approvalStep.status).toBe(WorkflowStepStatus.SUCCEEDED);
    expect(approvalStep.output).toEqual(expect.objectContaining({ ...verifiedContext, approved: true }));
    expect(recoveryCase.status).toBe(RecoveryCaseStatus.RECOVERING);
    expect(recoveryCase.status).not.toBe(RecoveryCaseStatus.RESOLVED);

    const registry = new WorkflowTemplateRegistry();
    registerRecoveryTemplates(registry);
    const coordinator = new WorkflowCoordinator(prisma, registry);
    const workflow = await prisma.workflow.findUniqueOrThrow({
      where: { id: fixture.workflowId },
    });
    await (coordinator as any).reconcileWorkflow(workflow, {
      scanned: 1,
      readiedSteps: 0,
      createdJobs: 0,
      skippedSteps: 0,
      completedWorkflows: 0,
      failedWorkflows: 0,
      blockedWorkflows: 0,
      durationMs: 0,
      errors: 0,
    });

    const executeJob = await prisma.job.findFirstOrThrow({
      where: { workflowStepId: fixture.executeStepId },
    });
    expect(executeJob.payload).toEqual(
      expect.objectContaining({
        orderNumber: verifiedContext.orderNumber,
        customer: verifiedContext.customer,
        shippingAddress: verifiedContext.shippingAddress,
        lineItems: verifiedContext.lineItems,
      }),
    );
    expect(JSON.stringify(executeJob.payload)).not.toContain('SKU-DEFAULT');
    expect(await prisma.job.count({ where: { workflowStepId: fixture.verifyStepId } })).toBe(0);
    expect(
      (await prisma.recoveryCase.findUniqueOrThrow({ where: { id: fixture.recoveryCaseId } })).status,
    ).toBe(RecoveryCaseStatus.RECOVERING);
  });

  it.each([
    ['approve', (fixture: Fixture) => service.approveApproval(organizationId, fixture.approvalId, actorUserId)],
    ['reject', (fixture: Fixture) => service.rejectApproval(organizationId, fixture.approvalId, actorUserId, 'No')],
  ])('allows exactly one decision in a double-%s race', async (_decision, decide) => {
    const fixture = await createFixture();
    const outcomes = await Promise.allSettled([decide(fixture), decide(fixture)]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });

  it('allows exactly one winner in an approve-vs-reject race', async () => {
    const fixture = await createFixture();
    const outcomes = await Promise.allSettled([
      service.approveApproval(organizationId, fixture.approvalId, actorUserId),
      service.rejectApproval(organizationId, fixture.approvalId, actorUserId, 'Reject race'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const [approval, workflow, recoveryCase] = await Promise.all([
      prisma.approval.findUniqueOrThrow({ where: { id: fixture.approvalId } }),
      prisma.workflow.findUniqueOrThrow({ where: { id: fixture.workflowId } }),
      prisma.recoveryCase.findUniqueOrThrow({ where: { id: fixture.recoveryCaseId } }),
    ]);
    if (approval.status === ApprovalStatus.APPROVED) {
      expect(workflow.status).toBe(WorkflowStatus.RUNNING);
      expect(recoveryCase.status).toBe(RecoveryCaseStatus.RECOVERING);
    } else {
      expect(approval.status).toBe(ApprovalStatus.REJECTED);
      expect(workflow.status).toBe(WorkflowStatus.BLOCKED);
      expect(recoveryCase.status).toBe(RecoveryCaseStatus.BLOCKED);
    }
  });

  it('rejects expired and terminal decisions without partially changing the graph', async () => {
    const expired = await createFixture({ expiresAt: new Date(Date.now() - 60_000) });
    await expect(
      service.approveApproval(organizationId, expired.approvalId, actorUserId),
    ).rejects.toThrow('Approval has expired');
    expect(
      (await prisma.approval.findUniqueOrThrow({ where: { id: expired.approvalId } })).status,
    ).toBe(ApprovalStatus.PENDING);

    const terminal = await createFixture();
    await prisma.workflow.update({
      where: { id: terminal.workflowId },
      data: { status: WorkflowStatus.BLOCKED },
    });
    await expect(
      service.rejectApproval(organizationId, terminal.approvalId, actorUserId, 'Late'),
    ).rejects.toThrow();
    expect(
      (await prisma.approval.findUniqueOrThrow({ where: { id: terminal.approvalId } })).status,
    ).toBe(ApprovalStatus.PENDING);
  });

  it('does not expose or mutate an approval through the wrong tenant', async () => {
    const fixture = await createFixture();
    await expect(
      service.approveApproval(randomUUID(), fixture.approvalId, actorUserId),
    ).rejects.toThrow(/Approval .* not found/);
    expect(
      (await prisma.approval.findUniqueOrThrow({ where: { id: fixture.approvalId } })).status,
    ).toBe(ApprovalStatus.PENDING);
  });

  it('rejects an incoherent case/workflow relationship without changing any state', async () => {
    const fixture = await createFixture();
    const unrelatedCase = await prisma.recoveryCase.create({
      data: {
        organizationId,
        type: RecoveryCaseType.ORDER_MISSING_AT_3PL,
        recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        status: RecoveryCaseStatus.WAITING_APPROVAL,
        summary: 'Unrelated case',
      },
    });
    await prisma.approval.update({
      where: { id: fixture.approvalId },
      data: { recoveryCaseId: unrelatedCase.id },
    });

    await expect(
      service.approveApproval(organizationId, fixture.approvalId, actorUserId),
    ).rejects.toThrow('relationship is invalid');
    expect(
      (await prisma.approval.findUniqueOrThrow({ where: { id: fixture.approvalId } })).status,
    ).toBe(ApprovalStatus.PENDING);
    expect(
      (await prisma.workflow.findUniqueOrThrow({ where: { id: fixture.workflowId } })).status,
    ).toBe(WorkflowStatus.WAITING);
  });

  it('blocks a reviewed snapshot that differs from CHECK output', async () => {
    const fixture = await createFixture();
    await prisma.approval.update({
      where: { id: fixture.approvalId },
      data: {
        previewSnapshot: {
          verifiedContext: { ...verifiedContext, orderNumber: 'CLIENT-SUBSTITUTED' },
        },
      },
    });

    await expect(
      service.approveApproval(organizationId, fixture.approvalId, actorUserId),
    ).rejects.toThrow('does not match verified CHECK output');
    expect(
      (await prisma.approval.findUniqueOrThrow({ where: { id: fixture.approvalId } })).status,
    ).toBe(ApprovalStatus.PENDING);
    expect(await prisma.job.count({ where: { workflowId: fixture.workflowId } })).toBe(0);
  });

  type Fixture = Awaited<ReturnType<typeof createFixture>>;

  async function createFixture(options: { expiresAt?: Date } = {}) {
    const recoveryCase = await prisma.recoveryCase.create({
      data: {
        organizationId,
        type: RecoveryCaseType.ORDER_MISSING_AT_3PL,
        recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        status: RecoveryCaseStatus.WAITING_APPROVAL,
        summary: 'Order missing at warehouse',
      },
    });
    const workflow = await prisma.workflow.create({
      data: {
        organizationId,
        recoveryCaseId: recoveryCase.id,
        templateKey: 'RECOVERY_ORDER_MISSING_3PL',
        templateVersion: 1,
        status: WorkflowStatus.WAITING,
      },
    });
    const checkStep = await prisma.workflowStep.create({
      data: {
        organizationId,
        workflowId: workflow.id,
        key: 'CHECK',
        name: 'Verify authoritative order data',
        position: 1,
        status: WorkflowStepStatus.SUCCEEDED,
        input: { orderNumber: verifiedContext.orderNumber, caseId: recoveryCase.id },
        output: verifiedContext as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    const approvalStep = await prisma.workflowStep.create({
      data: {
        organizationId,
        workflowId: workflow.id,
        key: 'APPROVAL',
        name: 'Approve verified order data',
        position: 2,
        status: WorkflowStepStatus.WAITING,
        input: { orderNumber: verifiedContext.orderNumber, caseId: recoveryCase.id },
        dependsOnStepId: checkStep.id,
      },
    });
    const executeStep = await prisma.workflowStep.create({
      data: {
        organizationId,
        workflowId: workflow.id,
        key: 'EXECUTE',
        name: 'Create warehouse order',
        position: 3,
        status: WorkflowStepStatus.PENDING,
        input: { orderNumber: verifiedContext.orderNumber, caseId: recoveryCase.id },
        dependsOnStepId: approvalStep.id,
      },
    });
    const verifyStep = await prisma.workflowStep.create({
      data: {
        organizationId,
        workflowId: workflow.id,
        key: 'VERIFY',
        name: 'Verify warehouse order',
        position: 4,
        status: WorkflowStepStatus.PENDING,
        input: { orderNumber: verifiedContext.orderNumber, caseId: recoveryCase.id },
        dependsOnStepId: executeStep.id,
      },
    });
    const approval = await prisma.approval.create({
      data: {
        organizationId,
        recoveryCaseId: recoveryCase.id,
        workflowId: workflow.id,
        workflowStepId: approvalStep.id,
        status: ApprovalStatus.PENDING,
        expiresAt: options.expiresAt,
        previewSnapshot: { reviewed: true, verifiedContext },
      },
    });
    return {
      recoveryCaseId: recoveryCase.id,
      workflowId: workflow.id,
      approvalStepId: approvalStep.id,
      executeStepId: executeStep.id,
      verifyStepId: verifyStep.id,
      approvalId: approval.id,
    };
  }
});
