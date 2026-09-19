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
  WorkflowStatus,
  WorkflowStepStatus,
} from '@reloop/database';

@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

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
    return this.prisma.$transaction(async (tx) => {
      // 1. Fetch approval with tenant scoping and linked workflow
      const approval = await tx.approval.findFirst({
        where: { id, organizationId },
        include: { workflow: true, workflowStep: true },
      });

      if (!approval) {
        throw new NotFoundException(`Approval ${id} not found`);
      }

      if (approval.status !== ApprovalStatus.PENDING) {
        throw new ConflictException(
          'Approval has already been decided or is not pending',
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
        if (!lockedWf || lockedWf.status !== WorkflowStatus.WAITING) {
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
          status = 'APPROVED'::"ApprovalStatus",
          decided_by_user_id = ${actorUserId}::uuid,
          decided_at = NOW(),
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

    return this.prisma.$transaction(async (tx) => {
      // 1. Fetch approval with tenant scoping and linked workflow
      const approval = await tx.approval.findFirst({
        where: { id, organizationId },
        include: { workflow: true, workflowStep: true },
      });

      if (!approval) {
        throw new NotFoundException(`Approval ${id} not found`);
      }

      if (approval.status !== ApprovalStatus.PENDING) {
        throw new ConflictException(
          'Approval has already been decided or is not pending',
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
        if (!lockedWf || lockedWf.status !== WorkflowStatus.WAITING) {
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
  }
}
