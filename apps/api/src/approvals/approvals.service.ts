import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import {
  PrismaService,
} from '../prisma/prisma.service';
import {
  ApprovalStatus,
  Prisma,
  RecoveryCaseStatus,
  WorkflowStatus,
  WorkflowStepStatus,
} from '@reloop/database';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { isDeepStrictEqual } from 'node:util';

type ApprovalDecisionGraph = Prisma.ApprovalGetPayload<{
  include: { workflow: true; workflowStep: true; recoveryCase: true };
}>;

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasNonEmptyStringFields(
  value: Record<string, unknown>,
  fields: string[],
): boolean {
  return fields.every((field) => isNonEmptyString(value[field]));
}

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimePublisher: RealtimePublisher,
  ) {}

  private validateDecisionGraph(
    approval: ApprovalDecisionGraph,
    organizationId: string,
  ): void {
    if (!approval.workflowId || !approval.workflowStepId) {
      throw new ConflictException(
        'Approval is not linked to a complete workflow decision graph',
      );
    }
    if (
      approval.recoveryCase.organizationId !== organizationId ||
      approval.workflow?.organizationId !== organizationId ||
      approval.workflowStep?.organizationId !== organizationId ||
      approval.workflow?.recoveryCaseId !== approval.recoveryCaseId ||
      approval.workflowStep?.workflowId !== approval.workflowId
    ) {
      throw new ConflictException(
        'Approval workflow, step, and recovery case relationship is invalid',
      );
    }
  }

  private async loadVerifiedContext(
    tx: Prisma.TransactionClient,
    approval: ApprovalDecisionGraph,
  ): Promise<Record<string, unknown>> {
    const parentStepId = approval.workflowStep?.dependsOnStepId;
    if (!parentStepId || !approval.workflowId) {
      throw new BadRequestException(
        'Approval is missing its verified CHECK dependency',
      );
    }

    const lockedParents = await tx.$queryRaw<
      { id: string; status: WorkflowStepStatus; output: unknown }[]
    >`
      SELECT id, status, output
      FROM workflow_steps
      WHERE id = ${parentStepId}::uuid
        AND organization_id = ${approval.organizationId}::uuid
        AND workflow_id = ${approval.workflowId}::uuid
      FOR UPDATE
    `;
    const parent = lockedParents[0];
    if (
      !parent ||
      parent.status !== WorkflowStepStatus.SUCCEEDED ||
      !isJsonRecord(parent.output)
    ) {
      throw new BadRequestException(
        'Verified CHECK output is unavailable or no longer valid',
      );
    }

    const snapshot = approval.previewSnapshot;
    const reviewedContext = isJsonRecord(snapshot)
      ? snapshot.verifiedContext
      : undefined;
    if (
      !isJsonRecord(reviewedContext) ||
      !isDeepStrictEqual(reviewedContext, parent.output)
    ) {
      throw new ConflictException(
        'Persisted approval snapshot does not match verified CHECK output',
      );
    }

    this.validateRequiredRecoveryContext(
      approval.workflow?.templateKey ?? '',
      reviewedContext,
    );
    return reviewedContext;
  }

  private validateRequiredRecoveryContext(
    templateKey: string,
    context: Record<string, unknown>,
  ): void {
    if (!templateKey.startsWith('RECOVERY_')) return;

    if (context.safeToExecute !== true || !isNonEmptyString(context.orderNumber)) {
      throw new BadRequestException(
        'Verified CHECK context is missing safeToExecute or orderNumber',
      );
    }

    if (
      templateKey === 'RECOVERY_TRACKING_MISSING_APPROVAL' ||
      templateKey === 'RECOVERY_SHIPPED_UNFULFILLED'
    ) {
      if (
        !isNonEmptyString(context.trackingNumber) ||
        !isNonEmptyString(context.carrier)
      ) {
        throw new BadRequestException(
          'Verified CHECK context is missing trackingNumber or carrier',
        );
      }
    }

    if (templateKey === 'RECOVERY_ORDER_MISSING_3PL') {
      const customer = context.customer;
      const shippingAddress = context.shippingAddress;
      const lineItems = context.lineItems;
      if (
        !isJsonRecord(customer) ||
        !hasNonEmptyStringFields(customer, ['name', 'email']) ||
        !isJsonRecord(shippingAddress) ||
        !hasNonEmptyStringFields(shippingAddress, [
          'street',
          'city',
          'state',
          'postalCode',
          'country',
        ]) ||
        !Array.isArray(lineItems) ||
        lineItems.length === 0 ||
        lineItems.some(
          (item) =>
            !isJsonRecord(item) ||
            !hasNonEmptyStringFields(item, ['sku', 'name']) ||
            typeof item.quantity !== 'number' ||
            !Number.isFinite(item.quantity) ||
            item.quantity <= 0 ||
            typeof item.price !== 'number' ||
            !Number.isFinite(item.price),
        )
      ) {
        throw new BadRequestException(
          'Verified CHECK context is missing customer, shippingAddress, or lineItems',
        );
      }
    }
  }

  async listApprovals(organizationId: string, status?: ApprovalStatus) {
    return this.prisma.approval.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        workflow: {
          select: {
            id: true,
            status: true,
            templateKey: true,
            templateVersion: true,
          },
        },
        workflowStep: {
          select: {
            id: true,
            key: true,
            name: true,
            status: true,
          },
        },
        decidedByUser: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });
  }

  async getApprovalDetail(organizationId: string, id: string) {
    const approval = await this.prisma.approval.findFirst({
      where: { id, organizationId },
      include: {
        workflow: {
          select: {
            id: true,
            status: true,
            templateKey: true,
            templateVersion: true,
          },
        },
        workflowStep: {
          select: {
            id: true,
            key: true,
            name: true,
            status: true,
          },
        },
        decidedByUser: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
        recoveryCase: {
          select: {
            id: true,
            summary: true,
            type: true,
            status: true,
          },
        },
      },
    });

    if (!approval) {
      throw new NotFoundException(`Approval ${id} not found`);
    }

    return approval;
  }

  async approveApproval(
    organizationId: string,
    id: string,
    actorUserId: string,
    note?: string,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Fetch approval with tenant scoping and linked workflow
      let approval = await tx.approval.findFirst({
        where: { id, organizationId },
        include: { workflow: true, workflowStep: true, recoveryCase: true },
      });

      if (!approval) {
        throw new NotFoundException(`Approval ${id} not found`);
      }

      // 1. Fetch and row-lock approval with tenant scoping
      const lockedApprovals = await tx.$queryRaw<{ id: string; status: ApprovalStatus }[]>`
        SELECT id, status FROM approvals
        WHERE id = ${id}::uuid
          AND organization_id = ${organizationId}::uuid
        FOR UPDATE
      `;
      const lockedApproval = lockedApprovals[0];
      if (!lockedApproval || lockedApproval.status !== ApprovalStatus.PENDING) {
        throw new ConflictException(
          'Approval has already been decided or is not pending',
        );
      }
      approval = (await tx.approval.findFirst({
        where: { id, organizationId },
        include: { workflow: true, workflowStep: true, recoveryCase: true },
      }))!;
      if (approval.expiresAt && approval.expiresAt <= new Date()) {
        throw new ConflictException('Approval has expired');
      }
      this.validateDecisionGraph(approval, organizationId);

      const lockedCases = await tx.$queryRaw<
        { id: string; status: RecoveryCaseStatus }[]
      >`
        SELECT id, status FROM recovery_cases
        WHERE id = ${approval.recoveryCaseId}::uuid
          AND organization_id = ${organizationId}::uuid
        FOR UPDATE
      `;
      const lockedCase = lockedCases[0];
      if (!lockedCase || lockedCase.status !== RecoveryCaseStatus.WAITING_APPROVAL) {
        throw new BadRequestException(
          `Cannot decide approval for recovery case in status: ${lockedCase?.status ?? 'UNKNOWN'}`,
        );
      }

      // 2. Row lock and fence Workflow: must be WAITING
      if (approval.workflowId) {
        const lockedWorkflows = await tx.$queryRaw<{ id: string; status: WorkflowStatus }[]>`
          SELECT id, status FROM workflows
          WHERE id = ${approval.workflowId}::uuid
            AND organization_id = ${organizationId}::uuid
          FOR UPDATE
        `;

        const lockedWf = lockedWorkflows[0];
        if (
          !lockedWf ||
          lockedWf.status !== WorkflowStatus.WAITING ||
          approval.workflow?.recoveryCaseId !== approval.recoveryCaseId
        ) {
          throw new BadRequestException(
            `Cannot decide approval for workflow in terminal/blocked status: ${lockedWf?.status ?? 'UNKNOWN'}`,
          );
        }
      }

      // 3. Row lock and fence WorkflowStep: must be WAITING
      if (approval.workflowStepId && approval.workflowId) {
        const lockedSteps = await tx.$queryRaw<{ id: string; status: WorkflowStepStatus }[]>`
          SELECT id, status FROM workflow_steps
          WHERE id = ${approval.workflowStepId}::uuid
            AND organization_id = ${organizationId}::uuid
            AND workflow_id = ${approval.workflowId}::uuid
          FOR UPDATE
        `;

        const lockedStep = lockedSteps[0];
        if (!lockedStep || lockedStep.status !== WorkflowStepStatus.WAITING) {
          throw new ConflictException(
            `Cannot decide approval for workflow step not in WAITING status: ${lockedStep?.status ?? 'UNKNOWN'}`,
          );
        }
      }

      const verifiedContext = await this.loadVerifiedContext(tx, approval);
      const decisionAt = new Date();
      const approvalOutput = {
        ...verifiedContext,
        approved: true,
        approvalId: approval.id,
        decidedAt: decisionAt.toISOString(),
      };

      // 4. Atomic CAS update on PENDING approval
      const rowsUpdated = await tx.$executeRaw`
        UPDATE approvals
        SET
          status = 'APPROVED'::"ApprovalStatus",
          decided_by_user_id = ${actorUserId}::uuid,
          decided_at = ${decisionAt},
          reason = ${note?.trim() || null},
          updated_at = NOW()
        WHERE
          id = ${id}::uuid
          AND organization_id = ${organizationId}::uuid
          AND status = 'PENDING'::"ApprovalStatus"
      `;

      if (rowsUpdated === 0) {
        throw new ConflictException(
          'Approval has already been decided or is not pending',
        );
      }

      // 5. Conditional CAS update on linked WorkflowStep: WAITING -> SUCCEEDED
      if (approval.workflowStepId && approval.workflowId) {
        const stepRows = await tx.$executeRaw`
          UPDATE workflow_steps
          SET
            status = 'SUCCEEDED'::"WorkflowStepStatus",
            output = ${JSON.stringify(approvalOutput)}::jsonb,
            completed_at = ${decisionAt},
            updated_at = NOW()
          WHERE
            id = ${approval.workflowStepId}::uuid
            AND organization_id = ${organizationId}::uuid
            AND workflow_id = ${approval.workflowId}::uuid
            AND status = 'WAITING'::"WorkflowStepStatus"
        `;

        if (stepRows === 0) {
          throw new ConflictException('Workflow step is no longer in WAITING status');
        }
      }

      // 6. Conditional CAS update on linked Workflow: WAITING -> RUNNING
      if (approval.workflowId) {
        const wfRows = await tx.$executeRaw`
          UPDATE workflows
          SET
            status = 'RUNNING'::"WorkflowStatus",
            updated_at = NOW()
          WHERE
            id = ${approval.workflowId}::uuid
            AND organization_id = ${organizationId}::uuid
            AND status = 'WAITING'::"WorkflowStatus"
        `;

        if (wfRows === 0) {
          throw new BadRequestException(
            'Cannot decide approval for workflow in terminal/blocked status',
          );
        }
      }

      const caseRows = await tx.$executeRaw`
        UPDATE recovery_cases
        SET
          status = 'RECOVERING'::"RecoveryCaseStatus",
          updated_at = NOW()
        WHERE
          id = ${approval.recoveryCaseId}::uuid
          AND organization_id = ${organizationId}::uuid
          AND status = 'WAITING_APPROVAL'::"RecoveryCaseStatus"
      `;
      if (caseRows === 0) {
        throw new ConflictException(
          'Recovery case is no longer waiting for approval',
        );
      }

      // 7. Atomic AuditLog creation in the same transaction
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId,
          entityType: 'APPROVAL',
          entityId: id,
          action: 'APPROVAL_APPROVED',
          metadata: {
            note: note?.trim() || null,
            workflowId: approval.workflowId,
            workflowStepId: approval.workflowStepId,
            recoveryCaseId: approval.recoveryCaseId,
          },
        },
      });

      // 8. Return fresh updated approval
      return tx.approval.findUnique({
        where: { id },
        include: {
          workflow: true,
          workflowStep: true,
          decidedByUser: {
            select: { id: true, email: true, name: true },
          },
        },
      });
    });

    // Post-commit safe realtime notification fanout (invalidation signals only)
    await this.realtimePublisher.publish({
      organizationId,
      eventType: 'recovery.approval_decided',
      resourceId: id,
      resourceType: 'APPROVAL',
      status: 'APPROVED',
      changedAt: new Date().toISOString(),
      reason: note?.trim() || undefined,
    });

    if (result?.recoveryCaseId) {
      await this.realtimePublisher.publish({
        organizationId,
        eventType: 'recovery.updated',
        resourceId: result.recoveryCaseId,
        resourceType: 'RECOVERY',
        status: RecoveryCaseStatus.RECOVERING,
        changedAt: new Date().toISOString(),
      });
    }

    await this.realtimePublisher.publish({
      organizationId,
      eventType: 'dashboard.changed',
      resourceType: 'DASHBOARD',
      changedAt: new Date().toISOString(),
    });

    return result;
  }

  async rejectApproval(
    organizationId: string,
    id: string,
    actorUserId: string,
    reason: string,
  ) {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new BadRequestException('Reason must not be empty');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Fetch approval with tenant scoping and linked workflow
      let approval = await tx.approval.findFirst({
        where: { id, organizationId },
        include: { workflow: true, workflowStep: true, recoveryCase: true },
      });

      if (!approval) {
        throw new NotFoundException(`Approval ${id} not found`);
      }

      // Lock approval row for update
      const lockedApprovals = await tx.$queryRaw<{ id: string; status: ApprovalStatus }[]>`
        SELECT id, status FROM approvals
        WHERE id = ${id}::uuid
          AND organization_id = ${organizationId}::uuid
        FOR UPDATE
      `;
      const lockedApproval = lockedApprovals[0];
      if (!lockedApproval || lockedApproval.status !== ApprovalStatus.PENDING) {
        throw new ConflictException(
          'Approval has already been decided or is not pending',
        );
      }
      approval = (await tx.approval.findFirst({
        where: { id, organizationId },
        include: { workflow: true, workflowStep: true, recoveryCase: true },
      }))!;
      if (approval.expiresAt && approval.expiresAt <= new Date()) {
        throw new ConflictException('Approval has expired');
      }
      this.validateDecisionGraph(approval, organizationId);

      const lockedCases = await tx.$queryRaw<
        { id: string; status: RecoveryCaseStatus }[]
      >`
        SELECT id, status FROM recovery_cases
        WHERE id = ${approval.recoveryCaseId}::uuid
          AND organization_id = ${organizationId}::uuid
        FOR UPDATE
      `;
      const lockedCase = lockedCases[0];
      if (!lockedCase || lockedCase.status !== RecoveryCaseStatus.WAITING_APPROVAL) {
        throw new BadRequestException(
          `Cannot decide approval for recovery case in status: ${lockedCase?.status ?? 'UNKNOWN'}`,
        );
      }

      // 2. Row lock and fence Workflow: must be WAITING
      if (approval.workflowId) {
        const lockedWorkflows = await tx.$queryRaw<{ id: string; status: WorkflowStatus }[]>`
          SELECT id, status FROM workflows
          WHERE id = ${approval.workflowId}::uuid
            AND organization_id = ${organizationId}::uuid
          FOR UPDATE
        `;

        const lockedWf = lockedWorkflows[0];
        if (
          !lockedWf ||
          lockedWf.status !== WorkflowStatus.WAITING ||
          approval.workflow?.recoveryCaseId !== approval.recoveryCaseId
        ) {
          throw new BadRequestException(
            `Cannot decide approval for workflow in terminal/blocked status: ${lockedWf?.status ?? 'UNKNOWN'}`,
          );
        }
      }

      // 3. Row lock and fence WorkflowStep: must be WAITING
      if (approval.workflowStepId && approval.workflowId) {
        const lockedSteps = await tx.$queryRaw<{ id: string; status: WorkflowStepStatus }[]>`
          SELECT id, status FROM workflow_steps
          WHERE id = ${approval.workflowStepId}::uuid
            AND organization_id = ${organizationId}::uuid
            AND workflow_id = ${approval.workflowId}::uuid
          FOR UPDATE
        `;

        const lockedStep = lockedSteps[0];
        if (!lockedStep || lockedStep.status !== WorkflowStepStatus.WAITING) {
          throw new ConflictException(
            `Cannot decide approval for workflow step not in WAITING status: ${lockedStep?.status ?? 'UNKNOWN'}`,
          );
        }
      }

      // 4. Atomic CAS update on PENDING approval
      const rowsUpdated = await tx.$executeRaw`
        UPDATE approvals
        SET
          status = 'REJECTED'::"ApprovalStatus",
          decided_by_user_id = ${actorUserId}::uuid,
          decided_at = NOW(),
          reason = ${trimmedReason},
          updated_at = NOW()
        WHERE
          id = ${id}::uuid
          AND organization_id = ${organizationId}::uuid
          AND status = 'PENDING'::"ApprovalStatus"
      `;

      if (rowsUpdated === 0) {
        throw new ConflictException(
          'Approval has already been decided or is not pending',
        );
      }

      // 5. Conditional CAS update on linked WorkflowStep: WAITING -> BLOCKED
      if (approval.workflowStepId && approval.workflowId) {
        const stepRows = await tx.$executeRaw`
          UPDATE workflow_steps
          SET
            status = 'BLOCKED'::"WorkflowStepStatus",
            completed_at = NOW(),
            updated_at = NOW()
          WHERE
            id = ${approval.workflowStepId}::uuid
            AND organization_id = ${organizationId}::uuid
            AND workflow_id = ${approval.workflowId}::uuid
            AND status = 'WAITING'::"WorkflowStepStatus"
        `;

        if (stepRows === 0) {
          throw new ConflictException('Workflow step is no longer in WAITING status');
        }
      }

      // 6. Conditional CAS update on linked Workflow: WAITING -> BLOCKED
      if (approval.workflowId) {
        const wfRows = await tx.$executeRaw`
          UPDATE workflows
          SET
            status = 'BLOCKED'::"WorkflowStatus",
            completed_at = NOW(),
            updated_at = NOW()
          WHERE
            id = ${approval.workflowId}::uuid
            AND organization_id = ${organizationId}::uuid
            AND status = 'WAITING'::"WorkflowStatus"
        `;

        if (wfRows === 0) {
          throw new BadRequestException(
            'Cannot decide approval for workflow in terminal/blocked status',
          );
        }
      }

      const caseRows = await tx.$executeRaw`
        UPDATE recovery_cases
        SET
          status = 'BLOCKED'::"RecoveryCaseStatus",
          updated_at = NOW()
        WHERE
          id = ${approval.recoveryCaseId}::uuid
          AND organization_id = ${organizationId}::uuid
          AND status = 'WAITING_APPROVAL'::"RecoveryCaseStatus"
      `;
      if (caseRows === 0) {
        throw new ConflictException(
          'Recovery case is no longer waiting for approval',
        );
      }

      // 7. Atomic AuditLog creation in the same transaction
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId,
          entityType: 'APPROVAL',
          entityId: id,
          action: 'APPROVAL_REJECTED',
          metadata: {
            reason: trimmedReason,
            workflowId: approval.workflowId,
            workflowStepId: approval.workflowStepId,
            recoveryCaseId: approval.recoveryCaseId,
          },
        },
      });

      // 8. Return fresh updated approval
      return tx.approval.findUnique({
        where: { id },
        include: {
          workflow: true,
          workflowStep: true,
          decidedByUser: {
            select: { id: true, email: true, name: true },
          },
        },
      });
    });

    // Post-commit safe realtime notification fanout (invalidation signals only)
    await this.realtimePublisher.publish({
      organizationId,
      eventType: 'recovery.approval_decided',
      resourceId: id,
      resourceType: 'APPROVAL',
      status: 'REJECTED',
      changedAt: new Date().toISOString(),
      reason: trimmedReason,
    });

    if (result?.recoveryCaseId) {
      await this.realtimePublisher.publish({
        organizationId,
        eventType: 'recovery.updated',
        resourceId: result.recoveryCaseId,
        resourceType: 'RECOVERY',
        status: RecoveryCaseStatus.BLOCKED,
        changedAt: new Date().toISOString(),
      });
    }

    await this.realtimePublisher.publish({
      organizationId,
      eventType: 'dashboard.changed',
      resourceType: 'DASHBOARD',
      changedAt: new Date().toISOString(),
    });

    return result;
  }
}
