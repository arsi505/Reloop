import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  Integration,
  IntegrationProvider,
  Job,
  JobStatus,
  JobErrorCategory,
} from '@reloop/database';
import {
  IntegrationCardDto,
  IntegrationOperationsDetailDto,
  IntegrationHealthStatus,
  IntegrationLastErrorDto,
  IntegrationRecentSyncJobDto,
} from '../dto/integrations-operations.dto';

@Injectable()
export class IntegrationHealthService {
  private readonly logger = new Logger(IntegrationHealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lists all integrations for an organization as tenant-safe cards.
   */
  async listIntegrationCards(organizationId: string): Promise<IntegrationCardDto[]> {
    const integrations = await this.prisma.integration.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });

    const cards: IntegrationCardDto[] = [];
    for (const integration of integrations) {
      cards.push(await this.buildIntegrationCard(integration));
    }

    return cards;
  }

  /**
   * Retrieves operational detail for a specific integration.
   */
  async getIntegrationDetail(
    organizationId: string,
    integrationId: string,
  ): Promise<IntegrationOperationsDetailDto> {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(integrationId)) {
      throw new NotFoundException(`Integration ${integrationId} not found`);
    }

    const integration = await this.prisma.integration.findFirst({
      where: {
        id: integrationId,
        organizationId,
      },
    });

    if (!integration) {
      throw new NotFoundException(`Integration ${integrationId} not found`);
    }

    const card = await this.buildIntegrationCard(integration);

    // Query recent sync jobs (top 5)
    const syncJobType = this.getSyncJobTypeForProvider(integration.provider);
    const recentSyncJobs = syncJobType
      ? await this.prisma.job.findMany({
          where: {
            organizationId,
            type: syncJobType,
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        })
      : [];

    const formattedSyncJobs: IntegrationRecentSyncJobDto[] = recentSyncJobs.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      attemptCount: j.attemptCount,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
    }));

    // Query recent events count (last 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentEventsCount = await this.prisma.integrationEvent.count({
      where: {
        integrationId: integration.id,
        receivedAt: { gte: oneDayAgo },
      },
    });

    // Query associated recovery cases
    const associatedCasesCount = await this.prisma.recoveryCase.count({
      where: {
        sourceIntegrationId: integration.id,
      },
    });

    const activeCasesCount = await this.prisma.recoveryCase.count({
      where: {
        sourceIntegrationId: integration.id,
        status: { in: ['OPEN', 'INVESTIGATING', 'WAITING_APPROVAL', 'RECOVERING', 'VERIFYING'] },
      },
    });

    const rawConfig = (integration.configuration as Record<string, any>) || {};
    const safeConfiguration: Record<string, any> = {
      shopDomain: rawConfig.shopDomain || integration.shopDomain || undefined,
      provider: integration.provider,
      mode: integration.mode,
      syncWatermark: rawConfig.lastSuccessfulSyncWatermark || rawConfig.lastWatermark || null,
      syncIntervalMinutes: rawConfig.syncIntervalMinutes,
      safeCapabilityFlags: {
        readMonitored: true,
        mutationsDisabled: true,
      },
    };

    return {
      ...card,
      recentSyncJobs: formattedSyncJobs,
      recentEventsCount,
      associatedCasesCount,
      activeCasesCount,
      safeConfiguration,
    };
  }

  /**
   * Builds a safe IntegrationCardDto with deterministic health derivation.
   */
  async buildIntegrationCard(integration: Integration): Promise<IntegrationCardDto> {
    const syncJobType = this.getSyncJobTypeForProvider(integration.provider);

    // Fetch the latest sync job if applicable
    let latestSyncJob: Job | null = null;
    let latestSucceededJob: Job | null = null;

    if (syncJobType) {
      latestSyncJob = await this.prisma.job.findFirst({
        where: {
          organizationId: integration.organizationId,
          type: syncJobType,
        },
        orderBy: { createdAt: 'desc' },
      });

      latestSucceededJob = await this.prisma.job.findFirst({
        where: {
          organizationId: integration.organizationId,
          type: syncJobType,
          status: JobStatus.SUCCEEDED,
        },
        orderBy: { completedAt: 'desc' },
      });
    }

    // Determine health
    const health = this.deriveHealth(integration, latestSyncJob);

    // Determine last successful sync
    const lastSuccessfulSync = this.deriveLastSuccessfulSync(integration, latestSucceededJob);

    // Determine last error
    const lastError = await this.deriveLastError(integration, latestSyncJob);

    // Build safe identifier
    const safeIdentifier = this.getSafeIdentifier(integration);

    return {
      id: integration.id,
      provider: integration.provider,
      name: integration.name,
      status: integration.status,
      mode: integration.mode,
      health,
      safeIdentifier,
      readCapability: true,
      mutationCapability: false,
      lastSuccessfulSync,
      lastError,
      createdAt: integration.createdAt,
      updatedAt: integration.updatedAt,
    };
  }

  /**
   * Deterministic Health derivation:
   * 1. DISCONNECTED if status is DISCONNECTED.
   * 2. SYNCING if an active sync job is currently RUNNING.
   * 3. DEGRADED if status is DEGRADED/ERROR, or latest sync job is DEAD_LETTERED/FAILED, or has unrecovered errors.
   * 4. HEALTHY if status is CONNECTED and latest sync job is SUCCEEDED (or watermark exists without failure).
   */
  deriveHealth(integration: Integration, latestSyncJob: Job | null): IntegrationHealthStatus {
    if (integration.status === 'DISCONNECTED') {
      return 'DISCONNECTED';
    }

    if (integration.status === 'DEGRADED' || integration.status === 'ERROR') {
      return 'DEGRADED';
    }

    if (latestSyncJob) {
      if (latestSyncJob.status === JobStatus.RUNNING || latestSyncJob.status === JobStatus.CLAIMED) {
        return 'SYNCING';
      }

      if (
        latestSyncJob.status === JobStatus.DEAD_LETTERED ||
        latestSyncJob.status === JobStatus.FAILED
      ) {
        return 'DEGRADED';
      }
    }

    return 'HEALTHY';
  }

  /**
   * Authoritative Last Successful Sync from durable records:
   * 1. completedAt of latest SUCCEEDED sync job.
   * 2. Or watermark stored in configuration.
   */
  deriveLastSuccessfulSync(integration: Integration, latestSucceededJob: Job | null): Date | null {
    if (latestSucceededJob?.completedAt) {
      return latestSucceededJob.completedAt;
    }

    const config = (integration.configuration as Record<string, any>) || {};
    const watermarkStr = config.lastSuccessfulSyncWatermark || config.lastWatermark;
    if (watermarkStr) {
      const watermarkDate = new Date(watermarkStr);
      if (!isNaN(watermarkDate.getTime())) {
        return watermarkDate;
      }
    }

    return null;
  }

  /**
   * Derives safe, normalized last error without raw stack traces or internal secrets.
   */
  async deriveLastError(
    integration: Integration,
    latestSyncJob: Job | null,
  ): Promise<IntegrationLastErrorDto | null> {
    if (
      latestSyncJob &&
      (latestSyncJob.status === JobStatus.DEAD_LETTERED ||
        latestSyncJob.status === JobStatus.FAILED ||
        latestSyncJob.status === JobStatus.RETRY_WAITING)
    ) {
      // Find latest failed attempt
      const attempt = await this.prisma.jobAttempt.findFirst({
        where: {
          jobId: latestSyncJob.id,
          status: 'FAILED',
        },
        orderBy: { attemptNumber: 'desc' },
      });

      if (attempt) {
        return {
          category: this.mapErrorCategory(attempt.errorCategory, attempt.errorCode),
          occurredAt: attempt.finishedAt || attempt.createdAt,
          summary: this.sanitizeErrorMessage(attempt.errorMessage || 'Job execution failed'),
        };
      }
    }

    if (integration.status === 'DEGRADED') {
      return {
        category: 'AUTHENTICATION',
        occurredAt: integration.updatedAt,
        summary: 'Integration authentication or configuration requires re-authorization',
      };
    }

    return null;
  }

  private mapErrorCategory(
    category?: JobErrorCategory | null,
    errorCode?: string | null,
  ): IntegrationLastErrorDto['category'] {
    if (category === JobErrorCategory.RATE_LIMITED || errorCode === 'RATE_LIMITED') {
      return 'RATE_LIMITED';
    }
    if (category === JobErrorCategory.AUTH_ERROR || errorCode === '401' || errorCode === '403') {
      return 'AUTHENTICATION';
    }
    if (category === JobErrorCategory.TRANSIENT || errorCode === '503' || errorCode === '504') {
      return 'PROVIDER_UNAVAILABLE';
    }
    return 'SYNC_FAILED';
  }

  private sanitizeErrorMessage(msg: string): string {
    // Redact potential API keys or tokens
    return msg
      .replace(/api[-_]?key\s*[:=]\s*[a-zA-Z0-9_-]+/gi, 'api_key: [REDACTED]')
      .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/access[-_]?token\s*[:=]\s*[a-zA-Z0-9._-]+/gi, 'access_token: [REDACTED]')
      .slice(0, 200);
  }

  private getSafeIdentifier(integration: Integration): string {
    if (integration.provider === IntegrationProvider.SHOPIFY && integration.shopDomain) {
      return integration.shopDomain;
    }
    if (integration.provider === IntegrationProvider.SHIPSTATION) {
      return integration.status === 'CONNECTED' ? 'Credential configured' : 'Not configured';
    }
    return integration.name;
  }

  private getSyncJobTypeForProvider(provider: IntegrationProvider): string | null {
    switch (provider) {
      case IntegrationProvider.SHOPIFY:
        return 'SHOPIFY_SYNC_ORDERS';
      case IntegrationProvider.SHIPSTATION:
        return 'SHIPSTATION_SYNC_SHIPMENTS';
      default:
        return null;
    }
  }
}
