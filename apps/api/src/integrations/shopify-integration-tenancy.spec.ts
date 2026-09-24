import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  Role,
  IntegrationStatus,
  IntegrationProvider,
  OperationalMode,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
  IntegrationEventStatus,
  ExternalOrderStatus,
} from '@reloop/database';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';

describe('Audit Remediation E-04: Shopify Integration Ownership Tenancy & Immutability', () => {
  let prisma: PrismaService;
  let service: ShopifyOAuthService;
  let configService: ConfigService;
  let realtimePublisher: RealtimePublisher;

  const mockClientSecret = 'shpss_test_e04_secret_12345';
  const mockClientId = 'shp_client_e04_12345';
  const mockMasterKey =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;
  let userBId: string;

  let mismatchedAuditCount: number = -1;

  function buildCallbackQuery(
    shopDomain: string,
    state: string,
    extraParams?: Record<string, string>,
  ) {
    const code = 'mock_auth_code_' + Math.random().toString(36).substring(2);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const params: Record<string, string> = {
      code,
      shop: shopDomain,
      state,
      timestamp,
      ...extraParams,
    };
    const sortedKeys = Object.keys(params).sort();
    const message = sortedKeys.map((k) => `${k}=${params[k]}`).join('&');
    const hmac = crypto
      .createHmac('sha256', mockClientSecret)
      .update(message)
      .digest('hex');
    return { ...params, hmac };
  }

  function createMockFetch(shopDomain: string) {
    return jest.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/admin/oauth/access_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shpat_mock_' + Math.random().toString(36).substring(2),
            scope: 'read_orders',
            expires_in: 86400,
            refresh_token: 'shprf_mock_' + Math.random().toString(36).substring(2),
            refresh_token_expires_in: 7776000,
          }),
        } as any;
      }
      if (urlStr.includes('/graphql.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              shop: {
                id: 'gid://shopify/Shop/' + Math.floor(Math.random() * 100000),
                myshopifyDomain: shopDomain,
                name: 'Store ' + shopDomain,
              },
            },
          }),
        } as any;
      }
      return {
        ok: false,
        status: 404,
        text: async () => 'Not found',
      } as any;
    }) as any;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    // 1. Mandatory local database audit query (Item 26 of Final Report)
    const auditQueryResults = await prisma.$queryRaw<
      Array<{ table_name: string; mismatched_count: bigint }>
    >`
      SELECT 'external_orders' as table_name, count(*) as mismatched_count
      FROM external_orders eo
      JOIN integrations i ON eo.primary_integration_id = i.id
      WHERE eo.organization_id != i.organization_id
      UNION ALL
      SELECT 'external_references', count(*)
      FROM external_references er
      JOIN integrations i ON er.integration_id = i.id
      WHERE er.organization_id != i.organization_id
      UNION ALL
      SELECT 'integration_events', count(*)
      FROM integration_events ie
      JOIN integrations i ON ie.integration_id = i.id
      WHERE ie.organization_id != i.organization_id
      UNION ALL
      SELECT 'recovery_cases', count(*)
      FROM recovery_cases rc
      JOIN integrations i ON rc.source_integration_id = i.id
      WHERE rc.organization_id != i.organization_id;
    `;

    mismatchedAuditCount = auditQueryResults.reduce(
      (sum, row) => sum + Number(row.mismatched_count),
      0,
    );

    console.log(
      `[E-04 Audit] Existing mismatched child rows across all organizations: ${mismatchedAuditCount}`,
    );

    configService = new ConfigService({
      shopifyClientId: mockClientId,
      shopifyClientSecret: mockClientSecret,
      shopifyScopes: 'read_orders',
      shopifyRedirectUri: 'http://localhost:3101/integrations/shopify/callback',
      integrationEncryptionKey: mockMasterKey,
    });

    realtimePublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;

    service = new ShopifyOAuthService(prisma, configService, realtimePublisher);

    // Seed test organizations and users
    const runId = Math.random().toString(36).substring(2, 8);
    const orgA = await prisma.organization.create({
      data: {
        name: `Tenant A E04-${runId}`,
        slug: `tenant-a-e04-${runId}`,
      },
    });
    tenantAId = orgA.id;

    const orgB = await prisma.organization.create({
      data: {
        name: `Tenant B E04-${runId}`,
        slug: `tenant-b-e04-${runId}`,
      },
    });
    tenantBId = orgB.id;

    const uA = await prisma.user.create({
      data: {
        email: `usera-${runId}@example.com`,
        name: 'User A',
        passwordHash: 'argon2_mock_hash_a',
      },
    });
    userAId = uA.id;

    const uB = await prisma.user.create({
      data: {
        email: `userb-${runId}@example.com`,
        name: 'User B',
        passwordHash: 'argon2_mock_hash_b',
      },
    });
    userBId = uB.id;

    await prisma.organizationMember.createMany({
      data: [
        { organizationId: tenantAId, userId: userAId, role: Role.ADMIN },
        { organizationId: tenantBId, userId: userBId, role: Role.ADMIN },
      ],
    });
  });

  afterAll(async () => {
    if (prisma && tenantAId && tenantBId) {
      await prisma.job
        .deleteMany({
          where: { organizationId: { in: [tenantAId, tenantBId] } },
        })
        .catch(() => {});
      await prisma.auditLog
        .deleteMany({
          where: { organizationId: { in: [tenantAId, tenantBId] } },
        })
        .catch(() => {});
      await prisma.recoveryCase
        .deleteMany({
          where: { organizationId: { in: [tenantAId, tenantBId] } },
        })
        .catch(() => {});
      await prisma.externalReference
        .deleteMany({
          where: { organizationId: { in: [tenantAId, tenantBId] } },
        })
        .catch(() => {});
      await prisma.externalOrder
        .deleteMany({
          where: { organizationId: { in: [tenantAId, tenantBId] } },
        })
        .catch(() => {});
      await prisma.integrationEvent
        .deleteMany({
          where: { organizationId: { in: [tenantAId, tenantBId] } },
        })
        .catch(() => {});
      await prisma.oAuthState
        .deleteMany({
          where: { organizationId: { in: [tenantAId, tenantBId] } },
        })
        .catch(() => {});
      await prisma.integration
        .deleteMany({
          where: { organizationId: { in: [tenantAId, tenantBId] } },
        })
        .catch(() => {});
      await prisma.organizationMember
        .deleteMany({
          where: { organizationId: { in: [tenantAId, tenantBId] } },
        })
        .catch(() => {});
      await prisma.user
        .deleteMany({
          where: { id: { in: [userAId, userBId] } },
        })
        .catch(() => {});
      await prisma.organization
        .deleteMany({
          where: { id: { in: [tenantAId, tenantBId] } },
        })
        .catch(() => {});
    }

    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
  });

  describe('1. Read-Only Local Database Audit', () => {
    it('verifies zero existing mismatched child records across database tables', () => {
      expect(mismatchedAuditCount).toBe(0);
    });
  });

  describe('2. Cross-Tenant Connection Initiation Rejection', () => {
    it('rejects initiateConnect when shop is currently CONNECTED to another organization', async () => {
      const shop = `tenant-a-active-${Date.now()}.myshopify.com`;
      await prisma.integration.create({
        data: {
          organizationId: tenantAId,
          provider: IntegrationProvider.SHOPIFY,
          name: 'Store Active',
          shopDomain: shop,
          status: IntegrationStatus.CONNECTED,
          mode: OperationalMode.OBSERVE,
        },
      });

      await expect(
        service.initiateConnect(tenantBId, userBId, shop),
      ).rejects.toThrow(ConflictException);

      await expect(
        service.initiateConnect(tenantBId, userBId, shop),
      ).rejects.toThrow(
        'This Shopify store is already associated with another organization.',
      );
    });

    it('rejects initiateConnect when shop belongs to another organization even when DISCONNECTED', async () => {
      const shop = `tenant-a-disco-${Date.now()}.myshopify.com`;
      await prisma.integration.create({
        data: {
          organizationId: tenantAId,
          provider: IntegrationProvider.SHOPIFY,
          name: 'Store Disconnected',
          shopDomain: shop,
          status: IntegrationStatus.DISCONNECTED,
          mode: OperationalMode.OBSERVE,
        },
      });

      // Tenant B attempt MUST be rejected even though status is DISCONNECTED
      await expect(
        service.initiateConnect(tenantBId, userBId, shop),
      ).rejects.toThrow(ConflictException);

      // Verify no OAuthState was created for Tenant B
      const states = await prisma.oAuthState.findMany({
        where: { shopDomain: shop, organizationId: tenantBId },
      });
      expect(states).toHaveLength(0);
    });
  });

  describe('3. Cross-Tenant Callback Rejection & Ownership Immutability', () => {
    it('rejects handleCallback when shop belongs to another tenant even when DISCONNECTED', async () => {
      const shop = `tenant-a-cb-disco-${Date.now()}.myshopify.com`;
      const integrationA = await prisma.integration.create({
        data: {
          organizationId: tenantAId,
          provider: IntegrationProvider.SHOPIFY,
          name: 'Store CB Disconnected',
          shopDomain: shop,
          status: IntegrationStatus.DISCONNECTED,
          mode: OperationalMode.OBSERVE,
        },
      });

      // Simulate Tenant B obtaining OAuth state (e.g. bypassing initiateConnect or race)
      const stateB = 'state_tenant_b_' + Math.random().toString(36).substring(2);
      await prisma.oAuthState.create({
        data: {
          state: stateB,
          organizationId: tenantBId,
          userId: userBId,
          provider: 'SHOPIFY',
          shopDomain: shop,
          expiresAt: new Date(Date.now() + 600000),
        },
      });

      const query = buildCallbackQuery(shop, stateB);
      const mockFetch = createMockFetch(shop);

      await expect(service.handleCallback(query, mockFetch)).rejects.toThrow(
        ConflictException,
      );

      // Verify Tenant A's integration row remains completely intact and owned by Tenant A
      const freshIntegration = await prisma.integration.findUnique({
        where: { id: integrationA.id },
      });
      expect(freshIntegration).not.toBeNull();
      expect(freshIntegration!.organizationId).toBe(tenantAId);
      expect(freshIntegration!.status).toBe(IntegrationStatus.DISCONNECTED);

      // Verify NO integration exists for Tenant B
      const tenantBIntegration = await prisma.integration.findFirst({
        where: { organizationId: tenantBId, shopDomain: shop },
      });
      expect(tenantBIntegration).toBeNull();
    });

    it('rejects handleCallback when shop is CONNECTED to another tenant', async () => {
      const shop = `tenant-a-cb-conn-${Date.now()}.myshopify.com`;
      const integrationA = await prisma.integration.create({
        data: {
          organizationId: tenantAId,
          provider: IntegrationProvider.SHOPIFY,
          name: 'Store CB Connected',
          shopDomain: shop,
          status: IntegrationStatus.CONNECTED,
          mode: OperationalMode.OBSERVE,
        },
      });

      const stateB = 'state_tenant_b_conn_' + Math.random().toString(36).substring(2);
      await prisma.oAuthState.create({
        data: {
          state: stateB,
          organizationId: tenantBId,
          userId: userBId,
          provider: 'SHOPIFY',
          shopDomain: shop,
          expiresAt: new Date(Date.now() + 600000),
        },
      });

      const query = buildCallbackQuery(shop, stateB);
      const mockFetch = createMockFetch(shop);

      await expect(service.handleCallback(query, mockFetch)).rejects.toThrow(
        ConflictException,
      );

      const freshIntegration = await prisma.integration.findUnique({
        where: { id: integrationA.id },
      });
      expect(freshIntegration!.organizationId).toBe(tenantAId);
      expect(freshIntegration!.status).toBe(IntegrationStatus.CONNECTED);
    });
  });

  describe('4. Case B: Same-Tenant Reconnect & Ownership Preservation', () => {
    it('allows same-tenant reconnect and keeps organizationId unchanged', async () => {
      const shop = `tenant-a-reconnect-${Date.now()}.myshopify.com`;
      const originalIntegration = await prisma.integration.create({
        data: {
          organizationId: tenantAId,
          provider: IntegrationProvider.SHOPIFY,
          name: 'Original Store Name',
          shopDomain: shop,
          status: IntegrationStatus.DISCONNECTED,
          mode: OperationalMode.OBSERVE,
        },
      });

      // Tenant A initiates connect
      const { state } = await service.initiateConnect(tenantAId, userAId, shop);
      expect(state).toBeDefined();

      // Tenant A completes callback
      const query = buildCallbackQuery(shop, state);
      const mockFetch = createMockFetch(shop);

      const result = await service.handleCallback(query, mockFetch);
      expect(result.success).toBe(true);
      expect(result.integrationId).toBe(originalIntegration.id);

      // Verify the integration record in DB
      const updated = await prisma.integration.findUnique({
        where: { id: originalIntegration.id },
      });
      expect(updated).not.toBeNull();
      expect(updated!.organizationId).toBe(tenantAId); // IMMUTABLE
      expect(updated!.status).toBe(IntegrationStatus.CONNECTED); // Reconnected
      expect(updated!.encryptedCredentials).not.toBeNull();
    });
  });

  describe('5. Historical Data Integrity: Child Rows Preservation', () => {
    it('preserves all historical child rows under Tenant A across attacks and reconnects', async () => {
      const shop = `tenant-a-history-${Date.now()}.myshopify.com`;
      const integrationA = await prisma.integration.create({
        data: {
          organizationId: tenantAId,
          provider: IntegrationProvider.SHOPIFY,
          name: 'Historical Store',
          shopDomain: shop,
          status: IntegrationStatus.DISCONNECTED,
          mode: OperationalMode.OBSERVE,
        },
      });

      // Create historical child rows
      const externalOrder = await prisma.externalOrder.create({
        data: {
          organizationId: tenantAId,
          primaryIntegrationId: integrationA.id,
          externalOrderNumber: `ORD-HIST-${Date.now()}`,
          status: ExternalOrderStatus.SHIPPED,
        },
      });

      const externalRef = await prisma.externalReference.create({
        data: {
          organizationId: tenantAId,
          externalOrderId: externalOrder.id,
          integrationId: integrationA.id,
          resourceType: 'ORDER',
          externalId: 'ext_order_12345',
        },
      });

      const integrationEvent = await prisma.integrationEvent.create({
        data: {
          organizationId: tenantAId,
          integrationId: integrationA.id,
          providerEventId: `evt_hist_${Date.now()}`,
          eventType: 'orders/create',
          payload: { order_number: 1001 },
          status: IntegrationEventStatus.PROCESSED,
        },
      });

      const recoveryCase = await prisma.recoveryCase.create({
        data: {
          organizationId: tenantAId,
          sourceIntegrationId: integrationA.id,
          externalOrderId: externalOrder.id,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          status: RecoveryCaseStatus.RESOLVED,
          summary: 'Historical resolved recovery case',
        },
      });

      // 1. Tenant B attack via initiateConnect
      await expect(
        service.initiateConnect(tenantBId, userBId, shop),
      ).rejects.toThrow(ConflictException);

      // 2. Tenant B attack via handleCallback
      const fakeStateB = 'state_fake_b_' + Math.random().toString(36).substring(2);
      await prisma.oAuthState.create({
        data: {
          state: fakeStateB,
          organizationId: tenantBId,
          userId: userBId,
          provider: 'SHOPIFY',
          shopDomain: shop,
          expiresAt: new Date(Date.now() + 600000),
        },
      });
      const queryB = buildCallbackQuery(shop, fakeStateB);
      await expect(
        service.handleCallback(queryB, createMockFetch(shop)),
      ).rejects.toThrow(ConflictException);

      // 3. Tenant A legitimate reconnect
      const { state: validStateA } = await service.initiateConnect(
        tenantAId,
        userAId,
        shop,
      );
      const queryA = buildCallbackQuery(shop, validStateA);
      const reconnectResult = await service.handleCallback(
        queryA,
        createMockFetch(shop),
      );
      expect(reconnectResult.success).toBe(true);

      // 4. Assert all historical child rows remain owned by Tenant A and linked to integrationA
      const freshOrder = await prisma.externalOrder.findUnique({
        where: { id: externalOrder.id },
      });
      expect(freshOrder!.organizationId).toBe(tenantAId);
      expect(freshOrder!.primaryIntegrationId).toBe(integrationA.id);

      const freshRef = await prisma.externalReference.findUnique({
        where: { id: externalRef.id },
      });
      expect(freshRef!.organizationId).toBe(tenantAId);
      expect(freshRef!.integrationId).toBe(integrationA.id);

      const freshEvent = await prisma.integrationEvent.findUnique({
        where: { id: integrationEvent.id },
      });
      expect(freshEvent!.organizationId).toBe(tenantAId);
      expect(freshEvent!.integrationId).toBe(integrationA.id);

      const freshCase = await prisma.recoveryCase.findUnique({
        where: { id: recoveryCase.id },
      });
      expect(freshCase!.organizationId).toBe(tenantAId);
      expect(freshCase!.sourceIntegrationId).toBe(integrationA.id);

      // 5. Run audit query on these specific records
      const audit = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) as count
        FROM external_orders eo
        JOIN integrations i ON eo.primary_integration_id = i.id
        WHERE eo.id = ${externalOrder.id}::uuid AND eo.organization_id != i.organization_id;
      `;
      expect(Number(audit[0].count)).toBe(0);
    });
  });

  describe('6. Concurrency & Race Condition Safety', () => {
    it('concurrent cross-tenant callbacks result in exactly one winner and one safe ConflictException', async () => {
      const shop = `tenant-race-cross-${Date.now()}.myshopify.com`;

      // Both tenants have valid unconsumed OAuth states
      const stateA = 'state_race_a_' + Math.random().toString(36).substring(2);
      const stateB = 'state_race_b_' + Math.random().toString(36).substring(2);

      await prisma.oAuthState.createMany({
        data: [
          {
            state: stateA,
            organizationId: tenantAId,
            userId: userAId,
            provider: 'SHOPIFY',
            shopDomain: shop,
            expiresAt: new Date(Date.now() + 600000),
          },
          {
            state: stateB,
            organizationId: tenantBId,
            userId: userBId,
            provider: 'SHOPIFY',
            shopDomain: shop,
            expiresAt: new Date(Date.now() + 600000),
          },
        ],
      });

      const queryA = buildCallbackQuery(shop, stateA);
      const queryB = buildCallbackQuery(shop, stateB);

      // Execute concurrently
      const results = await Promise.allSettled([
        service.handleCallback(queryA, createMockFetch(shop)),
        service.handleCallback(queryB, createMockFetch(shop)),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // Assert loser received safe ConflictException
      const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectionReason).toBeInstanceOf(ConflictException);
      expect(rejectionReason.message).toBe(
        'This Shopify store is already associated with another organization.',
      );

      // Assert DB has exactly 1 integration for this store domain
      const dbIntegrations = await prisma.integration.findMany({
        where: { shopDomain: shop },
      });
      expect(dbIntegrations).toHaveLength(1);
      const winner = dbIntegrations[0];
      expect([tenantAId, tenantBId]).toContain(winner.organizationId);
    });

    it('concurrent same-tenant callbacks result in exactly one Integration record', async () => {
      const shop = `tenant-race-same-${Date.now()}.myshopify.com`;

      const state1 = 'state_race_s1_' + Math.random().toString(36).substring(2);
      const state2 = 'state_race_s2_' + Math.random().toString(36).substring(2);

      await prisma.oAuthState.createMany({
        data: [
          {
            state: state1,
            organizationId: tenantAId,
            userId: userAId,
            provider: 'SHOPIFY',
            shopDomain: shop,
            expiresAt: new Date(Date.now() + 600000),
          },
          {
            state: state2,
            organizationId: tenantAId,
            userId: userAId,
            provider: 'SHOPIFY',
            shopDomain: shop,
            expiresAt: new Date(Date.now() + 600000),
          },
        ],
      });

      const query1 = buildCallbackQuery(shop, state1);
      const query2 = buildCallbackQuery(shop, state2);

      const results = await Promise.allSettled([
        service.handleCallback(query1, createMockFetch(shop)),
        service.handleCallback(query2, createMockFetch(shop)),
      ]);

      // Both should fulfill (one creates, the other updates the created integration)
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');

      const integrations = await prisma.integration.findMany({
        where: { shopDomain: shop },
      });
      expect(integrations).toHaveLength(1);
      expect(integrations[0].organizationId).toBe(tenantAId);
    });
  });

  describe('7. Security & Tenant Privacy', () => {
    it('strictly derives organizationId from OAuthState and ignores query params', async () => {
      const shop = `tenant-sec-param-${Date.now()}.myshopify.com`;

      const stateA = 'state_sec_a_' + Math.random().toString(36).substring(2);
      await prisma.oAuthState.create({
        data: {
          state: stateA,
          organizationId: tenantAId,
          userId: userAId,
          provider: 'SHOPIFY',
          shopDomain: shop,
          expiresAt: new Date(Date.now() + 600000),
        },
      });

      // Attacker attempts to inject organizationId or orgId query parameters
      const queryWithInjection = buildCallbackQuery(shop, stateA, {
        organizationId: tenantBId,
        orgId: tenantBId,
      });

      const result = await service.handleCallback(
        queryWithInjection,
        createMockFetch(shop),
      );
      expect(result.success).toBe(true);

      const created = await prisma.integration.findUnique({
        where: { id: result.integrationId },
      });
      expect(created!.organizationId).toBe(tenantAId); // Not tenantBId!
    });

    it('conflict message does NOT leak tenant IDs, tenant names, or sensitive tokens', async () => {
      const shop = `tenant-privacy-${Date.now()}.myshopify.com`;
      await prisma.integration.create({
        data: {
          organizationId: tenantAId,
          provider: IntegrationProvider.SHOPIFY,
          name: 'Super Secret Tenant Brand',
          shopDomain: shop,
          status: IntegrationStatus.CONNECTED,
          mode: OperationalMode.OBSERVE,
        },
      });

      try {
        await service.initiateConnect(tenantBId, userBId, shop);
        fail('Expected initiateConnect to throw ConflictException');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.message).not.toContain(tenantAId);
        expect(err.message).not.toContain('Super Secret Tenant Brand');
        expect(err.message).toBe(
          'This Shopify store is already associated with another organization.',
        );
      }
    });
  });
});
