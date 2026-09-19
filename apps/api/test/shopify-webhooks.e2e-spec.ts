import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for E2E tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.INTEGRATION_ENCRYPTION_KEY =
  process.env.INTEGRATION_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || 'shopify_test_client_id';
process.env.SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || 'shopify_test_client_secret_123';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';

import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Shopify Webhook Ingestion, Base64 HMAC & Tenant Isolation E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let orgId: string;
  let shopifyIntegrationId: string;
  let simulatorIntegrationId: string;
  const shopDomain = 'acme-webhook-store.myshopify.com';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET!;

  beforeAll(async () => {
    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    await app.init();
    prisma = app.get(PrismaService);

    // Clean test database
    await prisma.approval.deleteMany({});
    await prisma.workflowStep.deleteMany({});
    await prisma.workflow.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.integrationEvent.deleteMany({});
    await prisma.externalReference.deleteMany({});
    await prisma.externalOrder.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.integration.deleteMany({});
    await prisma.organization.deleteMany({});

    // Setup organization
    const org = await prisma.organization.create({
      data: { name: 'Acme Webhook Store Org', slug: 'acme-webhooks' },
    });
    orgId = org.id;

    // Create connected Shopify integration
    const shopifyIntegration = await prisma.integration.create({
      data: {
        organizationId: orgId,
        provider: 'SHOPIFY',
        name: 'Shopify Store',
        status: 'CONNECTED',
        shopDomain,
        configuration: {
          webhookSecret: clientSecret,
        },
      },
    });
    shopifyIntegrationId = shopifyIntegration.id;

    // Create connected Simulator integration for provider mismatch tests
    const simIntegration = await prisma.integration.create({
      data: {
        organizationId: orgId,
        provider: 'SIMULATOR',
        name: 'Simulator Store',
        status: 'CONNECTED',
      },
    });
    simulatorIntegrationId = simIntegration.id;
  });

  afterAll(async () => {
    await app.close();
  });

  function generateShopifyHmac(body: string, secret = clientSecret): string {
    return crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');
  }

  it('accepts valid Base64 signed Shopify orders/create webhook', async () => {
    const payload = JSON.stringify({
      id: 88776655,
      order_number: 2001,
      admin_graphql_api_id: 'gid://shopify/Order/88776655',
      fulfillment_status: null,
      line_items: [{ id: 1, sku: 'SKU-HOODIE', quantity: 1, title: 'Warm Hoodie' }],
    });

    const hmac = generateShopifyHmac(payload);
    const webhookId = crypto.randomUUID();

    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${shopifyIntegrationId}`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', webhookId)
      .set('X-Shopify-Topic', 'orders/create')
      .set('X-Shopify-Shop-Domain', shopDomain)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.providerEventId).toBe(webhookId);

    // Verify durable storage in database
    const savedEvent = await prisma.integrationEvent.findFirst({
      where: { providerEventId: webhookId },
    });
    expect(savedEvent).toBeDefined();
    expect(savedEvent?.organizationId).toBe(orgId);
  });

  it('rejects missing HMAC with 401', async () => {
    const payload = JSON.stringify({ id: 1 });
    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${shopifyIntegrationId}`)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(401);
  });

  it('rejects invalid HMAC with 401', async () => {
    const payload = JSON.stringify({ id: 2 });
    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${shopifyIntegrationId}`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', 'invalid_base64_hmac==')
      .send(payload);

    expect(res.status).toBe(401);
  });

  it('handles wrong-length or malformed HMAC safely without 500 error', async () => {
    const payload = JSON.stringify({ id: 3 });
    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${shopifyIntegrationId}`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', 'dG9vX3Nob3J0') // 9 bytes base64 decoded != 32
      .send(payload);

    expect(res.status).toBe(401);
  });

  it('deduplicates identical X-Shopify-Webhook-Id deliveries', async () => {
    const webhookId = crypto.randomUUID();
    const payload = JSON.stringify({
      id: 990011,
      order_number: 2002,
      admin_graphql_api_id: 'gid://shopify/Order/990011',
    });
    const hmac = generateShopifyHmac(payload);

    // First delivery
    const res1 = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${shopifyIntegrationId}`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', webhookId)
      .set('X-Shopify-Topic', 'orders/updated')
      .send(payload);

    expect(res1.status).toBe(200);
    expect(res1.body.status).toBe('accepted');

    // Duplicate delivery
    const res2 = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${shopifyIntegrationId}`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', webhookId)
      .set('X-Shopify-Topic', 'orders/updated')
      .send(payload);

    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe('ignored_duplicate');

    // Exactly 1 row in DB
    const count = await prisma.integrationEvent.count({
      where: { providerEventId: webhookId },
    });
    expect(count).toBe(1);
  });

  it('resolves integration via X-Shopify-Shop-Domain header', async () => {
    const payload = JSON.stringify({ id: 555, order_number: 2005 });
    const hmac = generateShopifyHmac(payload);
    const webhookId = crypto.randomUUID();

    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/arbitrary-id-ignored-when-header-present`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', webhookId)
      .set('X-Shopify-Topic', 'orders/updated')
      .set('X-Shopify-Shop-Domain', shopDomain)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
  });

  it('rejects provider mismatch (cannot send shopify webhook to simulator integration)', async () => {
    const payload = JSON.stringify({ id: 666 });
    const hmac = generateShopifyHmac(payload);

    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${simulatorIntegrationId}`) // Route says shopify, DB integration is SIMULATOR
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', crypto.randomUUID())
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Provider mismatch');
  });

  it('handles app/uninstalled: disconnects integration and clears credentials', async () => {
    const uninstallPayload = JSON.stringify({ id: 12345 });
    const hmac = generateShopifyHmac(uninstallPayload);
    const webhookId = crypto.randomUUID();

    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${shopifyIntegrationId}`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', webhookId)
      .set('X-Shopify-Topic', 'app/uninstalled')
      .set('X-Shopify-Shop-Domain', shopDomain)
      .send(uninstallPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');

    const updated = await prisma.integration.findUnique({
      where: { id: shopifyIntegrationId },
    });

    expect(updated?.status).toBe('DISCONNECTED');
    expect(updated?.encryptedCredentials).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: {
        entityId: shopifyIntegrationId,
        action: 'SHOPIFY_INTEGRATION_UNINSTALLED',
      },
    });
    expect(audit).toBeDefined();

    // Verify exactly 1 IntegrationEvent was persisted
    const events = await prisma.integrationEvent.findMany({
      where: { providerEventId: webhookId },
    });
    expect(events.length).toBe(1);
  });

  it('duplicate app/uninstalled delivery returns 200 ignored_duplicate without duplicating events or state changes', async () => {
    // Deliver the exact same app/uninstalled webhook again
    const lastAudit = await prisma.auditLog.findFirst({
      where: {
        entityId: shopifyIntegrationId,
        action: 'SHOPIFY_INTEGRATION_UNINSTALLED',
      },
    });
    const auditCountBefore = await prisma.auditLog.count({
      where: { entityId: shopifyIntegrationId },
    });

    const lastEvent = await prisma.integrationEvent.findFirst({
      where: { integrationId: shopifyIntegrationId, eventType: 'app/uninstalled' },
    });
    expect(lastEvent).toBeDefined();

    const uninstallPayload = JSON.stringify({ id: 12345 });
    const hmac = generateShopifyHmac(uninstallPayload);

    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${shopifyIntegrationId}`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', lastEvent!.providerEventId!)
      .set('X-Shopify-Topic', 'app/uninstalled')
      .set('X-Shopify-Shop-Domain', shopDomain)
      .send(uninstallPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored_duplicate');

    // Integration stays DISCONNECTED and credentials remain null
    const integration = await prisma.integration.findUnique({
      where: { id: shopifyIntegrationId },
    });
    expect(integration?.status).toBe('DISCONNECTED');
    expect(integration?.encryptedCredentials).toBeNull();

    // No duplicate audit logs created
    const auditCountAfter = await prisma.auditLog.count({
      where: { entityId: shopifyIntegrationId },
    });
    expect(auditCountAfter).toBe(auditCountBefore);

    // Exactly 1 IntegrationEvent exists for this providerEventId
    const eventCount = await prisma.integrationEvent.count({
      where: { providerEventId: lastEvent!.providerEventId },
    });
    expect(eventCount).toBe(1);
  });

  it('handles app/scopes_update: marks integration DEGRADED when required read_orders scope is missing', async () => {
    // Reconnect integration for this test
    const testIntegration = await prisma.integration.create({
      data: {
        organizationId: orgId,
        provider: 'SHOPIFY',
        name: 'Scopes Test Store',
        status: 'CONNECTED',
        mode: 'OBSERVE',
        shopDomain: 'scopes-test.myshopify.com',
      },
    });

    const payload = JSON.stringify({ current: ['read_customers', 'read_products'] }); // missing read_orders
    const hmac = generateShopifyHmac(payload);
    const webhookId = crypto.randomUUID();

    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${testIntegration.id}`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', webhookId)
      .set('X-Shopify-Topic', 'app/scopes_update')
      .set('X-Shopify-Shop-Domain', 'scopes-test.myshopify.com')
      .send(payload);

    expect(res.status).toBe(200);

    const updated = await prisma.integration.findUnique({
      where: { id: testIntegration.id },
    });
    expect(updated?.status).toBe('DEGRADED');

    const audit = await prisma.auditLog.findFirst({
      where: {
        entityId: testIntegration.id,
        action: 'SHOPIFY_INTEGRATION_SCOPES_REVOKED',
      },
    });
    expect(audit).toBeDefined();
  });

  it('late different valid signed webhook after disconnect returns 200 ignored_disconnected without reactivating or mutating', async () => {
    // shopifyIntegrationId is DISCONNECTED
    const orderCountBefore = await prisma.externalOrder.count({ where: { organizationId: orgId } });
    const recoveryCountBefore = await prisma.recoveryCase.count({ where: { organizationId: orgId } });
    const jobCountBefore = await prisma.job.count({ where: { organizationId: orgId } });

    const payload = JSON.stringify({ id: 9999, order_number: 9999 });
    const hmac = generateShopifyHmac(payload);
    const webhookId = crypto.randomUUID(); // Fresh, different webhook ID

    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${shopifyIntegrationId}`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', hmac)
      .set('X-Shopify-Webhook-Id', webhookId)
      .set('X-Shopify-Topic', 'orders/updated')
      .set('X-Shopify-Shop-Domain', shopDomain)
      .send(payload);

    // Documented Shopify ACK rule: HTTP 200 with ignored_disconnected
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored_disconnected');

    const integration = await prisma.integration.findUnique({
      where: { id: shopifyIntegrationId },
    });

    // Invariants: Must NOT reactivate, mutate state, or create recovery cases/jobs
    expect(integration?.status).toBe('DISCONNECTED');
    expect(integration?.encryptedCredentials).toBeNull();

    const orderCountAfter = await prisma.externalOrder.count({ where: { organizationId: orgId } });
    const recoveryCountAfter = await prisma.recoveryCase.count({ where: { organizationId: orgId } });
    const jobCountAfter = await prisma.job.count({ where: { organizationId: orgId } });

    expect(orderCountAfter).toBe(orderCountBefore);
    expect(recoveryCountAfter).toBe(recoveryCountBefore);
    expect(jobCountAfter).toBe(jobCountBefore);
  });

  it('invalid HMAC on disconnected store is rejected with 401 Unauthorized', async () => {
    // shopifyIntegrationId is DISCONNECTED
    const payload = JSON.stringify({ id: 1111, order_number: 1111 });
    const webhookId = crypto.randomUUID();

    const res = await request(app.getHttpServer())
      .post(`/webhooks/shopify/${shopifyIntegrationId}`)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Hmac-SHA256', 'completely_invalid_hmac==')
      .set('X-Shopify-Webhook-Id', webhookId)
      .set('X-Shopify-Topic', 'orders/updated')
      .set('X-Shopify-Shop-Domain', shopDomain)
      .send(payload);

    expect(res.status).toBe(401);
  });

  it('never directly performs recovery, creates approvals, or executes mutations from webhooks', async () => {
    const approvalCount = await prisma.approval.count({});
    const workflowCount = await prisma.workflow.count({});

    // Even after all webhook ingestions above:
    expect(approvalCount).toBe(0);
    expect(workflowCount).toBe(0);
  });
});
