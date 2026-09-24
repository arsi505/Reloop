import {
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  BadGatewayException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  ShipStationClient,
  ShipStationUnauthorizedError,
  ShipStationForbiddenError,
  ShipStationRateLimitError,
  ShipStationServerError,
  encryptCredentials,
} from '@reloop/connector-shipstation';
import { StoredShipStationCredential } from '@reloop/integration-sdk';
import { RealtimePublisher } from '../realtime/realtime.publisher';

export interface ConnectShipStationResult {
  success: boolean;
  integrationId: string;
  totalShipments: number;
}

@Injectable()
export class ShipStationConnectionService {
  private readonly logger = new Logger(ShipStationConnectionService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly realtimePublisher: RealtimePublisher,
  ) {
    this.encryptionKey =
      this.configService.get<string>('integrationEncryptionKey') ||
      process.env.INTEGRATION_ENCRYPTION_KEY ||
      '';
    if (!this.encryptionKey && process.env.NODE_ENV !== 'test') {
      this.logger.warn('INTEGRATION_ENCRYPTION_KEY is not set for ShipStationConnectionService');
    }
  }

  /**
   * Connects ShipStation integration:
   * 1. Validates API key using read-only test request (GET /v2/shipments?page=1&page_size=1).
   * 2. Encrypts API key with AES-256-GCM.
   * 3. Upserts Integration record in database.
   * 4. Logs audit event.
   * 5. Enqueues durable initial sync Job (SHIPSTATION_SYNC_SHIPMENTS).
   */
  async connect(
    organizationId: string,
    userId: string,
    apiKey: string,
    fetchFn?: typeof fetch,
  ): Promise<ConnectShipStationResult> {
    const trimmedKey = apiKey.trim();

    // 1. Validate API key against ShipStation V2
    const client = new ShipStationClient({
      apiKey: trimmedKey,
      fetchFn,
    });

    let totalShipments = 0;
    try {
      const testResult = await client.testConnection();
      totalShipments = testResult.totalShipments;
    } catch (err: unknown) {
      this.mapAndThrowError(err, 'connecting to ShipStation');
    }

    // 2. Encrypt credentials
    const credentialsToStore: StoredShipStationCredential = {
      apiKey: trimmedKey,
      keyId: 'v1',
      validatedAt: new Date().toISOString(),
    };

    const encryptedEnvelope = encryptCredentials(credentialsToStore, this.encryptionKey);

    // 3. Upsert Integration for organization and establish a durable sync-run identity
    const syncRunId = randomUUID();
    const existing = await this.prisma.integration.findFirst({
      where: {
        organizationId,
        provider: 'SHIPSTATION',
      },
    });

    let integrationId: string;
    if (existing) {
      const updated = await this.prisma.integration.update({
        where: { id: existing.id },
        data: {
          status: 'CONNECTED',
          name: 'ShipStation',
          mode: 'OBSERVE',
          encryptedCredentials: encryptedEnvelope as unknown as object,
          configuration: {
            ...((existing.configuration as Record<string, unknown>) || {}),
            connectedAt: new Date().toISOString(),
            initialSyncStatus: 'SYNCING',
            activeSyncRunId: syncRunId,
          },
        },
      });
      integrationId = updated.id;
    } else {
      const created = await this.prisma.integration.create({
        data: {
          organizationId,
          provider: 'SHIPSTATION',
          name: 'ShipStation',
          status: 'CONNECTED',
          mode: 'OBSERVE',
          encryptedCredentials: encryptedEnvelope as unknown as object,
          configuration: {
            connectedAt: new Date().toISOString(),
            initialSyncStatus: 'SYNCING',
            activeSyncRunId: syncRunId,
          },
        },
      });
      integrationId = created.id;
    }

    // 4. Record Audit Log
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: userId,
        entityType: 'INTEGRATION',
        entityId: integrationId,
        action: 'SHIPSTATION_INTEGRATION_CONNECTED',
        metadata: {
          provider: 'SHIPSTATION',
          totalShipments,
        },
      },
    });

    // 5. Enqueue Durable Initial Sync Job
    await this.prisma.job.create({
      data: {
        id: syncRunId,
        organizationId,
        type: 'SHIPSTATION_SYNC_SHIPMENTS',
        status: 'QUEUED',
        payload: {
          integrationId,
          syncRunId,
        },
        idempotencyKey: `shipstation_sync_run_${integrationId}_${syncRunId}`,
        nextRunAt: new Date(),
      },
    });

    // Safe invalidation event broadcast
    await this.realtimePublisher.publish({
      organizationId,
      eventType: 'integration.health_changed',
      resourceId: integrationId,
      resourceType: 'INTEGRATION',
      provider: 'SHIPSTATION',
      status: 'CONNECTED',
      changedAt: new Date().toISOString(),
    });
    await this.realtimePublisher.publish({
      organizationId,
      eventType: 'dashboard.changed',
      resourceType: 'DASHBOARD',
      changedAt: new Date().toISOString(),
    });

    return {
      success: true,
      integrationId,
      totalShipments,
    };
  }

  /**
   * Replaces credentials for an existing ShipStation integration.
   * Validates the new key first without touching existing working key.
   */
  async replaceCredentials(
    organizationId: string,
    userId: string,
    integrationId: string,
    newApiKey: string,
    fetchFn?: typeof fetch,
  ): Promise<{ success: boolean; integrationId: string }> {
    const integration = await this.prisma.integration.findFirst({
      where: {
        id: integrationId,
        organizationId,
        provider: 'SHIPSTATION',
      },
    });

    if (!integration) {
      throw new NotFoundException(`ShipStation integration ${integrationId} not found in this organization`);
    }

    const trimmedKey = newApiKey.trim();

    // 1. Validate NEW API key first (leaves existing key intact if validation fails)
    const client = new ShipStationClient({
      apiKey: trimmedKey,
      fetchFn,
    });

    try {
      await client.testConnection();
    } catch (err: unknown) {
      this.mapAndThrowError(err, 'validating replacement credentials for ShipStation');
    }

    // 2. Encrypt new credentials
    const credentialsToStore: StoredShipStationCredential = {
      apiKey: trimmedKey,
      keyId: 'v1',
      validatedAt: new Date().toISOString(),
    };

    const encryptedEnvelope = encryptCredentials(credentialsToStore, this.encryptionKey);

    // 3. Update integration
    await this.prisma.integration.update({
      where: { id: integrationId },
      data: {
        status: 'CONNECTED',
        encryptedCredentials: encryptedEnvelope as unknown as object,
        configuration: {
          ...((integration.configuration as Record<string, unknown>) || {}),
          credentialsReplacedAt: new Date().toISOString(),
        },
      },
    });

    // 4. Audit Log
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: userId,
        entityType: 'INTEGRATION',
        entityId: integrationId,
        action: 'SHIPSTATION_CREDENTIALS_REPLACED',
        metadata: {
          provider: 'SHIPSTATION',
        },
      },
    });

    // Safe invalidation event broadcast
    await this.realtimePublisher.publish({
      organizationId,
      eventType: 'integration.health_changed',
      resourceId: integrationId,
      resourceType: 'INTEGRATION',
      provider: 'SHIPSTATION',
      status: 'CONNECTED',
      changedAt: new Date().toISOString(),
    });
    await this.realtimePublisher.publish({
      organizationId,
      eventType: 'dashboard.changed',
      resourceType: 'DASHBOARD',
      changedAt: new Date().toISOString(),
    });

    return {
      success: true,
      integrationId,
    };
  }

  private mapAndThrowError(err: unknown, operation: string): never {
    if (err instanceof ShipStationUnauthorizedError) {
      throw new UnauthorizedException('Invalid ShipStation API key (401)');
    }
    if (err instanceof ShipStationForbiddenError) {
      throw new ForbiddenException('ShipStation API key has insufficient permissions (403)');
    }
    if (err instanceof ShipStationRateLimitError) {
      throw new BadGatewayException(`ShipStation rate limit encountered during ${operation}`);
    }
    if (err instanceof ShipStationServerError) {
      throw new BadGatewayException(`ShipStation server error encountered during ${operation}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new InternalServerErrorException(`Unexpected error during ${operation}: ${msg}`);
  }
}
