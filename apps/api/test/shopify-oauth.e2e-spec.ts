import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for E2E tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.INTEGRATION_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SHOPIFY_CLIENT_ID = 'shopify_test_client_id';
process.env.SHOPIFY_CLIENT_SECRET = 'shopify_test_client_secret_123';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Role } from '@reloop/database';
import { SecurityUtil } from '../src/auth/security.util';
import { decryptCredentials } from '@reloop/connector-shopify';

describe('Shopify OAuth & Credential Security E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let ownerToken: string;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let orgId: string;
  let otherOrgId: string;

  const clientSecret = 'shopify_test_client_secret_123';
  const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeAll(async () => {
    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
    prisma = app.get(PrismaService);

    // Clean test database tables
    await prisma.approval.deleteMany({});
    await prisma.workflowStep.deleteMany({});
    await prisma.workflow.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.integrationEvent.deleteMany({});
    await prisma.externalReference.deleteMany({});
    await prisma.externalOrder.deleteMany({});
    await prisma.oAuthState.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.integration.deleteMany({});
    await prisma.refreshSession.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});

    // Seed Primary Organization
    const primaryOrg = await prisma.organization.create({
      data: { name: 'Acme Shopify Brand', slug: 'acme-shopify' },
    });
    orgId = primaryOrg.id;

    // Seed Secondary Organization (for tenant isolation tests)
    const secondaryOrg = await prisma.organization.create({
      data: { name: 'Other Merchant Org', slug: 'other-merchant' },
    });
    otherOrgId = secondaryOrg.id;

    // Helper to create users with access tokens
    const createUser = async (email: string, role: Role, organizationId: string) => {
      const passwordHash = await SecurityUtil.hashPassword('Password123!');
      const user = await prisma.user.create({
        data: { email, name: email.split('@')[0], passwordHash },
      });
      await prisma.organizationMember.create({
        data: { organizationId, userId: user.id, role },
      });
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'Password123!' });
      return loginRes.body.accessToken as string;
    };

    ownerToken = await createUser('owner@acme.com', Role.OWNER, orgId);
    adminToken = await createUser('admin@acme.com', Role.ADMIN, orgId);
    operatorToken = await createUser('operator@acme.com', Role.OPERATOR, orgId);
    viewerToken = await createUser('viewer@acme.com', Role.VIEWER, orgId);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. RBAC on Connect Endpoint (POST /integrations/shopify/connect)', () => {
    it('allows OWNER to initiate connection', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/shopify/connect')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ shop: 'acme-brand.myshopify.com' });

      expect(res.status).toBe(201);
      expect(res.body.authorizationUrl).toContain('https://acme-brand.myshopify.com/admin/oauth/authorize');
      expect(res.body.state).toBeDefined();
      expect(res.body.shopDomain).toBe('acme-brand.myshopify.com');
    });

    it('allows ADMIN to initiate connection', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/shopify/connect')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ shop: 'acme-brand-2.myshopify.com' });

      expect(res.status).toBe(201);
      expect(res.body.authorizationUrl).toBeDefined();
    });

    it('blocks OPERATOR with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/shopify/connect')
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ shop: 'operator-store.myshopify.com' });

      expect(res.status).toBe(403);
    });

    it('blocks VIEWER with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .post('/integrations/shopify/connect')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ shop: 'viewer-store.myshopify.com' });

      expect(res.status).toBe(403);
    });
  });

  describe('2. Shop Domain Validation & SSRF Guard', () => {
    it('rejects invalid or SSRF domains during connect', async () => {
      const dangerousDomains = [
        'localhost',
        '127.0.0.1',
        '169.254.169.254',
        'evil.com',
        'store.myshopify.com.evil.com',
        'store.myshopify.com:8080',
        'store.myshopify.com/path',
      ];

      for (const domain of dangerousDomains) {
        const res = await request(app.getHttpServer())
          .post('/integrations/shopify/connect')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ shop: domain });

        expect(res.status).toBeGreaterThanOrEqual(400);
      }
    });
  });

  describe('3. Public OAuth Callback & HMAC Validation (GET /integrations/shopify/callback)', () => {
    let activeState: string;

    beforeEach(async () => {
      // Initiate connection to generate valid state in DB
      const res = await request(app.getHttpServer())
        .post('/integrations/shopify/connect')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ shop: 'test-oauth-store.myshopify.com' });
      activeState = res.body.state;
    });

    it('rejects callback with invalid HMAC signature with 401 Unauthorized', async () => {
      const res = await request(app.getHttpServer()).get('/integrations/shopify/callback').query({
        code: 'auth_code_xyz',
        shop: 'test-oauth-store.myshopify.com',
        state: activeState,
        hmac: 'invalid_hmac_hex_value',
      });

      expect(res.status).toBe(401);
    });

    it('rejects callback with expired or unknown state with 400 BadRequest', async () => {
      const unknownState = 'unknown_state_12345';
      const message = `code=code123&shop=test-oauth-store.myshopify.com&state=${unknownState}`;
      const hmac = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');

      const res = await request(app.getHttpServer()).get('/integrations/shopify/callback').query({
        code: 'code123',
        shop: 'test-oauth-store.myshopify.com',
        state: unknownState,
        hmac,
      });

      expect(res.status).toBe(400);
    });
  });

  describe('4. Status Endpoint & Zero Plaintext Credential Exposure', () => {
    let integrationId: string;

    beforeAll(async () => {
      // Create a test integration with encrypted credentials directly in DB
      const creds = {
        accessToken: 'shpat_super_secret_token_never_expose',
        refreshToken: 'shprf_super_secret_refresh_never_expose',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        scope: 'read_orders',
      };

      const encrypted = require('@reloop/connector-shopify').encryptCredentials(creds, masterKey);

      const integration = await prisma.integration.create({
        data: {
          organizationId: orgId,
          provider: 'SHOPIFY',
          name: 'Acme Production Store',
          status: 'CONNECTED',
          mode: 'OBSERVE',
          shopDomain: 'acme-prod.myshopify.com',
          encryptedCredentials: encrypted,
          configuration: {
            scopes: ['read_orders', 'read_inventory', 'read_locations'],
          },
        },
      });

      integrationId = integration.id;
    });

    it('allows VIEWER to inspect status, but NEVER exposes token or credentials', async () => {
      const res = await request(app.getHttpServer())
        .get(`/integrations/${integrationId}/status`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(integrationId);
      expect(res.body.provider).toBe('SHOPIFY');
      expect(res.body.status).toBe('CONNECTED');
      expect(res.body.shopDomain).toBe('acme-prod.myshopify.com');
      expect(res.body.scopes).toEqual(['read_orders', 'read_inventory', 'read_locations']);

      // CRITICAL: verify no token material is returned in JSON response
      const jsonStr = JSON.stringify(res.body);
      expect(jsonStr).not.toContain('shpat_');
      expect(jsonStr).not.toContain('shprf_');
      expect(jsonStr).not.toContain('encryptedCredentials');
      expect(jsonStr).not.toContain('ciphertext');
      expect(res.body.encryptedCredentials).toBeUndefined();
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
    });

    it('blocks access from a different organization (tenant boundary)', async () => {
      // Create user in other organization
      const otherOrgUserToken = await (async () => {
        const passwordHash = await SecurityUtil.hashPassword('Password123!');
        const user = await prisma.user.create({
          data: { email: 'other@merchant.com', name: 'Other', passwordHash },
        });
        await prisma.organizationMember.create({
          data: { organizationId: otherOrgId, userId: user.id, role: Role.ADMIN },
        });
        const loginRes = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'other@merchant.com', password: 'Password123!' });
        return loginRes.body.accessToken as string;
      })();

      const res = await request(app.getHttpServer())
        .get(`/integrations/${integrationId}/status`)
        .set('Authorization', `Bearer ${otherOrgUserToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe('5. Disconnect Endpoint (POST /integrations/:id/disconnect)', () => {
    let disconnectIntegrationId: string;

    beforeEach(async () => {
      const creds = {
        accessToken: 'shpat_to_be_disconnected',
        scope: 'read_orders',
      };
      const encrypted = require('@reloop/connector-shopify').encryptCredentials(creds, masterKey);

      const integration = await prisma.integration.create({
        data: {
          organizationId: orgId,
          provider: 'SHOPIFY',
          name: 'Disconnect Test Store',
          status: 'CONNECTED',
          shopDomain: `disconnect-${Date.now()}.myshopify.com`,
          encryptedCredentials: encrypted,
        },
      });
      disconnectIntegrationId = integration.id;
    });

    it('blocks OPERATOR and VIEWER from disconnecting', async () => {
      const resOp = await request(app.getHttpServer())
        .post(`/integrations/${disconnectIntegrationId}/disconnect`)
        .set('Authorization', `Bearer ${operatorToken}`);
      expect(resOp.status).toBe(403);

      const resView = await request(app.getHttpServer())
        .post(`/integrations/${disconnectIntegrationId}/disconnect`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(resView.status).toBe(403);
    });

    it('allows OWNER to disconnect: blanks credentials and logs audit entry', async () => {
      const res = await request(app.getHttpServer())
        .post(`/integrations/${disconnectIntegrationId}/disconnect`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const updated = await prisma.integration.findUnique({
        where: { id: disconnectIntegrationId },
      });

      expect(updated?.status).toBe('DISCONNECTED');
      expect(updated?.encryptedCredentials).toBeNull();

      const audit = await prisma.auditLog.findFirst({
        where: {
          entityId: disconnectIntegrationId,
          action: 'SHOPIFY_INTEGRATION_DISCONNECTED',
        },
      });
      expect(audit).toBeDefined();
    });
  });

  describe('6. Durable Initial Sync & Crash-Recovery E2E', () => {
    it('enqueues durable Job during OAuth callback and allows replacement processor to execute sync after simulated crash', async () => {
      // 1. Initiate OAuth to get valid state
      const connectRes = await request(app.getHttpServer())
        .post('/integrations/shopify/connect')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ shop: 'crash-recovery-store.myshopify.com' });

      expect(connectRes.status).toBe(201);
      const state = connectRes.body.state;

      // 2. Prepare callback with valid HMAC
      const message = `code=crash_code_123&shop=crash-recovery-store.myshopify.com&state=${state}`;
      const hmac = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');

      // Mock fetch for token exchange and shop identity
      const originalFetch = globalThis.fetch;
      const mockFetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shpat_crash_recovery_token',
            scope: 'read_orders',
            expires_in: 3600,
            refresh_token: 'shprf_crash_refresh_token',
            refresh_token_expires_in: 7776000,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              shop: {
                id: 'gid://shopify/Shop/8888',
                myshopifyDomain: 'crash-recovery-store.myshopify.com',
                name: 'Crash Recovery Store',
              },
            },
          }),
        });

      globalThis.fetch = mockFetch as any;

      try {
        // 3. Callback succeeds and returns fast (zero in-memory fire-and-forget sync)
        const callbackRes = await request(app.getHttpServer())
          .get('/integrations/shopify/callback')
          .query({
            code: 'crash_code_123',
            shop: 'crash-recovery-store.myshopify.com',
            state,
            hmac,
          });

        expect(callbackRes.status).toBe(200);
        expect(callbackRes.body.success).toBe(true);
        const integrationId = callbackRes.body.integrationId;

        // 4. Verify durable Job was committed to DB before sync starts
        const durableJob = await prisma.job.findFirst({
          where: {
            organizationId: orgId,
            type: 'SHOPIFY_SYNC_ORDERS',
            payload: {
              path: ['integrationId'],
              equals: integrationId,
            },
          },
        });

        expect(durableJob).toBeDefined();
        expect(durableJob?.status).toBe('QUEUED');

        // Verify Integration shows initialSyncStatus: PENDING
        const integrationBeforeSync = await prisma.integration.findUnique({
          where: { id: integrationId },
        });
        const configBefore = (integrationBeforeSync?.configuration as Record<string, any>) || {};
        expect(configBefore.initialSyncStatus).toBe('PENDING');

        // 5. Simulate API Process Crash & Replacement Processor Startup
        // The API process is "dead". We now start the replacement processor (ShopifySyncService)
        const syncService = app.get(require('../src/integrations/shopify-sync.service').ShopifySyncService);

        const mockGraphQLFetch = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              orders: {
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/Order/888801',
                      name: '#888801',
                      createdAt: '2026-09-01T10:00:00Z',
                      updatedAt: '2026-09-01T10:00:00Z',
                      displayFulfillmentStatus: 'UNFULFILLED',
                      displayFinancialStatus: 'PAID',
                      totalPriceSet: { shopMoney: { amount: '75.00', currencyCode: 'USD' } },
                      lineItems: { edges: [] },
                      fulfillments: [],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        });

        const sweepResult = await syncService.processPendingSyncJobs({ fetchFn: mockGraphQLFetch });
        expect(sweepResult.processed).toBeGreaterThanOrEqual(1);
        expect(sweepResult.successful).toBeGreaterThanOrEqual(1);

        // 6. Verify Job moved to SUCCEEDED and Integration to COMPLETED
        const jobAfterSync = await prisma.job.findUnique({
          where: { id: durableJob!.id },
        });
        expect(jobAfterSync?.status).toBe('SUCCEEDED');

        const integrationAfterSync = await prisma.integration.findUnique({
          where: { id: integrationId },
        });
        const configAfter = (integrationAfterSync?.configuration as Record<string, any>) || {};
        expect(configAfter.initialSyncStatus).toBe('COMPLETED');
        expect(configAfter.lastSyncOrdersCount).toBe(1);

        // 7. Verify projected order exists
        const externalOrder = await prisma.externalOrder.findFirst({
          where: {
            organizationId: orgId,
            externalOrderNumber: '888801',
          },
        });
        expect(externalOrder).toBeDefined();

        // 8. Re-run sweep (idempotency check: at-least-once retry)
        // Ensure rereading same page does not create duplicate orders or RecoveryCases
        await syncService.syncRecentOrders(integrationId, { fetchFn: mockGraphQLFetch });

        const externalOrderCount = await prisma.externalOrder.count({
          where: {
            organizationId: orgId,
            externalOrderNumber: '888801',
          },
        });
        expect(externalOrderCount).toBe(1);

        const recoveryCaseCount = await prisma.recoveryCase.count({
          where: { organizationId: orgId },
        });
        expect(recoveryCaseCount).toBe(0);

        // Invariant: Zero business mutations, workflows, or approvals triggered during sync
        const workflowCount = await prisma.workflow.count({
          where: { organizationId: orgId },
        });
        expect(workflowCount).toBe(0);

        const approvalCount = await prisma.approval.count({
          where: { organizationId: orgId },
        });
        expect(approvalCount).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
