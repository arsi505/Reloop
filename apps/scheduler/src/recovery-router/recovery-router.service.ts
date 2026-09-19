import {
  PrismaClient,
  RecoveryCaseStatus,
  Workflow,
  WorkflowStatus,
} from '@prisma/client';
import { WorkflowCreationService, WorkflowWithSteps } from '../workflow-creator';
import { routeRecoveryPolicy, RoutingDecision } from './recovery-policy-router';

export interface RouteCaseResult {
  routed: boolean;
  action: string;
  reason: string;
  workflow?: WorkflowWithSteps | Workflow | null;
  decision?: RoutingDecision;
  reusedActiveWorkflow?: boolean;
}

export class RecoveryRouterService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly workflowCreationService: WorkflowCreationService,
  ) {}

  /**
   * Routes an active RecoveryCase to a versioned recovery workflow.
   * Features:
   * 1. Transactional advisory locking guarantees race-safe routing across concurrent processes.
   * 2. Idempotency: reuses existing active workflow for the same case.
   * 3. BLOCK level strictly creates ZERO Workflows, ZERO Jobs, ZERO Approvals.
   * 4. Safe tenant isolation (all operations scoped by organizationId).
   */
  async routeCase(caseId: string, organizationId: string): Promise<RouteCaseResult> {
    return await this.prisma.$transaction(async (tx) => {
      // 1. Transactional advisory lock per (orgId, caseId)
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext('reloop:recovery-routing:' || ${organizationId} || ':' || ${caseId}))
      `;

      // 2. Fetch RecoveryCase with tenant verification
      const recoveryCase = await tx.recoveryCase.findUnique({
        where: { id: caseId },
      });

      if (!recoveryCase) {
        throw new Error(`RecoveryCase ${caseId} does not exist`);
      }

      if (recoveryCase.organizationId !== organizationId) {
        throw new Error(
          `Tenant mismatch: RecoveryCase ${caseId} belongs to org ${recoveryCase.organizationId}, not requested org ${organizationId}`,
        );
      }

      // 3. If case is in terminal state, do not route
      if (
        recoveryCase.status === RecoveryCaseStatus.RESOLVED ||
        recoveryCase.status === RecoveryCaseStatus.FAILED
      ) {
        return {
          routed: false,
          action: 'TERMINAL_CASE',
          reason: `RecoveryCase ${caseId} is already in terminal state ${recoveryCase.status}`,
        };
      }

      // 4. Idempotency & Concurrency: Check for existing active workflow
      const existingActiveWorkflow = await tx.workflow.findFirst({
        where: {
          organizationId,
          recoveryCaseId: caseId,
          status: {
            in: [WorkflowStatus.PENDING, WorkflowStatus.RUNNING, WorkflowStatus.WAITING],
          },
        },
        include: { steps: { orderBy: { position: 'asc' } } },
      });

      if (existingActiveWorkflow) {
        return {
          routed: false,
          reusedActiveWorkflow: true,
          action: 'ACTIVE_WORKFLOW_REUSED',
          reason: `Active workflow ${existingActiveWorkflow.id} already exists for case ${caseId}`,
          workflow: existingActiveWorkflow,
        };
      }

      // 5. Evaluate deterministic recovery policy
      const decision = routeRecoveryPolicy(recoveryCase);

      // 6. If BLOCKED, transition case to BLOCKED and create ZERO workflows
      if (decision.action === 'BLOCKED') {
        await tx.recoveryCase.update({
          where: { id: caseId },
          data: { status: RecoveryCaseStatus.BLOCKED, updatedAt: new Date() },
        });

        return {
          routed: false,
          action: 'BLOCKED',
          reason: decision.reason,
          decision,
        };
      }

      // 7. If no templateKey assigned, return non-routed
      if (!decision.templateKey || !decision.templateVersion) {
        return {
          routed: false,
          action: decision.action,
          reason: decision.reason,
          decision,
        };
      }

      // 8. Create Workflow instance
      const orderNumber = recoveryCase.dedupeKey ? recoveryCase.dedupeKey.split(':')[0] : undefined;
      const workflow = await this.workflowCreationService.createWorkflowInstance({
        organizationId,
        templateKey: decision.templateKey,
        templateVersion: decision.templateVersion,
        recoveryCaseId: caseId,
        input: {
          caseId,
          orderNumber,
          category: recoveryCase.type,
          recoveryLevel: decision.recoveryLevel,
          evidence: recoveryCase.evidence,
        },
      });

      // 9. Update RecoveryCase status
      let nextStatus: RecoveryCaseStatus = RecoveryCaseStatus.INVESTIGATING;
      if (decision.recoveryLevel === 'AUTO_RECOVER') {
        nextStatus = RecoveryCaseStatus.AUTO_RECOVERING;
      } else if (decision.recoveryLevel === 'REQUIRE_APPROVAL') {
        nextStatus = RecoveryCaseStatus.WAITING_APPROVAL;
      }

      await tx.recoveryCase.update({
        where: { id: caseId },
        data: { status: nextStatus, updatedAt: new Date() },
      });

      return {
        routed: true,
        action: decision.action,
        reason: decision.reason,
        decision,
        workflow,
      };
    });
  }
}
