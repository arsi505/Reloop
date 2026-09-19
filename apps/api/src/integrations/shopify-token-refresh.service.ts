import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  decryptCredentials,
  encryptCredentials,
  ShopifyAuthenticationError,
  ShopifyClientError,
} from '@reloop/connector-shopify';
import { EncryptedCredentialEnvelope, StoredShopifyCredential } from '@reloop/integration-sdk';

@Injectable()
export class ShopifyTokenRefreshService {
  private readonly logger = new Logger(ShopifyTokenRefreshService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.clientId = this.configService.get<string>('shopifyClientId') || '';
    this.clientSecret = this.configService.get<string>('shopifyClientSecret') || '';
    this.encryptionKey = this.configService.get<string>('integrationEncryptionKey') || '';
  }

  /**
   * Retrieves a valid, unexpired access token for the given Integration ID.
   * Uses PostgreSQL advisory lock to ensure concurrent callers execute at most one logical refresh.
   */
  async getValidAccessToken(
    integrationId: string,
    customFetch?: typeof fetch,
  ): Promise<string> {
    const callerFetch = customFetch || globalThis.fetch;

    return await this.prisma.$transaction(async (tx) => {
      // 1. Acquire transactional advisory lock per integration to fence concurrent refreshes
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('shopify_token_refresh_' || ${integrationId}))`;

      // 2. Load latest integration state
      const integration = await tx.integration.findUnique({
        where: { id: integrationId },
      });

      if (!integration) {
        throw new NotFoundException(`Integration ${integrationId} not found`);
      }

      if (!integration.encryptedCredentials) {
        throw new UnauthorizedException(`Integration ${integrationId} has no stored credentials`);
      }

      if (integration.status === 'DISCONNECTED') {
        throw new UnauthorizedException(`Integration ${integrationId} is disconnected`);
      }

      const envelope = integration.encryptedCredentials as unknown as EncryptedCredentialEnvelope;
      const creds = decryptCredentials<StoredShopifyCredential>(envelope, this.encryptionKey);

      const now = Date.now();
      const expiresAtMs = creds.expiresAt ? new Date(creds.expiresAt).getTime() : Infinity;

      // 3. If token is still valid (with 60-second buffer), reuse it immediately
      // This is crucial for concurrent callers: first caller refreshes, remaining 4 callers see the new token here
      if (expiresAtMs > now + 60000) {
        return creds.accessToken;
      }

      // If token expired but no refresh token available, must re-authenticate
      if (!creds.refreshToken) {
        this.logger.warn(`Integration ${integrationId} expired without refresh token`);
        await tx.integration.update({
          where: { id: integrationId },
          data: { status: 'DEGRADED' },
        });
        throw new ShopifyAuthenticationError('Integration token expired and no refresh token is available');
      }

      const shopDomain = integration.shopDomain;
      if (!shopDomain) {
        throw new NotFoundException(`Integration ${integrationId} is missing shopDomain`);
      }

      // 4. Perform refresh token exchange with Shopify
      const refreshEndpoint = `https://${shopDomain}/admin/oauth/access_token`;
      let refreshResponse: Response;

      try {
        refreshResponse = await callerFetch(refreshEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: creds.refreshToken,
            grant_type: 'refresh_token',
          }),
        });
      } catch (err: unknown) {
        // Transient network error: DO NOT delete old stored refresh token
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Transient network error during Shopify token refresh for ${integrationId}: ${msg}`);
        throw new ShopifyClientError(`Transient network failure during token refresh: ${msg}`, {
          code: 'TRANSIENT_REFRESH_FAILURE',
        });
      }

      if (!refreshResponse.ok) {
        // Classify transient vs permanent error
        const status = refreshResponse.status;
        const errBody = await refreshResponse.text().catch(() => '');

        if (status >= 500 || status === 429) {
          // Transient provider error: preserve existing refresh token for future retry
          this.logger.warn(`Transient error ${status} during token refresh for ${integrationId}`);
          throw new ShopifyClientError(`Shopify returned transient ${status} during refresh`, {
            status,
            code: 'TRANSIENT_REFRESH_FAILURE',
          });
        }

        // Permanent failure (400, 401, invalid_grant): mark reconnect required
        this.logger.error(`Permanent failure ${status} during token refresh for ${integrationId}: ${errBody}`);
        await tx.integration.update({
          where: { id: integrationId },
          data: { status: 'DEGRADED' },
        });

        await tx.auditLog.create({
          data: {
            organizationId: integration.organizationId,
            entityType: 'INTEGRATION',
            entityId: integration.id,
            action: 'SHOPIFY_INTEGRATION_REAUTH_REQUIRED',
            metadata: {
              reason: 'PERMANENT_REFRESH_FAILURE',
              status,
            },
          },
        });

        throw new ShopifyAuthenticationError('Permanent token refresh failure: store reconnection required');
      }

      let refreshData: {
        access_token: string;
        expires_in?: number;
        refresh_token?: string;
        refresh_token_expires_in?: number;
        scope?: string;
      };

      try {
        refreshData = (await refreshResponse.json()) as any;
      } catch {
        throw new ShopifyClientError('Malformed response parsing refreshed Shopify token');
      }

      if (!refreshData.access_token) {
        throw new ShopifyClientError('Refreshed token response missing access_token');
      }

      // 5. Encrypt rotated tokens atomically
      const expiresAt = refreshData.expires_in
        ? new Date(Date.now() + refreshData.expires_in * 1000).toISOString()
        : undefined;

      const refreshTokenExpiresAt = refreshData.refresh_token_expires_in
        ? new Date(Date.now() + refreshData.refresh_token_expires_in * 1000).toISOString()
        : creds.refreshTokenExpiresAt;

      const updatedCreds: StoredShopifyCredential = {
        accessToken: refreshData.access_token,
        expiresAt,
        accessTokenExpiresAt: expiresAt,
        refreshToken: refreshData.refresh_token || creds.refreshToken,
        refreshTokenExpiresAt,
        scope: refreshData.scope || creds.scope,
        tokenType: creds.tokenType,
        associatedUser: creds.associatedUser,
      };

      const newEnvelope = encryptCredentials(updatedCreds, this.encryptionKey);

      await tx.integration.update({
        where: { id: integrationId },
        data: {
          encryptedCredentials: newEnvelope as any,
          status: 'CONNECTED',
        },
      });

      this.logger.log(`Successfully rotated Shopify access token for integration ${integrationId}`);
      return updatedCreds.accessToken;
    });
  }
}
