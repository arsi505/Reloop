import {
  PrismaClient,
  Prisma,
  RecoveryCase,
  RecoveryCaseStatus,
  WorkflowStepStatus,
} from '@prisma/client';

export interface ResolveCaseParams {
  caseId: string;
  organizationId: string;
  workflowId: string;
  verifyStepKey?: string;
  verificationOutput: {
    verified: boolean;
    invariantPassed: string;
    authoritativeState?: Record<string, unknown>;
    details?: Record<string, unknown>;
  };
}

export class CaseResolutionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Atomically marks a RecoveryCase as RESOLVED.
   * Required Guards:
   * 1. Linked workflow VERIFY step MUST be in SUCCEEDED status.
   * 2. Verification output explicitly confirms verified invariant passed.
   * 3. Preserves original detection evidence and appends resolution evidence.
   */
  async resolveCase(params: ResolveCaseParams): Promise<RecoveryCase> {
    const {
      caseId,
      organizationId,
      workflowId,
      verifyStepKey = 'VERIFY',
      verificationOutput,
    } = params;

    if (!verificationOutput || !verificationOutput.verified || !verificationOutput.invariantPassed) {
      throw new Error(
        `Cannot resolve RecoveryCase ${caseId}: verification output does not confirm verified invariant.`,
      );
    }

    return await this.prisma.$transaction(async (tx) => {
      // 1. Transactional advisory lock
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext('reloop:case-resolution:' || ${organizationId} || ':' || ${caseId}))
      `;

      // 2. Fetch RecoveryCase with tenant check
      const recoveryCase = await tx.recoveryCase.findUnique({
        where: { id: caseId },
      });

      if (!recoveryCase) {
        throw new Error(`RecoveryCase ${caseId} does not exist`);
      }

      if (recoveryCase.organizationId !== organizationId) {
        throw new Error(
          `Tenant mismatch: RecoveryCase ${caseId} does not belong to organization ${organizationId}`,
        );
      }

      if (recoveryCase.status === RecoveryCaseStatus.RESOLVED) {
        return recoveryCase;
      }

      // 3. Verify linked workflow VERIFY step succeeded
      const verifyStep = await tx.workflowStep.findFirst({
        where: {
          workflowId,
          organizationId,
          key: verifyStepKey,
        },
      });

      if (!verifyStep) {
        throw new Error(
          `Cannot resolve RecoveryCase ${caseId}: verify step "${verifyStepKey}" not found on workflow ${workflowId}`,
        );
      }

      if (verifyStep.status !== WorkflowStepStatus.SUCCEEDED) {
        throw new Error(
          `Cannot resolve RecoveryCase ${caseId}: verify step status is "${verifyStep.status}", expected SUCCEEDED`,
        );
      }

      // 4. Merge verification evidence with existing detection evidence
      const existingEvidence = (recoveryCase.evidence as Record<string, unknown>) || {};
      const updatedEvidence = {
        ...existingEvidence,
        resolution: {
          resolvedAt: new Date().toISOString(),
          resolvedByWorkflowId: workflowId,
          invariantPassed: verificationOutput.invariantPassed,
          authoritativeState: verificationOutput.authoritativeState,
          details: verificationOutput.details,
        },
      };

      // 5. Update RecoveryCase to RESOLVED
      const updatedCase = await tx.recoveryCase.update({
        where: { id: caseId },
        data: {
          status: RecoveryCaseStatus.RESOLVED,
          resolvedAt: new Date(),
          evidence: updatedEvidence as unknown as Prisma.InputJsonValue,
          updatedAt: new Date(),
        },
      });

      return updatedCase;
    });
  }
}
