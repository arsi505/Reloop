import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ShopifyTokenRefreshService } from './shopify-token-refresh.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  encryptCredentials,
  ShopifyAuthenticationError,
  ShopifyClientError,
} from '@reloop/connector-shopify';

describe('ShopifyTokenRefreshService (Concurrency Fencing & Safe Rotation)', () => {
  let service: ShopifyTokenRefreshService;
  let prisma: any;
  const mockMasterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(async (cb) => {
        const tx = {
          $executeRaw: jest.fn().mockResolvedValue(1),
          integration: {
            findUnique: prisma.integration.findUnique,
            update: prisma.integration.update,
          },
          auditLog: {
            create: prisma.auditLog.create,
          },
        };
        return cb(tx);
      }),
      integration: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShopifyTokenRefreshService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'shopifyClientId') return 'shp_client_1';
              if (key === 'shopifyClientSecret') return 'shp_secret_1';
              if (key === 'integrationEncryptionKey') return mockMasterKey;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ShopifyTokenRefreshService>(ShopifyTokenRefreshService);
  });

  it('returns active access token immediately without calling refresh when not expired', async () => {
    const creds = {
      accessToken: 'shpat_active_token',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hr future
      refreshToken: 'shprf_existing',
      scope: 'read_orders',
    };

    const envelope = encryptCredentials(creds, mockMasterKey);
    prisma.integration.findUnique.mockResolvedValue({
      id: 'int-1',
      status: 'CONNECTED',
      shopDomain: 'store.myshopify.com',
      encryptedCredentials: envelope,
    });

    const mockFetch = jest.fn();
    const token = await service.getValidAccessToken('int-1', mockFetch);

    expect(token).toBe('shpat_active_token');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes expired access token, rotates refresh token, and updates DB', async () => {
    const expiredCreds = {
      accessToken: 'shpat_expired_token',
      expiresAt: new Date(Date.now() - 60000).toISOString(), // expired 1 min ago
      refreshToken: 'shprf_existing_refresh',
      scope: 'read_orders',
    };

    const envelope = encryptCredentials(expiredCreds, mockMasterKey);
    prisma.integration.findUnique.mockResolvedValue({
      id: 'int-2',
      status: 'CONNECTED',
      shopDomain: 'store.myshopify.com',
      encryptedCredentials: envelope,
    });
    prisma.integration.update.mockResolvedValue({});

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'shpat_new_rotated_token',
        expires_in: 86400,
        refresh_token: 'shprf_new_rotated_refresh',
        scope: 'read_orders',
      }),
    } as any);

    const token = await service.getValidAccessToken('int-2', mockFetch);

    expect(token).toBe('shpat_new_rotated_token');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://store.myshopify.com/admin/oauth/access_token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          client_id: 'shp_client_1',
          client_secret: 'shp_secret_1',
          refresh_token: 'shprf_existing_refresh',
          grant_type: 'refresh_token',
        }),
      }),
    );

    expect(prisma.integration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'int-2' },
        data: expect.objectContaining({
          status: 'CONNECTED',
          encryptedCredentials: expect.objectContaining({
            algorithm: 'aes-256-gcm',
            ciphertext: expect.any(String),
          }),
        }),
      }),
    );
  });

  it('fences 5 concurrent refresh callers: exactly 1 network call, all 5 get fresh token', async () => {
    let currentCreds = {
      accessToken: 'shpat_expired_token',
      expiresAt: new Date(Date.now() - 60000).toISOString(),
      refreshToken: 'shprf_initial',
      scope: 'read_orders',
    };

    let callCount = 0;
    const mockFetch = jest.fn().mockImplementation(async () => {
      callCount++;
      // simulate provider delay
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'shpat_fresh_concurrent_token',
          expires_in: 86400,
          refresh_token: 'shprf_refreshed_once',
          scope: 'read_orders',
        }),
      };
    });

    // In a real database, pg_advisory_xact_lock serializes callers.
    // We simulate serialized execution under lock:
    let isLocked = false;
    prisma.$transaction.mockImplementation(async (cb: any) => {
      while (isLocked) {
        await new Promise((r) => setTimeout(r, 5));
      }
      isLocked = true;
      try {
        const tx = {
          $executeRaw: jest.fn(),
          integration: {
            findUnique: jest.fn().mockImplementation(async () => ({
              id: 'int-concurrent',
              status: 'CONNECTED',
              shopDomain: 'store.myshopify.com',
              encryptedCredentials: encryptCredentials(currentCreds, mockMasterKey),
            })),
            update: jest.fn().mockImplementation(async ({ data: _data }: any) => {
              // Update state so subsequent callers see the fresh token
              currentCreds = {
                accessToken: 'shpat_fresh_concurrent_token',
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
                refreshToken: 'shprf_refreshed_once',
                scope: 'read_orders',
              };
              return {};
            }),
          },
          auditLog: { create: jest.fn() },
        };
        return await cb(tx);
      } finally {
        isLocked = false;
      }
    });

    const results = await Promise.all([
      service.getValidAccessToken('int-concurrent', mockFetch),
      service.getValidAccessToken('int-concurrent', mockFetch),
      service.getValidAccessToken('int-concurrent', mockFetch),
      service.getValidAccessToken('int-concurrent', mockFetch),
      service.getValidAccessToken('int-concurrent', mockFetch),
    ]);

    // All 5 callers received the fresh token
    results.forEach((token) => expect(token).toBe('shpat_fresh_concurrent_token'));
    // But only 1 call to Shopify was made!
    expect(callCount).toBe(1);
  });

  it('retains stored refresh token on transient failure (network/5xx)', async () => {
    const expiredCreds = {
      accessToken: 'shpat_expired',
      expiresAt: new Date(Date.now() - 60000).toISOString(),
      refreshToken: 'shprf_keep_safe',
    };

    prisma.integration.findUnique.mockResolvedValue({
      id: 'int-3',
      status: 'CONNECTED',
      shopDomain: 'store.myshopify.com',
      encryptedCredentials: encryptCredentials(expiredCreds, mockMasterKey),
    });

    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    } as any);

    await expect(service.getValidAccessToken('int-3', mockFetch)).rejects.toThrow(ShopifyClientError);
    // Integration record was NOT marked degraded or destroyed on transient failure
    expect(prisma.integration.update).not.toHaveBeenCalled();
  });

  it('marks integration DEGRADED and records audit log on permanent refresh failure', async () => {
    const expiredCreds = {
      accessToken: 'shpat_expired',
      expiresAt: new Date(Date.now() - 60000).toISOString(),
      refreshToken: 'shprf_invalidated',
    };

    prisma.integration.findUnique.mockResolvedValue({
      id: 'int-4',
      organizationId: 'org-4',
      status: 'CONNECTED',
      shopDomain: 'store.myshopify.com',
      encryptedCredentials: encryptCredentials(expiredCreds, mockMasterKey),
    });
    prisma.integration.update.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});

    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token revoked' }),
    } as any);

    await expect(service.getValidAccessToken('int-4', mockFetch)).rejects.toThrow(ShopifyAuthenticationError);

    // Integration marked degraded
    expect(prisma.integration.update).toHaveBeenCalledWith({
      where: { id: 'int-4' },
      data: { status: 'DEGRADED' },
    });

    // Reauth required audit log written
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-4',
        entityId: 'int-4',
        action: 'SHOPIFY_INTEGRATION_REAUTH_REQUIRED',
      }),
    });
  });
});
