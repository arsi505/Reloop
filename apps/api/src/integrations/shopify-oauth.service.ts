import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  normalizeAndValidateShopDomain,
  encryptCredentials,
  ShopifyClient,
} from '@reloop/connector-shopify';

export interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  associated_user?: Record<string, unknown>;
}

@Injectable()
export class ShopifyOAuthService {
  private readonly logger = new Logger(ShopifyOAuthService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scopes: string;
  private readonly redirectUri: string;
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.clientId = this.configService.get<string>('shopifyClientId') || '';
    this.clientSecret = this.configService.get<string>('shopifyClientSecret') || '';
    this.scopes =
      this.configService.get<string>('shopifyScopes') || 'read_orders';
    this.redirectUri =
      this.configService.get<string>('shopifyRedirectUri') ||
      'http://localhost:3101/integrations/shopify/callback';
    this.encryptionKey = this.configService.get<string>('integrationEncryptionKey') || '';
  }

  /**
   * Verifies Shopify callback HMAC query parameter in constant time.
   */
  verifyCallbackHmac(query: Record<string, string | undefined>, secret: string): boolean {
    const hmac = query.hmac;
    if (!hmac || typeof hmac !== 'string' || !secret) {
      return false;
    }

    try {
      const keys = Object.keys(query)
        .filter((k) => k !== 'hmac' && k !== 'signature' && query[k] !== undefined && query[k] !== null)
        .sort();

      const message = keys
        .map((k) => `${k}=${query[k] !== undefined ? query[k] : ''}`)
        .join('&');

      const computedHmac = crypto
        .createHmac('sha256', secret)
        .update(message)
        .digest('hex');

      const expectedBuf = Buffer.from(computedHmac, 'utf8');
      const actualBuf = Buffer.from(hmac.trim().toLowerCase(), 'utf8');

      if (expectedBuf.length !== actualBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuf, actualBuf);
    } catch {
      return false;
    }
  }

  /**
   * Initiates the OAuth flow:
   * 1. Validates shop domain and enforces SSRF boundaries.
   * 2. Enforces cross-tenant shop uniqueness.
   * 3. Generates cryptographically secure single-use OAuth state.
   * 4. Persists OAuth state with 10-minute expiry.
   * 5. Returns Shopify authorization URL.
   */
  async initiateConnect(
    organizationId: string,
    userId: string,
    rawShopDomain: string,
  ): Promise<{ authorizationUrl: string; state: string; shopDomain: string }> {
    const normalizedShop = normalizeAndValidateShopDomain(rawShopDomain);

    // Cross-tenant store connection uniqueness check
    const existing = await this.prisma.integration.findUnique({
      where: { shopDomain: normalizedShop },
    });

    if (existing && existing.organizationId !== organizationId && existing.status !== 'DISCONNECTED') {
      throw new ConflictException(
        `Shopify store "${normalizedShop}" is already connected to another organization.`,
      );
    }

    // Generate single-use random state
    const state = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await this.prisma.oAuthState.create({
      data: {
        state,
        organizationId,
        userId,
        provider: 'SHOPIFY',
        shopDomain: normalizedShop,
        expiresAt,
      },
    });

    const authUrl =
      `https://${normalizedShop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(this.clientId)}` +
      `&scope=${encodeURIComponent(this.scopes)}` +
      `&redirect_uri=${encodeURIComponent(this.redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    return {
      authorizationUrl: authUrl,
      state,
      shopDomain: normalizedShop,
    };
  }

  /**
   * Handles the public callback from Shopify OAuth:
   * 1. Validates callback HMAC with client secret.
   * 2. Atomically consumes OAuth state (single-use check).
   * 3. Exchanges code for expiring offline access token.
   * 4. Verifies required read scopes.
   * 5. Verifies shop identity via GraphQL.
   * 6. Encrypts credentials with AES-256-GCM.
   * 7. Upserts Integration and writes AuditLog.
   */
  async handleCallback(
    query: Record<string, string | undefined>,
    fetchFn?: typeof fetch,
  ): Promise<{ success: boolean; integrationId: string; shopDomain: string }> {
    const hmac = query.hmac;
    const code = query.code;
    const rawShop = query.shop;
    const state = query.state;

    if (!hmac || !code || !rawShop || !state) {
      throw new BadRequestException('Missing required OAuth callback parameters');
    }

    // 1. Verify Callback HMAC
    const isHmacValid = this.verifyCallbackHmac(query, this.clientSecret);
    if (!isHmacValid) {
      this.logger.warn(`Rejected Shopify callback: invalid HMAC for shop ${rawShop}`);
      throw new UnauthorizedException('Invalid Shopify callback signature');
    }

    // 2. Validate shop domain format
    const normalizedShop = normalizeAndValidateShopDomain(rawShop);

    // 3. Atomically consume OAuth state (prevents concurrent replay attacks)
    const oauthState = await this.prisma.oAuthState.findUnique({
      where: { state },
    });

    if (!oauthState) {
      throw new BadRequestException('OAuth state not found or invalid');
    }

    if (oauthState.usedAt !== null) {
      throw new BadRequestException('OAuth state has already been used');
    }

    if (oauthState.expiresAt < new Date()) {
      throw new BadRequestException('OAuth state has expired');
    }

    if (oauthState.shopDomain !== normalizedShop) {
      throw new BadRequestException('OAuth state does not match callback shop domain');
    }

    // Atomic update: only one concurrent consumer will succeed
    const updateResult = await this.prisma.oAuthState.updateMany({
      where: { state, usedAt: null },
      data: { usedAt: new Date() },
    });

    if (updateResult.count === 0) {
      throw new BadRequestException('OAuth state was already consumed');
    }

    const { organizationId, userId } = oauthState;

    // 4. Exchange authorization code for token
    const tokenEndpoint = `https://${normalizedShop}/admin/oauth/access_token`;
    const callerFetch = fetchFn || globalThis.fetch;

    let tokenResponse: Response;
    try {
      tokenResponse = await callerFetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
          expiring: '1',
        }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Network error exchanging Shopify code: ${msg}`);
    }

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text().catch(() => '');
      this.logger.error(`Shopify token exchange failed with HTTP ${tokenResponse.status}: ${errText}`);
      throw new BadRequestException(`Shopify token exchange failed with HTTP ${tokenResponse.status}`);
    }

    let tokenData: ShopifyTokenResponse;
    try {
      tokenData = (await tokenResponse.json()) as ShopifyTokenResponse;
    } catch (err: unknown) {
      throw new BadRequestException('Failed to parse Shopify token exchange response');
    }

    if (!tokenData.access_token) {
      throw new BadRequestException('Shopify response missing access token');
    }

    // 5. Verify required scopes
    const grantedScopes = (tokenData.scope || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const requiredScopeList = this.scopes.split(',').map((s) => s.trim());
    const missingScopes = requiredScopeList.filter((s) => !grantedScopes.includes(s));

    if (missingScopes.length > 0) {
      this.logger.warn(
        `Shopify connection for ${normalizedShop} missing required scopes: ${missingScopes.join(', ')}`,
      );
      throw new BadRequestException(`Shopify authorization missing required scopes: ${missingScopes.join(', ')}`);
    }

    // 6. Shop Identity Verification
    const client = new ShopifyClient({
      shopDomain: normalizedShop,
      accessToken: tokenData.access_token,
      fetchFn: callerFetch,
    });

    let shopIdentity: { id: string; myshopifyDomain: string; name: string };
    try {
      shopIdentity = await client.getShopIdentity();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Failed to verify shop identity with Shopify: ${msg}`);
    }

    if (shopIdentity.myshopifyDomain.toLowerCase() !== normalizedShop.toLowerCase()) {
      this.logger.error(
        `Shop domain mismatch: connected "${normalizedShop}" but Shopify returned "${shopIdentity.myshopifyDomain}"`,
      );
      throw new BadRequestException('Shop identity mismatch between callback and Shopify Admin');
    }

    // 7. Encrypt Credentials (AES-256-GCM)
    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : undefined;

    const refreshTokenExpiresAt = tokenData.refresh_token_expires_in
      ? new Date(Date.now() + tokenData.refresh_token_expires_in * 1000).toISOString()
      : undefined;

    const credentialsToStore = {
      accessToken: tokenData.access_token,
      expiresAt,
      accessTokenExpiresAt: expiresAt,
      refreshToken: tokenData.refresh_token,
      refreshTokenExpiresAt,
      scope: tokenData.scope,
      tokenType: 'bearer',
      associatedUser: tokenData.associated_user,
    };

    const encryptedEnvelope = encryptCredentials(credentialsToStore, this.encryptionKey);

    // 8. Upsert Integration
    const integration = await this.prisma.integration.upsert({
      where: { shopDomain: normalizedShop },
      update: {
        organizationId,
        status: 'CONNECTED',
        name: shopIdentity.name || normalizedShop,
        mode: 'OBSERVE',
        encryptedCredentials: encryptedEnvelope as any,
        configuration: {
          shopId: shopIdentity.id,
          scopes: grantedScopes,
          connectedAt: new Date().toISOString(),
          initialSyncStatus: 'PENDING',
        },
      },
      create: {
        organizationId,
        provider: 'SHOPIFY',
        name: shopIdentity.name || normalizedShop,
        status: 'CONNECTED',
        mode: 'OBSERVE',
        shopDomain: normalizedShop,
        encryptedCredentials: encryptedEnvelope as any,
        configuration: {
          shopId: shopIdentity.id,
          scopes: grantedScopes,
          connectedAt: new Date().toISOString(),
          initialSyncStatus: 'PENDING',
        },
      },
    });

    // 9. Record Audit Log
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId: userId,
        entityType: 'INTEGRATION',
        entityId: integration.id,
        action: 'SHOPIFY_INTEGRATION_CONNECTED',
        metadata: {
          shopDomain: normalizedShop,
          shopName: shopIdentity.name,
          scopes: grantedScopes,
        },
      },
    });

    // 10. Enqueue Durable Initial Sync Job
    await this.prisma.job.upsert({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey: `shopify_initial_sync_${integration.id}`,
        },
      },
      update: {
        status: 'QUEUED',
        nextRunAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        organizationId,
        type: 'SHOPIFY_SYNC_ORDERS',
        status: 'QUEUED',
        payload: {
          integrationId: integration.id,
          shopDomain: normalizedShop,
        },
        idempotencyKey: `shopify_initial_sync_${integration.id}`,
        nextRunAt: new Date(),
      },
    });

    return {
      success: true,
      integrationId: integration.id,
      shopDomain: normalizedShop,
    };
  }
}
