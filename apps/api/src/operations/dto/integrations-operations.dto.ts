import {
  IntegrationProvider,
  IntegrationStatus,
  OperationalMode,
} from '@reloop/database';

export type IntegrationHealthStatus = 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'SYNCING';

export interface IntegrationLastErrorDto {
  category: 'RATE_LIMITED' | 'AUTHENTICATION' | 'PROVIDER_UNAVAILABLE' | 'SYNC_FAILED' | 'UNKNOWN';
  occurredAt: Date;
  summary: string;
}

export interface IntegrationCardDto {
  id: string;
  provider: IntegrationProvider;
  name: string;
  status: IntegrationStatus;
  mode: OperationalMode;
  health: IntegrationHealthStatus;
  safeIdentifier: string;
  readCapability: boolean;
  mutationCapability: boolean;
  lastSuccessfulSync: Date | null;
  lastError: IntegrationLastErrorDto | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IntegrationRecentSyncJobDto {
  id: string;
  type: string;
  status: string;
  attemptCount: number;
  createdAt: Date;
  completedAt: Date | null;
}

export interface IntegrationOperationsDetailDto extends IntegrationCardDto {
  recentSyncJobs: IntegrationRecentSyncJobDto[];
  recentEventsCount: number;
  associatedCasesCount: number;
  activeCasesCount: number;
  safeConfiguration: Record<string, any>;
}
