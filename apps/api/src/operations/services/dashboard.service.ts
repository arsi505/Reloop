import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RecoveryCaseStatus,
  RecoveryLevel,
} from '@reloop/database';
import {
  DashboardSummaryDto,
  RecentExceptionSummaryDto,
  IntegrationHealthSummaryDto,
  RecentRecoveryActivityDto,
} from '../dto/dashboard-summary.dto';
import { IntegrationHealthService } from './integration-health.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrationHealthService: IntegrationHealthService,
  ) {}

  /**
   * Aggregates tenant-scoped operational metrics using database-level aggregation.
   * Zero unbounded in-memory record loading.
   */
  async getDashboardSummary(organizationId: string): Promise<DashboardSummaryDto> {
    const openStatuses: RecoveryCaseStatus[] = [
      RecoveryCaseStatus.OPEN,
      RecoveryCaseStatus.INVESTIGATING,
      RecoveryCaseStatus.READY_FOR_RECOVERY,
      RecoveryCaseStatus.AUTO_RECOVERING,
      RecoveryCaseStatus.WAITING_APPROVAL,
      RecoveryCaseStatus.RECOVERING,
      RecoveryCaseStatus.VERIFYING,
    ];

    // Parallel aggregate count queries
    const [
      totalExceptionsCount,
      openExceptionsCount,
      casesRequiringApprovalCount,
      blockedCasesCount,
      autoInvestigateCasesCount,
      autoRecoveryCasesCount,
      resolvedCasesCount,
      failedCasesCount,
      recentCaseRecords,
      recentWorkflowRecords,
      integrationCards,
    ] = await Promise.all([
      this.prisma.recoveryCase.count({
        where: { organizationId },
      }),
      this.prisma.recoveryCase.count({
        where: { organizationId, status: { in: openStatuses } },
      }),
      this.prisma.recoveryCase.count({
        where: {
          organizationId,
          status: { in: openStatuses },
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        },
      }),
      this.prisma.recoveryCase.count({
        where: {
          organizationId,
          OR: [
            { status: RecoveryCaseStatus.BLOCKED },
            { recoveryLevel: RecoveryLevel.BLOCK },
          ],
        },
      }),
      this.prisma.recoveryCase.count({
        where: {
          organizationId,
          recoveryLevel: RecoveryLevel.AUTO_INVESTIGATE,
        },
      }),
      this.prisma.recoveryCase.count({
        where: {
          organizationId,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
        },
      }),
      this.prisma.recoveryCase.count({
        where: { organizationId, status: RecoveryCaseStatus.RESOLVED },
      }),
      this.prisma.recoveryCase.count({
        where: { organizationId, status: RecoveryCaseStatus.FAILED },
      }),
      // Top 5 recent exceptions
      this.prisma.recoveryCase.findMany({
        where: { organizationId },
        orderBy: { detectedAt: 'desc' },
        take: 5,
        include: {
          externalOrder: {
            select: {
              id: true,
              externalOrderNumber: true,
            },
          },
        },
      }),
      // Top 5 recent recovery workflows
      this.prisma.workflow.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          recoveryCase: {
            select: {
              id: true,
              type: true,
            },
          },
        },
      }),
      // Integration cards for health rollup
      this.integrationHealthService.listIntegrationCards(organizationId),
    ]);

    // Format recent exceptions
    const recentExceptions: RecentExceptionSummaryDto[] = recentCaseRecords.map((c) => ({
      id: c.id,
      type: c.type,
      recoveryLevel: c.recoveryLevel,
      status: c.status,
      summary: c.summary,
      detectedAt: c.detectedAt,
      externalOrderId: c.externalOrderId,
      externalOrderNumber: c.externalOrder?.externalOrderNumber || null,
    }));

    // Format integration health summary
    const integrationHealthSummary: IntegrationHealthSummaryDto = {
      total: integrationCards.length,
      healthy: integrationCards.filter((c) => c.health === 'HEALTHY').length,
      degraded: integrationCards.filter((c) => c.health === 'DEGRADED').length,
      disconnected: integrationCards.filter((c) => c.health === 'DISCONNECTED').length,
      syncing: integrationCards.filter((c) => c.health === 'SYNCING').length,
    };

    // Format recent recovery workflows
    const recentRecoveryActivity: RecentRecoveryActivityDto[] = recentWorkflowRecords.map((w) => ({
      workflowId: w.id,
      recoveryCaseId: w.recoveryCaseId,
      caseType: w.recoveryCase.type,
      templateKey: w.templateKey,
      status: w.status,
      startedAt: w.startedAt,
      completedAt: w.completedAt,
    }));

    return {
      openExceptionsCount,
      casesRequiringApprovalCount,
      blockedCasesCount,
      autoInvestigateCasesCount,
      autoRecoveryCasesCount,
      resolvedCasesCount,
      failedCasesCount,
      totalExceptionsCount,
      recentExceptions,
      integrationHealthSummary,
      recentRecoveryActivity,
    };
  }
}
