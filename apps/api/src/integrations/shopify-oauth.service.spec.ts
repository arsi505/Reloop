import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { PrismaService } from '../prisma/prisma.service';
import { decryptCredentials } from '@reloop/connector-shopify';

describe('ShopifyOAuthService', () => {
  let service: ShopifyOAuthService;
  let prisma: any;
  const mockMasterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const mockClientSecret = 'shpss_test_secret_12345';
  const mockClientId = 'shp_client_12345';

  beforeEach(async () => {
    prisma = {
      integration: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      oAuthState: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      job: {
        upsert: jest.fn().mockResolvedValue({ id: 'job-123' }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShopifyOAuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'shopifyClientId') return mockClientId;
              if (key === 'shopifyClientSecret') return mockClientSecret;
              if (key === 'shopifyScopes') return 'read_orders';
              if (key === 'shopifyRedirectUri') return 'http://localhost:3101/integrations/shopify/callback';
              if (key === 'integrationEncryptionKey') return mockMasterKey;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ShopifyOAuthService>(ShopifyOAuthService);
  });

  describe('verifyCallbackHmac', () => {
    it('verifies valid HMAC query parameters', () => {
      const query = {
        code: 'auth_code_123',
        shop: 'store.myshopify.com',
        state: 'random_state_abc',
        timestamp: '1700000000',
      };

      const message = 'code=auth_code_123&shop=store.myshopify.com&state=random_state_abc&timestamp=1700000000';
      const hmac = crypto.createHmac('sha256', mockClientSecret).update(message).digest('hex');

      expect(service.verifyCallbackHmac({ ...query, hmac }, mockClientSecret)).toBe(true);
    });

    it('rejects tampered or missing HMAC', () => {
      const query = {
        code: 'auth_code_123',
        shop: 'store.myshopify.com',
        state: 'random_state_abc',
        hmac: 'invalid_hmac_hex',
      };
      expect(service.verifyCallbackHmac(query, mockClientSecret)).toBe(false);
      expect(service.verifyCallbackHmac({ ...query, hmac: undefined }, mockClientSecret)).toBe(false);
    });
  });

  describe('initiateConnect', () => {
    it('creates single-use expiring OAuth state and returns authorization URL', async () => {
      prisma.integration.findUnique.mockResolvedValue(null);
      prisma.oAuthState.create.mockResolvedValue({});

      const result = await service.initiateConnect('org-123', 'user-456', 'store.myshopify.com');

      expect(result.shopDomain).toBe('store.myshopify.com');
      expect(result.state).toBeDefined();
      expect(result.authorizationUrl).toContain('https://store.myshopify.com/admin/oauth/authorize');
      expect(result.authorizationUrl).toContain(`client_id=${mockClientId}`);
      expect(result.authorizationUrl).toContain(`state=${result.state}`);

      expect(prisma.oAuthState.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: 'org-123',
          userId: 'user-456',
          shopDomain: 'store.myshopify.com',
          state: result.state,
        }),
      });
    });

    it('rejects SSRF attempt on shop domain', async () => {
      await expect(service.initiateConnect('org-123', 'user-456', 'localhost')).rejects.toThrow();
      await expect(service.initiateConnect('org-123', 'user-456', '169.254.169.254')).rejects.toThrow();
      await expect(service.initiateConnect('org-123', 'user-456', 'evil.com')).rejects.toThrow();
    });

    it('rejects if shop is already connected to another organization', async () => {
      prisma.integration.findUnique.mockResolvedValue({
        id: 'int-existing',
        organizationId: 'other-org',
        status: 'CONNECTED',
      });

      await expect(service.initiateConnect('org-123', 'user-456', 'store.myshopify.com')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('handleCallback', () => {
    it('rejects callback with invalid HMAC signature', async () => {
      const query = {
        code: 'code-1',
        shop: 'store.myshopify.com',
        state: 'state-1',
        hmac: 'wrong_hmac',
      };

      await expect(service.handleCallback(query)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects callback with expired or already-used state', async () => {
      const message = 'code=code-1&shop=store.myshopify.com&state=state-1';
      const hmac = crypto.createHmac('sha256', mockClientSecret).update(message).digest('hex');

      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 'state-1',
        usedAt: new Date(), // already used
        expiresAt: new Date(Date.now() + 60000),
        shopDomain: 'store.myshopify.com',
      });

      await expect(
        service.handleCallback({ code: 'code-1', shop: 'store.myshopify.com', state: 'state-1', hmac }),
      ).rejects.toThrow(BadRequestException);
    });

    it('prevents state race conditions (atomic consumption)', async () => {
      const message = 'code=code-1&shop=store.myshopify.com&state=state-1';
      const hmac = crypto.createHmac('sha256', mockClientSecret).update(message).digest('hex');

      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 'state-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        shopDomain: 'store.myshopify.com',
      });
      // simulate race: updateMany count is 0 because another concurrent worker grabbed it first
      prisma.oAuthState.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.handleCallback({ code: 'code-1', shop: 'store.myshopify.com', state: 'state-1', hmac }),
      ).rejects.toThrow(BadRequestException);
    });

    it('completes OAuth callback, verifies scopes and shop identity, and stores encrypted credentials', async () => {
      const message = 'code=valid-code&shop=store.myshopify.com&state=valid-state';
      const hmac = crypto.createHmac('sha256', mockClientSecret).update(message).digest('hex');

      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 'valid-state',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        shopDomain: 'store.myshopify.com',
        organizationId: 'org-100',
        userId: 'user-200',
      });
      prisma.oAuthState.updateMany.mockResolvedValue({ count: 1 });

      // Mock token exchange and GraphQL shop identity fetch
      const mockFetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shpat_secret_access_token_123',
            scope: 'read_orders',
            expires_in: 86400,
            refresh_token: 'shprf_secret_refresh_token_456',
            refresh_token_expires_in: 7776000,
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              shop: {
                id: 'gid://shopify/Shop/999',
                myshopifyDomain: 'store.myshopify.com',
                name: 'My Store',
              },
            },
          }),
        } as any);

      prisma.integration.upsert.mockResolvedValue({
        id: 'integration-created-id',
        shopDomain: 'store.myshopify.com',
      });

      const beforeExchange = Date.now();
      const result = await service.handleCallback(
        { code: 'valid-code', shop: 'store.myshopify.com', state: 'valid-state', hmac },
        mockFetch,
      );

      expect(result.success).toBe(true);
      expect(result.integrationId).toBe('integration-created-id');
      expect(result.shopDomain).toBe('store.myshopify.com');

      // 1. Inspect mocked token request and prove expiring=1 was actually sent
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const tokenExchangeCall = mockFetch.mock.calls[0];
      expect(tokenExchangeCall[0]).toBe('https://store.myshopify.com/admin/oauth/access_token');
      const requestBody = JSON.parse(tokenExchangeCall[1].body);
      expect(requestBody.client_id).toBe(mockClientId);
      expect(requestBody.client_secret).toBe(mockClientSecret);
      expect(requestBody.code).toBe('valid-code');
      expect(requestBody.expiring).toBe('1');

      // 2. Verify credentials were encrypted
      expect(prisma.integration.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            encryptedCredentials: expect.objectContaining({
              algorithm: 'aes-256-gcm',
              ciphertext: expect.any(String),
            }),
            configuration: expect.objectContaining({
              initialSyncStatus: 'PENDING',
            }),
          }),
        }),
      );

      // 3. Verify decrypted content contains full lifecycle metadata computed accurately
      const upsertCall = prisma.integration.upsert.mock.calls[0][0];
      const envelope = upsertCall.create.encryptedCredentials;
      const decrypted = decryptCredentials<any>(envelope, mockMasterKey);
      expect(decrypted.accessToken).toBe('shpat_secret_access_token_123');
      expect(decrypted.refreshToken).toBe('shprf_secret_refresh_token_456');

      // Verify computed expiresAt and accessTokenExpiresAt
      const expectedAccessExpiryMs = beforeExchange + 86400 * 1000;
      const actualAccessExpiryMs = new Date(decrypted.accessTokenExpiresAt).getTime();
      expect(Math.abs(actualAccessExpiryMs - expectedAccessExpiryMs)).toBeLessThan(5000);
      expect(decrypted.expiresAt).toBe(decrypted.accessTokenExpiresAt);

      // Verify computed refreshTokenExpiresAt
      const expectedRefreshExpiryMs = beforeExchange + 7776000 * 1000;
      const actualRefreshExpiryMs = new Date(decrypted.refreshTokenExpiresAt).getTime();
      expect(Math.abs(actualRefreshExpiryMs - expectedRefreshExpiryMs)).toBeLessThan(5000);

      // 4. Verify durable initial sync Job was enqueued
      expect(prisma.job.upsert).toHaveBeenCalledWith({
        where: {
          organizationId_idempotencyKey: {
            organizationId: 'org-100',
            idempotencyKey: 'shopify_initial_sync_integration-created-id',
          },
        },
        update: expect.objectContaining({
          status: 'QUEUED',
        }),
        create: expect.objectContaining({
          organizationId: 'org-100',
          type: 'SHOPIFY_SYNC_ORDERS',
          status: 'QUEUED',
          payload: {
            integrationId: 'integration-created-id',
            shopDomain: 'store.myshopify.com',
          },
          idempotencyKey: 'shopify_initial_sync_integration-created-id',
        }),
      });

      // 5. Verify AuditLog
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: 'org-100',
          actorUserId: 'user-200',
          action: 'SHOPIFY_INTEGRATION_CONNECTED',
        }),
      });
    });

    it('rejects if granted scopes are missing required scopes', async () => {
      const message = 'code=scope-code&shop=store.myshopify.com&state=scope-state';
      const hmac = crypto.createHmac('sha256', mockClientSecret).update(message).digest('hex');

      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 'scope-state',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        shopDomain: 'store.myshopify.com',
        organizationId: 'org-100',
        userId: 'user-200',
      });
      prisma.oAuthState.updateMany.mockResolvedValue({ count: 1 });

      const mockFetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'shpat_test',
          scope: 'read_customers', // missing read_orders
        }),
      } as any);

      await expect(
        service.handleCallback(
          { code: 'scope-code', shop: 'store.myshopify.com', state: 'scope-state', hmac },
          mockFetch,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
