import { PrismaClient, JobErrorCategory } from '@prisma/client';
import {
  ShopifyClient,
  normalizeShopifyOrder,
  decryptCredentials,
  encryptCredentials,
  ShopifyClientError,
  ShopifyRateLimitError,
} from '@reloop/connector-shopify';
import { EncryptedCredentialEnvelope, StoredShopifyCredential } from '@reloop/integration-sdk';
import { JobContext } from './executor';
import { JobExecutionError } from './errors';

export interface ShopifySyncExecutorOptions {
  encryptionKey?: string;
  clientId?: string;
  clientSecret?: string;
  apiVersion?: string;
  defaultMaxOrders?: number;
  fetchFn?: typeof fetch;
}

export interface ShopifySyncJobResult {
  integrationId: string;
  shopDomain: string;
  totalOrdersSynced: number;
  pagesProcessed: number;
  complete: boolean;
}

export class ShopifySyncJobExecutor {
  private prisma: PrismaClient;
  private encryptionKey: string;
  private clientId: string;
  private clientSecret: string;
  private apiVersion: string;
  private defaultMaxOrders: number;
  private fetchFn?: typeof fetch;

  constructor(prisma: PrismaClient, options: ShopifySyncExecutorOptions = {}) {
    this.prisma = prisma;
    this.encryptionKey = options.encryptionKey || process.env.INTEGRATION_ENCRYPTION_KEY || '';
    this.clientId = options.clientId || process.env.SHOPIFY_CLIENT_ID || '';
    this.clientSecret = options.clientSecret || process.env.SHOPIFY_CLIENT_SECRET || '';
    this.apiVersion = options.apiVersion || process.env.SHOPIFY_API_VERSION || '2026-07';
    this.defaultMaxOrders = options.defaultMaxOrders || 250;
    this.fetchFn = options.fetchFn;
  }

  async execute(context: JobContext): Promise<ShopifySyncJobResult> {
    const callerFetch = this.fetchFn || globalThis.fetch;
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
    if (integration.provider !== 'SHOPIFY') {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'PROVIDER_MISMATCH',
        message: `Integration ${integrationId} provider is ${integration.provider}, expected SHOPIFY`,
        retryable: false,
      });
    }

    // 4. Verify integration status
    if (integration.status === 'DISCONNECTED') {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'INTEGRATION_DISCONNECTED',
        message: `Integration ${integrationId} is disconnected`,
        retryable: false,
      });
    }

    if (!integration.encryptedCredentials) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'CREDENTIALS_MISSING',
        message: `Integration ${integrationId} has no stored encrypted credentials`,
        retryable: false,
      });
    }

    const shopDomain = integration.shopDomain;
    if (!shopDomain) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'MISSING_SHOP_DOMAIN',
        message: `Integration ${integrationId} has no shopDomain`,
        retryable: false,
      });
    }

    // 5. Decrypt credentials only inside execution boundary
    let creds: StoredShopifyCredential;
    try {
      const envelope = integration.encryptedCredentials as unknown as EncryptedCredentialEnvelope;
      creds = decryptCredentials<StoredShopifyCredential>(envelope, this.encryptionKey);
    } catch (err: any) {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'CREDENTIAL_DECRYPTION_FAILED',
        message: 'Failed to decrypt integration credentials',
        retryable: false,
      });
    }

    // 6. Proactive / reactive token refresh if near expiration (within 5-min buffer)
    const now = Date.now();
    const expiryBufferMs = 300000; // 5 minutes
    const tokenExpiresAtMs = creds.accessTokenExpiresAt
      ? new Date(creds.accessTokenExpiresAt).getTime()
      : creds.expiresAt
      ? new Date(creds.expiresAt).getTime()
      : Infinity;

    let accessToken = creds.accessToken;

    if (tokenExpiresAtMs <= now + expiryBufferMs) {
      if (!creds.refreshToken) {
        // Expired and no refresh token
        await this.prisma.integration.update({
          where: { id: integrationId },
          data: { status: 'DEGRADED' },
        });
        await this.prisma.auditLog.create({
          data: {
            organizationId: integration.organizationId,
            entityType: 'INTEGRATION',
            entityId: integrationId,
            action: 'SHOPIFY_INTEGRATION_REAUTH_REQUIRED',
            metadata: { shopDomain, reason: 'Token expired without refresh token' },
          },
        });
        throw new JobExecutionError({
          category: JobErrorCategory.BUSINESS_ERROR,
          code: 'SHOPIFY_REAUTH_REQUIRED',
          message: 'Access token expired and no refresh token is available',
          retryable: false,
        });
      }

      // Execute refresh exchange
      const refreshEndpoint = `https://${shopDomain}/admin/oauth/access_token`;
      let refreshResponse: Response;
      try {
        refreshResponse = await callerFetch(refreshEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: creds.refreshToken,
          }),
        });
      } catch (networkErr: any) {
        throw new JobExecutionError({
          category: JobErrorCategory.TRANSIENT,
          code: 'TOKEN_REFRESH_NETWORK_ERROR',
          message: `Network error during token refresh: ${networkErr.message}`,
          retryable: true,
        });
      }

      if (!refreshResponse.ok) {
        const status = refreshResponse.status;
        const errorBody = await refreshResponse.text();

        if (status === 429) {
          const retryAfterSec = parseInt(refreshResponse.headers.get('retry-after') || '2', 10);
          throw new JobExecutionError({
            category: JobErrorCategory.RATE_LIMITED,
            code: 'TOKEN_REFRESH_RATE_LIMIT',
            message: 'Shopify token refresh rate limited',
            retryable: true,
            retryAfterMs: isNaN(retryAfterSec) ? 2000 : retryAfterSec * 1000,
          });
        }

        if (status >= 500) {
          throw new JobExecutionError({
            category: JobErrorCategory.TRANSIENT,
            code: 'TOKEN_REFRESH_UPSTREAM_ERROR',
            message: `Shopify token refresh server error (${status}): ${errorBody}`,
            retryable: true,
          });
        }

        // Permanent failure (400 invalid_grant, 401, etc.)
        await this.prisma.integration.update({
          where: { id: integrationId },
          data: { status: 'DEGRADED' },
        });
        await this.prisma.auditLog.create({
          data: {
            organizationId: integration.organizationId,
            entityType: 'INTEGRATION',
            entityId: integrationId,
            action: 'SHOPIFY_INTEGRATION_REAUTH_REQUIRED',
            metadata: { shopDomain, status, reason: errorBody },
          },
        });
        throw new JobExecutionError({
          category: JobErrorCategory.BUSINESS_ERROR,
          code: 'SHOPIFY_REAUTH_REQUIRED',
          message: `Permanent failure during token refresh (${status}): ${errorBody}`,
          retryable: false,
        });
      }

      const refreshData = (await refreshResponse.json()) as {
        access_token: string;
        expires_in?: number;
        refresh_token?: string;
        refresh_token_expires_in?: number;
      };

      const updatedCreds: StoredShopifyCredential = {
        ...creds,
        accessToken: refreshData.access_token,
        refreshToken: refreshData.refresh_token || creds.refreshToken,
        expiresAt: refreshData.expires_in
          ? new Date(Date.now() + refreshData.expires_in * 1000).toISOString()
          : creds.expiresAt,
        accessTokenExpiresAt: refreshData.expires_in
          ? new Date(Date.now() + refreshData.expires_in * 1000).toISOString()
          : creds.accessTokenExpiresAt,
        refreshTokenExpiresAt: refreshData.refresh_token_expires_in
          ? new Date(Date.now() + refreshData.refresh_token_expires_in * 1000).toISOString()
          : creds.refreshTokenExpiresAt,
      };

      const reencrypted = encryptCredentials(updatedCreds, this.encryptionKey);
      await this.prisma.integration.update({
        where: { id: integrationId },
        data: {
          encryptedCredentials: reencrypted as unknown as object,
        },
      });

      accessToken = updatedCreds.accessToken;
    }

    // 7. Initialize read-only Shopify GraphQL Client
    const client = new ShopifyClient({
      shopDomain,
      accessToken,
      apiVersion: this.apiVersion,
      fetchFn: this.fetchFn,
    });

    const maxOrders = payload.maxOrders || this.defaultMaxOrders;
    let hasNextPage = true;
    let endCursor: string | null = null;
    let totalSynced = 0;
    let pagesProcessed = 0;
    const seenCursors = new Set<string>();

    try {
      while (hasNextPage && totalSynced < maxOrders) {
        pagesProcessed++;
        const pageSize = Math.min(50, maxOrders - totalSynced);

        const page = await client.listRecentOrders({
          first: pageSize,
          after: endCursor || undefined,
        });

        if (!page.orders || page.orders.length === 0) {
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

        endCursor = page.pageInfo.endCursor;
        hasNextPage = page.pageInfo.hasNextPage && !!endCursor;

        if (endCursor) {
          if (seenCursors.has(endCursor)) {
            break;
          }
          seenCursors.add(endCursor);
        }
      }
    } catch (err: any) {
      if (err instanceof ShopifyRateLimitError) {
        throw new JobExecutionError({
          category: JobErrorCategory.RATE_LIMITED,
          code: 'SHOPIFY_API_RATE_LIMIT',
          message: err.message,
          retryable: true,
          retryAfterMs: (err.retryAfterSeconds || 2) * 1000,
        });
      }
      if (err instanceof ShopifyClientError) {
        const isTransient = !err.status || err.status >= 500 || err.status === 429;
        if (isTransient) {
          throw new JobExecutionError({
            category: JobErrorCategory.TRANSIENT,
            code: 'SHOPIFY_API_TRANSIENT',
            message: err.message,
            retryable: true,
          });
        }
        throw new JobExecutionError({
          category: JobErrorCategory.BUSINESS_ERROR,
          code: 'SHOPIFY_API_PERMANENT',
          message: err.message,
          retryable: false,
        });
      }
      throw err;
    }

    // 8. Update Integration configuration with initialSyncStatus = COMPLETED
    const currentConfig = (integration.configuration as Record<string, any>) || {};
    await this.prisma.integration.update({
      where: { id: integrationId },
      data: {
        configuration: {
          ...currentConfig,
          initialSyncStatus: 'COMPLETED',
          lastSyncAt: new Date().toISOString(),
          lastSyncOrdersCount: totalSynced,
        },
      },
    });

    // 9. Return safe result metadata (ZERO plaintext tokens, secrets, or raw headers)
    return {
      integrationId: integration.id,
      shopDomain,
      totalOrdersSynced: totalSynced,
      pagesProcessed,
      complete: !hasNextPage || totalSynced >= maxOrders,
    };
  }
}
