import {
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
  WorkflowStatus,
} from '@reloop/database';

export interface RecentExceptionSummaryDto {
  id: string;
  type: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  status: RecoveryCaseStatus;
  summary: string;
  detectedAt: Date;
  externalOrderId: string | null;
  externalOrderNumber: string | null;
}

export interface IntegrationHealthSummaryDto {
  total: number;
  healthy: number;
  degraded: number;
  disconnected: number;
  syncing: number;
}

export interface RecentRecoveryActivityDto {
  workflowId: string;
  recoveryCaseId: string;
  caseType: RecoveryCaseType;
  templateKey: string;
  status: WorkflowStatus;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface DashboardSummaryDto {
  openExceptionsCount: number;
  casesRequiringApprovalCount: number;
  blockedCasesCount: number;
  autoInvestigateCasesCount: number;
  autoRecoveryCasesCount: number;
  resolvedCasesCount: number;
  failedCasesCount: number;
  totalExceptionsCount: number;
  recentExceptions: RecentExceptionSummaryDto[];
  integrationHealthSummary: IntegrationHealthSummaryDto;
  recentRecoveryActivity: RecentRecoveryActivityDto[];
}
