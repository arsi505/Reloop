import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { Prisma } from '@reloop/database';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { decryptCredentials } from '@reloop/connector-shopify';

describe('ShopifyOAuthService', () => {
  let service: ShopifyOAuthService;
  let prisma: any;
  const mockMasterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const mockClientSecret = 'shpss_test_secret_12345';
  const mockClientId = 'shp_client_12345';

  beforeEach(async () => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ configuration: {} }]),
      integration: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
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
        create: jest.fn().mockResolvedValue({ id: 'job-123' }),
      },
    };
    prisma.$transaction = jest.fn(async (callback: any) => callback(prisma));

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
        {
          provide: RealtimePublisher,
          useValue: {
            publish: jest.fn().mockResolvedValue(undefined),
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

    it('rejects if shop belongs to another organization even when DISCONNECTED', async () => {
      prisma.integration.findUnique.mockResolvedValue({
        id: 'int-existing-disconnected',
        organizationId: 'other-org',
        status: 'DISCONNECTED',
      });

      await expect(service.initiateConnect('org-123', 'user-456', 'store.myshopify.com')).rejects.toThrow(
        ConflictException,
      );
    });

    it('allows reconnect if shop is DISCONNECTED but belongs to the same organization', async () => {
      prisma.integration.findUnique.mockResolvedValue({
        id: 'int-existing-disconnected',
        organizationId: 'org-123',
        status: 'DISCONNECTED',
      });
      prisma.oAuthState.create.mockResolvedValue({});

      const result = await service.initiateConnect('org-123', 'user-456', 'store.myshopify.com');
      expect(result.authorizationUrl).toBeDefined();
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

      prisma.integration.findUnique.mockResolvedValue(null);
      prisma.integration.create.mockResolvedValue({
        id: 'integration-created-id',
        shopDomain: 'store.myshopify.com',
        organizationId: 'org-100',
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
      expect(prisma.integration.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-100',
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
      const createCall = prisma.integration.create.mock.calls[0][0];
      const envelope = createCall.data.encryptedCredentials;
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
      expect(prisma.job.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: expect.any(String),
          organizationId: 'org-100',
          type: 'SHOPIFY_SYNC_ORDERS',
          status: 'QUEUED',
          payload: expect.objectContaining({
            integrationId: 'integration-created-id',
            shopDomain: 'store.myshopify.com',
            syncRunId: expect.any(String),
          }),
          idempotencyKey: expect.stringMatching(
            /^shopify_sync_run_integration-created-id_[0-9a-f-]+$/,
          ),
        }),
      });
      const syncJobData = prisma.job.create.mock.calls[0][0].data;
      expect(syncJobData.payload.syncRunId).toBe(syncJobData.id);

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

    it('rejects callback if store is already associated with another organization', async () => {
      const message = 'code=code-1&shop=store.myshopify.com&state=state-1';
      const hmac = crypto.createHmac('sha256', mockClientSecret).update(message).digest('hex');

      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 'state-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        shopDomain: 'store.myshopify.com',
        organizationId: 'org-tenant-b',
        userId: 'user-200',
      });
      prisma.oAuthState.updateMany.mockResolvedValue({ count: 1 });

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shpat_token_b',
            scope: 'read_orders',
            expires_in: 86400,
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
                name: 'Store',
              },
            },
          }),
        } as any);

      // Existing integration belongs to org-tenant-a
      prisma.integration.findUnique.mockResolvedValue({
        id: 'int-existing-tenant-a',
        organizationId: 'org-tenant-a',
        shopDomain: 'store.myshopify.com',
        status: 'CONNECTED',
      });

      await expect(
        service.handleCallback(
          { code: 'code-1', shop: 'store.myshopify.com', state: 'state-1', hmac },
          mockFetch,
        ),
      ).rejects.toThrow(ConflictException);

      expect(prisma.integration.update).not.toHaveBeenCalled();
      expect(prisma.integration.create).not.toHaveBeenCalled();
    });

    it('rejects callback if store belongs to another organization even when DISCONNECTED', async () => {
      const message = 'code=code-1&shop=store.myshopify.com&state=state-1';
      const hmac = crypto.createHmac('sha256', mockClientSecret).update(message).digest('hex');

      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 'state-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        shopDomain: 'store.myshopify.com',
        organizationId: 'org-tenant-b',
        userId: 'user-200',
      });
      prisma.oAuthState.updateMany.mockResolvedValue({ count: 1 });

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shpat_token_b',
            scope: 'read_orders',
            expires_in: 86400,
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
                name: 'Store',
              },
            },
          }),
        } as any);

      // Existing integration belongs to org-tenant-a and is DISCONNECTED
      prisma.integration.findUnique.mockResolvedValue({
        id: 'int-existing-tenant-a',
        organizationId: 'org-tenant-a',
        shopDomain: 'store.myshopify.com',
        status: 'DISCONNECTED',
      });

      await expect(
        service.handleCallback(
          { code: 'code-1', shop: 'store.myshopify.com', state: 'state-1', hmac },
          mockFetch,
        ),
      ).rejects.toThrow(ConflictException);

      expect(prisma.integration.update).not.toHaveBeenCalled();
      expect(prisma.integration.create).not.toHaveBeenCalled();
    });

    it('reconnects same-tenant store without modifying organizationId', async () => {
      const message = 'code=code-reconnect&shop=store.myshopify.com&state=state-reconnect';
      const hmac = crypto.createHmac('sha256', mockClientSecret).update(message).digest('hex');

      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 'state-reconnect',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        shopDomain: 'store.myshopify.com',
        organizationId: 'org-100',
        userId: 'user-200',
      });
      prisma.oAuthState.updateMany.mockResolvedValue({ count: 1 });

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shpat_new_token',
            scope: 'read_orders',
            expires_in: 86400,
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
                name: 'Store Reconnected',
              },
            },
          }),
        } as any);

      // Existing integration belongs to the same org-100
      prisma.integration.findUnique.mockResolvedValue({
        id: 'int-existing-org-100',
        organizationId: 'org-100',
        shopDomain: 'store.myshopify.com',
        status: 'DISCONNECTED',
      });

      prisma.integration.update.mockResolvedValue({
        id: 'int-existing-org-100',
        organizationId: 'org-100',
        shopDomain: 'store.myshopify.com',
        status: 'CONNECTED',
      });

      const result = await service.handleCallback(
        { code: 'code-reconnect', shop: 'store.myshopify.com', state: 'state-reconnect', hmac },
        mockFetch,
      );

      expect(result.success).toBe(true);
      expect(result.integrationId).toBe('int-existing-org-100');

      // Verify update was called and did NOT pass organizationId
      expect(prisma.integration.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'int-existing-org-100' },
          data: expect.not.objectContaining({
            organizationId: expect.anything(),
          }),
        }),
      );
      expect(prisma.integration.create).not.toHaveBeenCalled();
    });

    it('handles concurrent race condition: P2002 on create updates if same organization, throws if different', async () => {
      const message = 'code=code-race&shop=store.myshopify.com&state=state-race';
      const hmac = crypto.createHmac('sha256', mockClientSecret).update(message).digest('hex');

      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 'state-race',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        shopDomain: 'store.myshopify.com',
        organizationId: 'org-100',
        userId: 'user-200',
      });
      prisma.oAuthState.updateMany.mockResolvedValue({ count: 1 });

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shpat_race',
            scope: 'read_orders',
            expires_in: 86400,
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
                name: 'Race Store',
              },
            },
          }),
        } as any);

      // findUnique returns null initially
      prisma.integration.findUnique
        .mockResolvedValueOnce(null)
        // second findUnique (in catch block) returns racer owned by org-100
        .mockResolvedValueOnce({
          id: 'int-racer',
          organizationId: 'org-100',
          shopDomain: 'store.myshopify.com',
        });

      // create throws P2002 unique constraint error
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`shop_domain`)',
        { code: 'P2002', clientVersion: '5.x' },
      );
      prisma.integration.create.mockRejectedValueOnce(p2002Error);
      prisma.integration.update.mockResolvedValue({
        id: 'int-racer',
        organizationId: 'org-100',
        shopDomain: 'store.myshopify.com',
      });

      const result = await service.handleCallback(
        { code: 'code-race', shop: 'store.myshopify.com', state: 'state-race', hmac },
        mockFetch,
      );

      expect(result.success).toBe(true);
      expect(result.integrationId).toBe('int-racer');
      expect(prisma.integration.update).toHaveBeenCalled();
    });
  });
});
