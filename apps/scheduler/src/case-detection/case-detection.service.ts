import {
  Prisma,
  PrismaClient,
  RecoveryCase,
  RecoveryCaseStatus,
  RecoveryCaseType,
  RecoveryLevel,
} from '@prisma/client';
import { ReconciliationFinding } from '@reloop/reconciliation-core';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CaseDetectionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Persists reconciliation findings as RecoveryCase instances.
   * Features:
   * 1. Deterministic deduplication by (organizationId, dedupeKey).
   * 2. Transactional advisory locking to guarantee safe concurrency across racing detector instances.
   * 3. Reuses active non-terminal cases (updates evidence and summary).
   * 4. Treats recurrences of resolved/failed cases as new distinct incidents.
   * 5. Strict tenant isolation (all operations scoped by organizationId).
   * 6. Strictly creates ZERO Jobs, ZERO Approvals, ZERO Workflows.
   */
  async persistFindings(
    organizationId: string,
    findings: ReconciliationFinding[],
    externalOrderId?: string,
  ): Promise<RecoveryCase[]> {
    if (!findings || findings.length === 0) {
      return [];
    }

    const validExternalOrderId =
      externalOrderId && UUID_REGEX.test(externalOrderId)
        ? externalOrderId
        : null;

    const persistedCases: RecoveryCase[] = [];

    for (const finding of findings) {
      const orderNumber = finding.orderIdentity.orderNumber || 'system';
      const dedupeKey = `${orderNumber}:${finding.category}`;

      // Lock per (organizationId, dedupeKey) using postgres advisory xact lock
      const recoveryCase = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext('reloop:case:' || ${organizationId} || ':' || ${dedupeKey}))
        `;

        // Check for active (non-terminal) case for this dedupeKey
        const existingActive = await tx.recoveryCase.findFirst({
          where: {
            organizationId,
            dedupeKey,
            status: {
              notIn: [RecoveryCaseStatus.RESOLVED, RecoveryCaseStatus.FAILED],
            },
          },
        });

        if (existingActive) {
          // Rule 23 & 26: Reuse existing active case; refresh evidence and summary
          const updated = await tx.recoveryCase.update({
            where: { id: existingActive.id },
            data: {
              summary: finding.summary,
              recoveryLevel: finding.recoveryLevel as RecoveryLevel,
              evidence: finding.evidence as unknown as Prisma.InputJsonValue,
              updatedAt: new Date(),
            },
          });
          return updated;
        }

        // Rule 27: No active case exists (or previous case was RESOLVED/FAILED).
        // Create a new incident case.
        const created = await tx.recoveryCase.create({
          data: {
            organizationId,
            externalOrderId: validExternalOrderId,
            dedupeKey,
            type: finding.category as RecoveryCaseType,
            recoveryLevel: finding.recoveryLevel as RecoveryLevel,
            status: RecoveryCaseStatus.OPEN,
            summary: finding.summary,
            evidence: finding.evidence as unknown as Prisma.InputJsonValue,
            detectedAt: new Date(),
          },
        });

        return created;
      });

      persistedCases.push(recoveryCase);
    }

    return persistedCases;
  }
}
