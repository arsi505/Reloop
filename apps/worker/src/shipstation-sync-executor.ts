import { Prisma, PrismaClient, JobErrorCategory } from '@prisma/client';
import {
  ShipStationClient,
  normalizeShipStationShipment,
  normalizeShipStationLabel,
  NormalizedShipStationLabel,
  NormalizedShipStationShipment,
  decryptCredentials,
  ShipStationRateLimitError,
  ShipStationServerError,
  ShipStationUnauthorizedError,
  ShipStationNotFoundError,
  ShipStationError,
} from '@reloop/connector-shipstation';
import { EncryptedCredentialEnvelope, StoredShipStationCredential } from '@reloop/integration-sdk';
import { JobContext } from './executor';
import { JobExecutionError } from './errors';
import {
  establishSyncRun,
  failCurrentSyncRun,
  withCurrentSyncRunTransaction,
} from './sync-run-state';

export interface ShipStationSyncExecutorOptions {
  encryptionKey?: string;
  defaultMaxShipments?: number;
  fetchFn?: typeof fetch;
}

export interface ShipStationSyncJobResult {
  integrationId: string;
  totalShipmentsSynced: number;
  pagesProcessed: number;
  complete: boolean;
  watermarkAdvancedTo?: string;
  nextPage?: number | null;
  continuationJobId?: string | null;
  syncRunId: string;
  currentRun: boolean;
}

export class ShipStationSyncJobExecutor {
  private prisma: PrismaClient;
  private encryptionKey: string;
  private defaultMaxShipments: number;
  private fetchFn?: typeof fetch;

  constructor(prisma: PrismaClient, options: ShipStationSyncExecutorOptions = {}) {
    this.prisma = prisma;
    this.encryptionKey = options.encryptionKey || process.env.INTEGRATION_ENCRYPTION_KEY || '';
    this.defaultMaxShipments = options.defaultMaxShipments || 250;
    this.fetchFn = options.fetchFn;
  }

  async execute(context: JobContext): Promise<ShipStationSyncJobResult> {
    const payload = (context.payload as Record<string, any>) || {};
    const integrationId = payload.integrationId as string;

    if (!integrationId) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'MISSING_INTEGRATION_ID',
        message: `Job ${context.jobId} missing required integrationId in payload`,
        retryable: false,
      });
    }

    // 1. Load Integration from PostgreSQL
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
    });

    if (!integration) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'INTEGRATION_NOT_FOUND',
        message: `Integration ${integrationId} not found in database`,
        retryable: false,
      });
    }

    // 2. Authoritative verification of organization ownership
    if (integration.organizationId !== context.organizationId) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'ORGANIZATION_MISMATCH',
        message: `Integration ${integrationId} organization ${integration.organizationId} does not match job organization ${context.organizationId}`,
        retryable: false,
      });
    }

    // 3. Verify provider
    if (integration.provider !== 'SHIPSTATION') {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'PROVIDER_MISMATCH',
        message: `Integration ${integrationId} provider is ${integration.provider}, expected SHIPSTATION`,
        retryable: false,
      });
    }

    // 4. Verify integration status
    if (integration.status === 'DISCONNECTED') {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'INTEGRATION_DISCONNECTED',
        message: `Integration ${integrationId} is DISCONNECTED; sync cancelled`,
        retryable: false,
      });
    }

    const runState = await establishSyncRun(
      this.prisma,
      integrationId,
      payload.syncRunId,
      context.jobId,
    );
    const syncRunId = runState.syncRunId;
    if (!runState.current) {
      return {
        integrationId: integration.id,
        totalShipmentsSynced: 0,
        pagesProcessed: 0,
        complete: false,
        continuationJobId: null,
        syncRunId,
        currentRun: false,
      };
    }

    // 5. Decrypt credentials inside execution boundary
    if (!integration.encryptedCredentials) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'MISSING_CREDENTIALS',
        message: `Integration ${integrationId} has no stored encrypted credentials`,
        retryable: false,
      });
    }

    let creds: StoredShipStationCredential;
    try {
      creds = decryptCredentials<StoredShipStationCredential>(
        integration.encryptedCredentials as unknown as EncryptedCredentialEnvelope,
        this.encryptionKey,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'CREDENTIAL_DECRYPTION_FAILED',
        message: `Failed to decrypt credentials for integration ${integrationId}: ${msg}`,
        retryable: false,
      });
    }

    if (!creds || !creds.apiKey) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'INVALID_CREDENTIAL_PAYLOAD',
        message: `Integration ${integrationId} decrypted credentials missing apiKey`,
        retryable: false,
      });
    }

    // 6. Initialize read-only ShipStation client
    const client = new ShipStationClient({
      apiKey: creds.apiKey,
      fetchFn: this.fetchFn,
    });

    const maxShipments = payload.maxShipments || this.defaultMaxShipments;
    let totalSynced = 0;
    let pagesProcessed = 0;
    let currentPage = typeof payload.page === 'number' && payload.page >= 1 ? payload.page : 1;
    let hasMorePages = false;

    // Incremental sync windowing with 5-minute safety overlap
    const currentConfig = (integration.configuration as Record<string, any>) || {};
    const lastWatermark = currentConfig.lastSuccessfulSyncWatermark as string | undefined;
    const OVERLAP_MS = 5 * 60 * 1000; // 5 minutes

    let modifiedAtStart = payload.modifiedAtStart as string | undefined;
    if (!modifiedAtStart && lastWatermark) {
      const wmDate = new Date(lastWatermark);
      if (!isNaN(wmDate.getTime())) {
        modifiedAtStart = new Date(Math.max(0, wmDate.getTime() - OVERLAP_MS)).toISOString();
      }
    }
    const modifiedAtEnd = (payload.modifiedAtEnd as string | undefined) || new Date().toISOString();

    let latestModifiedAtObserved: Date | undefined = lastWatermark ? new Date(lastWatermark) : undefined;

    try {
      // Preferred Label Fetch Architecture:
      // Query labels in paginated batches for the bounded sync window rather than N+1 per-shipment calls.
      const bulkLabelsByShipmentId = new Map<string, NormalizedShipStationLabel[]>();
      let labelPage = 1;
      const maxLabelPages = Math.max(1, Math.ceil(maxShipments / 25)); // bounded label pagination ceiling
      try {
        while (labelPage <= maxLabelPages) {
          const labelPageRes = await client.listLabels({
            page: labelPage,
            pageSize: 50,
            createdAtStart: modifiedAtStart,
            createdAtEnd: modifiedAtEnd,
            sortBy: 'created_at',
            sortDir: 'asc',
          });

          if (!labelPageRes.labels || labelPageRes.labels.length === 0) {
            break;
          }

          for (const rawLabel of labelPageRes.labels) {
            const normalizedLabel = normalizeShipStationLabel(rawLabel);
            if (normalizedLabel.shipmentId) {
              const sid = String(normalizedLabel.shipmentId);
              const list = bulkLabelsByShipmentId.get(sid) || [];
              list.push(normalizedLabel);
              bulkLabelsByShipmentId.set(sid, list);
            }
          }

          if (labelPage >= (labelPageRes.pages || 1)) {
            break;
          }
          labelPage++;
        }
      } catch (err: unknown) {
        if (!(err instanceof ShipStationNotFoundError)) {
          throw err;
        }
      }

      while (totalSynced < maxShipments) {
        pagesProcessed++;
        const pageSize = Math.min(50, maxShipments - totalSynced);

        const pageRes = await client.listShipments({
          page: currentPage,
          pageSize,
          modifiedAtStart,
          modifiedAtEnd,
          sortBy: 'modified_at',
          sortDir: 'asc',
        });

        if (pageRes.page !== currentPage) {
          await failCurrentSyncRun(
            this.prisma,
            integrationId,
            syncRunId,
            'SHIPSTATION_SYNC_NO_PROGRESS',
          );
          throw new JobExecutionError({
            category: JobErrorCategory.BUSINESS_ERROR,
            code: 'SHIPSTATION_SYNC_NO_PROGRESS',
            message: `ShipStation pagination did not advance as requested for integration ${integrationId}`,
            retryable: false,
          });
        }

        if (!pageRes.shipments || pageRes.shipments.length === 0) {
          break;
        }

        // Fetch and normalize provider state before opening the projection transaction.
        // PostgreSQL then serializes each shipment projection against run activation.
        for (const rawShipment of pageRes.shipments) {
          const normalized = normalizeShipStationShipment(rawShipment);

          // Track newest modified timestamp for checkpointing
          if (normalized.updatedAt) {
            if (!latestModifiedAtObserved || normalized.updatedAt > latestModifiedAtObserved) {
              latestModifiedAtObserved = normalized.updatedAt;
            }
          }

          const sid = String(normalized.shipmentId);
          let labelsList: NormalizedShipStationLabel[] = [];

          if (bulkLabelsByShipmentId.has(sid)) {
            labelsList = bulkLabelsByShipmentId.get(sid)!;
          } else if (normalized.status === 'LABEL_CREATED') {
            // Targeted fallback lookup:
            // Only used when a shipment indicates label_purchased intent but
            // its label was not established during bulk window pagination.
            try {
              const fallbackRes = await client.listLabels({ shipmentId: normalized.shipmentId });
              if (fallbackRes.labels && fallbackRes.labels.length > 0) {
                labelsList = fallbackRes.labels
                  .filter((l) => String(l.shipment_id) === sid)
                  .map((l) => normalizeShipStationLabel(l));
              }
            } catch (err: unknown) {
              if (!(err instanceof ShipStationNotFoundError)) {
                throw err;
              }
            }
          }

          const projection = await withCurrentSyncRunTransaction(
            this.prisma,
            integrationId,
            syncRunId,
            async (tx) => {
              await this.projectShipment(
                tx,
                integration.organizationId,
                integration.id,
                normalized,
                labelsList,
              );
            },
          );
          if (!projection.current) {
            return {
              integrationId: integration.id,
              totalShipmentsSynced: totalSynced,
              pagesProcessed,
              complete: false,
              nextPage: currentPage,
              continuationJobId: null,
              syncRunId,
              currentRun: false,
            };
          }
          totalSynced++;
        }

        const totalPages = pageRes.pages || 1;
        if (currentPage >= totalPages) {
          hasMorePages = false;
          break;
        }

        hasMorePages = true;
        currentPage++;
      }
    } catch (err: unknown) {
      if (err instanceof ShipStationRateLimitError) {
        throw new JobExecutionError({
          category: JobErrorCategory.RATE_LIMITED,
          code: 'SHIPSTATION_RATE_LIMIT',
          message: err.message,
          retryable: true,
          retryAfterMs: (err.retryAfterSeconds || 5) * 1000,
        });
      }

      if (err instanceof ShipStationUnauthorizedError) {
        // Mark integration DEGRADED
        await this.prisma.integration.updateMany({
          where: {
            id: integrationId,
            configuration: { path: ['activeSyncRunId'], equals: syncRunId },
          },
          data: { status: 'DEGRADED' },
        });

        await this.prisma.auditLog.create({
          data: {
            organizationId: integration.organizationId,
            entityType: 'INTEGRATION',
            entityId: integrationId,
            action: 'SHIPSTATION_INTEGRATION_REAUTH_REQUIRED',
            metadata: {
              reason: 'HTTP 401 Unauthorized during sync',
            },
          },
        });

        throw new JobExecutionError({
          category: JobErrorCategory.BUSINESS_ERROR,
          code: 'SHIPSTATION_AUTH_FAILED',
          message: err.message,
          retryable: false,
        });
      }

      if (err instanceof ShipStationServerError) {
        throw new JobExecutionError({
          category: JobErrorCategory.TRANSIENT,
          code: 'SHIPSTATION_SERVER_TRANSIENT',
          message: err.message,
          retryable: true,
        });
      }

      if (err instanceof ShipStationError) {
        throw new JobExecutionError({
          category: err.isTransient ? JobErrorCategory.TRANSIENT : JobErrorCategory.BUSINESS_ERROR,
          code: 'SHIPSTATION_API_ERROR',
          message: err.message,
          retryable: err.isTransient,
        });
      }

      throw err;
    }

    // 7. Evaluate truthful completion invariant:
    // complete = true ONLY IF provider reports no further pages.
    // An unconditional expression like `totalSynced >= maxShipments || true` must NEVER be used.
    // Reaching maxShipments cap represents bounded work completion, NOT provider sync completion.
    const complete = !hasMorePages;

    if (hasMorePages) {
      if (currentPage <= (typeof payload.page === 'number' ? payload.page : 0)) {
        await failCurrentSyncRun(
          this.prisma,
          integrationId,
          syncRunId,
          'SHIPSTATION_SYNC_NO_PROGRESS',
        );
        throw new JobExecutionError({
          category: JobErrorCategory.BUSINESS_ERROR,
          code: 'SHIPSTATION_SYNC_NO_PROGRESS',
          message: `ShipStation continuation page did not advance for integration ${integrationId}`,
          retryable: false,
        });
      }
    }

    const newWatermark = latestModifiedAtObserved
      ? latestModifiedAtObserved.toISOString()
      : modifiedAtEnd;

    const finalization = await withCurrentSyncRunTransaction(
      this.prisma,
      integrationId,
      syncRunId,
      async (tx, latestConfig) => {
        let continuationJobId: string | null = null;
        if (hasMorePages) {
          const continuationIdempotencyKey = `shipstation_sync_continuation_${integration.id}_${syncRunId}_page_${currentPage}`;
          const continuationJob = await tx.job.upsert({
            where: {
              organizationId_idempotencyKey: {
                organizationId: integration.organizationId,
                idempotencyKey: continuationIdempotencyKey,
              },
            },
            update: { updatedAt: new Date() },
            create: {
              organizationId: integration.organizationId,
              type: 'SHIPSTATION_SYNC_SHIPMENTS',
              status: 'QUEUED',
              priority: 50,
              payload: {
                integrationId: integration.id,
                syncRunId,
                page: currentPage,
                maxShipments,
                modifiedAtStart,
                modifiedAtEnd,
                parentJobId: context.jobId,
              },
              idempotencyKey: continuationIdempotencyKey,
              nextRunAt: new Date(),
            },
            select: { id: true },
          });
          continuationJobId = continuationJob.id;
        }

        await tx.integration.update({
          where: { id: integrationId },
          data: {
            configuration: {
              ...latestConfig,
              activeSyncRunId: syncRunId,
              initialSyncStatus: complete ? 'COMPLETED' : 'SYNCING',
              lastSyncAt: new Date().toISOString(),
              lastSyncShipmentsCount:
                !payload.page || payload.page === 1
                  ? totalSynced
                  : Number(latestConfig.lastSyncShipmentsCount || 0) + totalSynced,
              continuationPage: complete ? null : currentPage,
              lastSuccessfulSyncWatermark: newWatermark,
            },
          },
        });
        return continuationJobId;
      },
    );

    if (!finalization.current) {
      return {
        integrationId: integration.id,
        totalShipmentsSynced: totalSynced,
        pagesProcessed,
        complete: false,
        nextPage: currentPage,
        continuationJobId: null,
        syncRunId,
        currentRun: false,
      };
    }
    const continuationJobId = finalization.result || null;

    // 9. Return safe result metadata (ZERO secrets)
    return {
      integrationId: integration.id,
      totalShipmentsSynced: totalSynced,
      pagesProcessed,
      complete,
      nextPage: complete ? undefined : currentPage,
      continuationJobId,
      watermarkAdvancedTo: newWatermark,
      syncRunId,
      currentRun: true,
    };
  }

  private async projectShipment(
    tx: Prisma.TransactionClient,
    organizationId: string,
    integrationId: string,
    normalized: NormalizedShipStationShipment,
    labels: NormalizedShipStationLabel[],
  ): Promise<void> {
    let externalOrder = await tx.externalOrder.findUnique({
      where: {
        organizationId_externalOrderNumber: {
          organizationId,
          externalOrderNumber: normalized.orderNumber,
        },
      },
    });

    const targetOrderStatus =
      normalized.status === 'CANCELLED'
        ? 'CANCELLED'
        : normalized.status === 'LABEL_CREATED'
          ? 'FULFILLING'
          : 'READY_FOR_FULFILLMENT';

    if (!externalOrder) {
      externalOrder = await tx.externalOrder.create({
        data: {
          organizationId,
          primaryIntegrationId: integrationId,
          externalOrderNumber: normalized.orderNumber,
          status: targetOrderStatus,
          sourceCreatedAt: normalized.createdAt,
          lastObservedAt: normalized.updatedAt || new Date(),
        },
      });
    } else {
      const isNewer =
        !externalOrder.lastObservedAt || normalized.updatedAt >= externalOrder.lastObservedAt;
      await tx.externalOrder.update({
        where: { id: externalOrder.id },
        data: {
          ...(isNewer ? { status: targetOrderStatus } : {}),
          lastObservedAt: isNewer ? normalized.updatedAt : externalOrder.lastObservedAt,
        },
      });
    }

    await tx.externalReference.upsert({
      where: {
        organizationId_integrationId_resourceType_externalId: {
          organizationId,
          integrationId,
          resourceType: 'SHIPMENT',
          externalId: normalized.shipmentId,
        },
      },
      update: {
        externalReference: normalized.shipmentNumber || normalized.externalShipmentId || null,
        updatedAt: new Date(),
      },
      create: {
        organizationId,
        integrationId,
        externalOrderId: externalOrder.id,
        resourceType: 'SHIPMENT',
        externalId: normalized.shipmentId,
        externalReference: normalized.shipmentNumber || normalized.externalShipmentId || null,
      },
    });

    for (const label of labels) {
      const labelPayload = JSON.stringify({
        trackingNumber: label.trackingNumber,
        voided: label.voided,
        carrierCode: label.carrierCode,
        serviceCode: label.serviceCode,
        status: label.status,
        trackingStatus: label.trackingStatus,
      });
      await tx.externalReference.upsert({
        where: {
          organizationId_integrationId_resourceType_externalId: {
            organizationId,
            integrationId,
            resourceType: 'LABEL',
            externalId: label.labelId,
          },
        },
        update: { externalReference: labelPayload, updatedAt: new Date() },
        create: {
          organizationId,
          integrationId,
          externalOrderId: externalOrder.id,
          resourceType: 'LABEL',
          externalId: label.labelId,
          externalReference: labelPayload,
        },
      });
    }

    const activeLabels = labels.filter(
      (label) =>
        !label.voided && Boolean(label.trackingNumber && label.trackingNumber.trim()),
    );
    for (const activeLabel of activeLabels) {
      await tx.externalReference.upsert({
        where: {
          organizationId_integrationId_resourceType_externalId: {
            organizationId,
            integrationId,
            resourceType: 'TRACKING',
            externalId: activeLabel.trackingNumber,
          },
        },
        update: {
          externalReference: activeLabel.carrierCode || null,
          updatedAt: new Date(),
        },
        create: {
          organizationId,
          integrationId,
          externalOrderId: externalOrder.id,
          resourceType: 'TRACKING',
          externalId: activeLabel.trackingNumber,
          externalReference: activeLabel.carrierCode || null,
        },
      });
    }
  }
}
