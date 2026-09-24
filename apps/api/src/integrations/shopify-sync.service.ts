import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyTokenRefreshService } from './shopify-token-refresh.service';
import {
  ShopifyClient,
  normalizeShopifyOrder,
} from '@reloop/connector-shopify';

export interface SyncResult {
  integrationId: string;
  shopDomain: string;
  totalOrdersSynced: number;
  pagesProcessed: number;
  complete: boolean;
  nextCursor?: string | null;
}

@Injectable()
export class ShopifySyncService {
  private readonly logger = new Logger(ShopifySyncService.name);
  private readonly defaultMaxOrders: number;
  private readonly apiVersion: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly tokenRefresh: ShopifyTokenRefreshService,
  ) {
    this.defaultMaxOrders =
      this.configService.get<number>('shopifyInitialSyncMaxOrders') || 250;
    this.apiVersion = this.configService.get<string>('shopifyApiVersion') || '2026-07';
  }

  /**
   * Executes a read-only synchronization of recent orders from Shopify.
   * Uses GraphQL cursor pagination and idempotent database projection.
   */
  async syncRecentOrders(
    integrationId: string,
    options?: { maxOrders?: number; fetchFn?: typeof fetch; cursor?: string },
  ): Promise<SyncResult> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
    });

    if (!integration) {
      throw new NotFoundException(`Integration ${integrationId} not found`);
    }

    const shopDomain = integration.shopDomain;
    if (!shopDomain) {
      throw new NotFoundException(`Integration ${integrationId} does not have a shopDomain`);
    }

    const maxOrders = options?.maxOrders || this.defaultMaxOrders;

    // 1. Obtain valid access token (refreshed if needed)
    const accessToken = await this.tokenRefresh.getValidAccessToken(
      integrationId,
      options?.fetchFn,
    );

    // 2. Initialize read-only client
    const client = new ShopifyClient({
      shopDomain,
      accessToken,
      apiVersion: this.apiVersion,
      fetchFn: options?.fetchFn,
    });

    let hasNextPage = true;
    let endCursor: string | null = options?.cursor || null;
    let totalSynced = 0;
    let pagesProcessed = 0;
    const seenCursors = new Set<string>();

    this.logger.log(`Starting read-only sync for ${shopDomain} (max: ${maxOrders})`);

    while (hasNextPage && totalSynced < maxOrders) {
      pagesProcessed++;
      const pageSize = Math.min(50, maxOrders - totalSynced);

      const page = await client.listRecentOrders({
        first: pageSize,
        after: endCursor || undefined,
      });

      if (!page.orders || page.orders.length === 0) {
        hasNextPage = false;
        break;
      }

      // Idempotently project orders and fulfillments
      for (const rawOrder of page.orders) {
        const normalized = normalizeShopifyOrder(rawOrder);

        // Project ExternalOrder
        const externalOrder = await this.prisma.externalOrder.upsert({
          where: {
            organizationId_externalOrderNumber: {
              organizationId: integration.organizationId,
              externalOrderNumber: normalized.orderNumber,
            },
          },
          update: {
            status: normalized.status,
            currency: normalized.currency,
            totalAmount: normalized.totalAmount,
            sourceCreatedAt: normalized.sourceCreatedAt,
            lastObservedAt: new Date(),
            primaryIntegrationId: integration.id,
          },
          create: {
            organizationId: integration.organizationId,
            primaryIntegrationId: integration.id,
            externalOrderNumber: normalized.orderNumber,
            status: normalized.status,
            currency: normalized.currency,
            totalAmount: normalized.totalAmount,
            sourceCreatedAt: normalized.sourceCreatedAt,
            lastObservedAt: new Date(),
          },
        });

        // Project Order ExternalReference
        await this.prisma.externalReference.upsert({
          where: {
            organizationId_integrationId_resourceType_externalId: {
              organizationId: integration.organizationId,
              integrationId: integration.id,
              resourceType: 'ORDER',
              externalId: normalized.externalOrderId,
            },
          },
          update: {
            externalReference: normalized.orderNumber,
            updatedAt: new Date(),
          },
          create: {
            organizationId: integration.organizationId,
            integrationId: integration.id,
            externalOrderId: externalOrder.id,
            resourceType: 'ORDER',
            externalId: normalized.externalOrderId,
            externalReference: normalized.orderNumber,
          },
        });

        // Project Fulfillment ExternalReferences
        for (const fulfillment of normalized.fulfillments) {
          await this.prisma.externalReference.upsert({
            where: {
              organizationId_integrationId_resourceType_externalId: {
                organizationId: integration.organizationId,
                integrationId: integration.id,
                resourceType: 'FULFILLMENT',
                externalId: fulfillment.fulfillmentId,
              },
            },
            update: {
              externalReference: fulfillment.trackingNumber || null,
              updatedAt: new Date(),
            },
            create: {
              organizationId: integration.organizationId,
              integrationId: integration.id,
              externalOrderId: externalOrder.id,
              resourceType: 'FULFILLMENT',
              externalId: fulfillment.fulfillmentId,
              externalReference: fulfillment.trackingNumber || null,
            },
          });
        }

        totalSynced++;
      }

      // Cursor pagination handling & loop prevention
      endCursor = page.pageInfo.endCursor;
      hasNextPage = page.pageInfo.hasNextPage && !!endCursor;

      if (endCursor) {
        if (seenCursors.has(endCursor)) {
          this.logger.warn(`Duplicate cursor "${endCursor}" detected; stopping pagination to prevent infinite loop.`);
          break;
        }
        seenCursors.add(endCursor);
      }
    }

    this.logger.log(
      `Finished sync for ${shopDomain}: ${totalSynced} orders across ${pagesProcessed} pages.`,
    );

    return {
      integrationId: integration.id,
      shopDomain,
      totalOrdersSynced: totalSynced,
      pagesProcessed,
      complete: !hasNextPage,
      nextCursor: hasNextPage ? endCursor : undefined,
    };
  }

  /**
   * Processes a specific durable sync Job by ID.
   */
  async processSyncJob(
    jobId: string,
    options?: { maxOrders?: number; fetchFn?: typeof fetch },
  ): Promise<SyncResult> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException(`Sync Job ${jobId} not found`);
    }

    const payload = (job.payload as Record<string, any>) || {};
    const integrationId = payload.integrationId as string;
    if (!integrationId) {
      throw new BadRequestException(`Job ${jobId} payload missing integrationId`);
    }

    // Move job to RUNNING
    await this.prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'RUNNING',
        updatedAt: new Date(),
      },
    });

    try {
      const syncResult = await this.syncRecentOrders(integrationId, {
        ...options,
        cursor: payload.cursor,
      });

      // Update Integration configuration
      const integration = await this.prisma.integration.findUnique({
        where: { id: integrationId },
      });

      if (integration) {
        const currentConfig = (integration.configuration as Record<string, any>) || {};
        await this.prisma.integration.update({
          where: { id: integrationId },
          data: {
            configuration: {
              ...currentConfig,
              initialSyncStatus: syncResult.complete ? 'COMPLETED' : 'SYNCING',
              lastSyncAt: new Date().toISOString(),
              lastSyncOrdersCount: (currentConfig.lastSyncOrdersCount || 0) + syncResult.totalOrdersSynced,
              continuationCursor: syncResult.complete ? null : (syncResult.nextCursor ?? null),
            },
          },
        });
      }

      // Mark Job as SUCCEEDED
      await this.prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'SUCCEEDED',
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      return syncResult;
    } catch (err: any) {
      this.logger.error(`Error processing sync job ${jobId}: ${err.message}`, err.stack);
      await this.prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      throw err;
    }
  }

  /**
   * Scans and processes all pending durable sync jobs.
   * Enables seamless crash-recovery if the API process terminated before sync started.
   */
  async processPendingSyncJobs(
    options?: { limit?: number; fetchFn?: typeof fetch },
  ): Promise<{ processed: number; successful: number; failed: number }> {
    const limit = options?.limit || 10;
    const pendingJobs = await this.prisma.job.findMany({
      where: {
        type: 'SHOPIFY_SYNC_ORDERS',
        status: 'QUEUED',
      },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });

    let successful = 0;
    let failed = 0;

    for (const job of pendingJobs) {
      try {
        await this.processSyncJob(job.id, { fetchFn: options?.fetchFn });
        successful++;
      } catch (err: any) {
        this.logger.error(`Failed pending sync job ${job.id}: ${err.message}`);
        failed++;
      }
    }

    return {
      processed: pendingJobs.length,
      successful,
      failed,
    };
  }
}
