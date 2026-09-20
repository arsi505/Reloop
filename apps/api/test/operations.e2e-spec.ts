import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for E2E tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.INTEGRATION_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  Role,
  IntegrationProvider,
  IntegrationStatus,
  ExternalOrderStatus,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
  WorkflowStatus,
  JobStatus,
  ApprovalStatus,
} from '@reloop/database';
import { SecurityUtil } from '../src/auth/security.util';

describe('Operations API, Integration Health & Read Model E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let ownerTokenA: string;
  let adminTokenA: string;
  let operatorTokenA: string;
  let viewerTokenA: string;
  let ownerTokenB: string;

  let orgAId: string;
  let orgBId: string;

  let caseAId: string;
  let caseBId: string;
  let orderAId: string;
  let orderBId: string;
  let workflowAId: string;
  let workflowBId: string;
  let integrationShopifyAId: string;
  let integrationShipStationAId: string;
  let integrationBId: string;

  const fakeSecretMarker = 'SECRET_MARKER_NEVER_LEAK_TOKEN_XYZ';
  const fakePiiEmail = 'alice_secret_pii@customer.org';
  const fakePiiPhone = '+1-555-PII-9999';
  const fakePiiAddress = '999 Forbidden PII Blvd';

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
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
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

    // Seed Organizations
    const orgA = await prisma.organization.create({
      data: { name: 'Tenant Alpha Operations', slug: 'tenant-alpha-ops' },
    });
    orgAId = orgA.id;

    const orgB = await prisma.organization.create({
      data: { name: 'Tenant Beta Operations', slug: 'tenant-beta-ops' },
    });
    orgBId = orgB.id;

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

    ownerTokenA = await createUser('owner.alpha@test.com', Role.OWNER, orgAId);
    adminTokenA = await createUser('admin.alpha@test.com', Role.ADMIN, orgAId);
    operatorTokenA = await createUser('operator.alpha@test.com', Role.OPERATOR, orgAId);
    viewerTokenA = await createUser('viewer.alpha@test.com', Role.VIEWER, orgAId);
    ownerTokenB = await createUser('owner.beta@test.com', Role.OWNER, orgBId);

    // Seed Integrations for Org A
    const shopifyA = await prisma.integration.create({
      data: {
        organizationId: orgAId,
        provider: IntegrationProvider.SHOPIFY,
        name: 'Alpha Shopify Store',
        status: IntegrationStatus.CONNECTED,
        shopDomain: 'alpha-shop.myshopify.com',
        encryptedCredentials: {
          ciphertext: 'enc_data',
          secretMarker: fakeSecretMarker,
        },
        configuration: {
          scopes: 'read_orders,read_fulfillments',
          lastSuccessfulSyncWatermark: '2026-09-20T10:00:00.000Z',
        },
      },
    });
    integrationShopifyAId = shopifyA.id;

    const shipstationA = await prisma.integration.create({
      data: {
        organizationId: orgAId,
        provider: IntegrationProvider.SHIPSTATION,
        name: 'Alpha ShipStation Warehouse',
        status: IntegrationStatus.CONNECTED,
        encryptedCredentials: {
          apiKey: fakeSecretMarker,
        },
        configuration: {
          syncIntervalMinutes: 15,
        },
      },
    });
    integrationShipStationAId = shipstationA.id;

    // Succeeded sync job for Shopify (makes Shopify HEALTHY)
    await prisma.job.create({
      data: {
        organizationId: orgAId,
        type: 'SHOPIFY_SYNC_ORDERS',
        status: JobStatus.SUCCEEDED,
        idempotencyKey: 'sync-shopify-success-1',
        completedAt: new Date('2026-09-20T11:00:00Z'),
      },
    });

    // Dead-lettered sync job for ShipStation (makes connected ShipStation DEGRADED!)
    const failedSsJob = await prisma.job.create({
      data: {
        organizationId: orgAId,
        type: 'SHIPSTATION_SYNC_SHIPMENTS',
        status: JobStatus.DEAD_LETTERED,
        idempotencyKey: 'sync-ss-failed-1',
        attemptCount: 3,
        completedAt: new Date('2026-09-20T11:30:00Z'),
      },
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: failedSsJob.id,
        attemptNumber: 3,
        status: 'FAILED',
        errorCategory: 'RATE_LIMITED',
        errorCode: 'RATE_LIMITED',
        errorMessage: 'HTTP 429 Too Many Requests: retry after 60s',
        startedAt: new Date('2026-09-20T11:29:50Z'),
        finishedAt: new Date('2026-09-20T11:30:00Z'),
      },
    });

    // Seed Order 1001 for Org A
    const orderA = await prisma.externalOrder.create({
      data: {
        organizationId: orgAId,
        primaryIntegrationId: shopifyA.id,
        externalOrderNumber: '1001',
        customerReference: 'CUST-REF-001',
        status: ExternalOrderStatus.FULFILLING,
        currency: 'USD',
        totalAmount: 149.99,
        sourceCreatedAt: new Date('2026-09-20T08:00:00Z'),
        lastObservedAt: new Date('2026-09-20T09:00:00Z'),
      },
    });
    orderAId = orderA.id;

    // Seed ExternalReferences: ShipStation has tracking 9400111899562537624123, Shopify has none!
    await prisma.externalReference.create({
      data: {
        organizationId: orgAId,
        externalOrderId: orderA.id,
        integrationId: shipstationA.id,
        resourceType: 'LABEL',
        externalId: 'ss-lbl-1001',
        externalReference: JSON.stringify({ voided: false, tracking: '9400111899562537624123' }),
      },
    });

    await prisma.externalReference.create({
      data: {
        organizationId: orgAId,
        externalOrderId: orderA.id,
        integrationId: shipstationA.id,
        resourceType: 'TRACKING',
        externalId: '9400111899562537624123',
        externalReference: 'USPS',
      },
    });

    // Seed RecoveryCase for Org A with PII in evidence
    const caseA = await prisma.recoveryCase.create({
      data: {
        organizationId: orgAId,
        externalOrderId: orderA.id,
        sourceIntegrationId: shopifyA.id,
        type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
        recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        status: RecoveryCaseStatus.WAITING_APPROVAL,
        summary: 'Tracking 9400111899562537624123 present in ShipStation but missing in Shopify',
        detectedAt: new Date('2026-09-20T09:30:00Z'),
        evidence: {
          customerEmail: fakePiiEmail,
          phone: fakePiiPhone,
          shippingAddress: {
            street: fakePiiAddress,
            city: 'Portland',
            zip: '97201',
          },
          trackingNumber: '9400111899562537624123',
          carrier: 'USPS',
          secretApiKey: fakeSecretMarker,
        },
      },
    });
    caseAId = caseA.id;

    // Seed Workflow for Case A
    const wfA = await prisma.workflow.create({
      data: {
        organizationId: orgAId,
        recoveryCaseId: caseA.id,
        templateKey: 'TRACKING_SYNC_RECOVERY',
        templateVersion: 1,
        status: WorkflowStatus.WAITING,
        startedAt: new Date('2026-09-20T09:31:00Z'),
      },
    });
    workflowAId = wfA.id;

    const stepA = await prisma.workflowStep.create({
      data: {
        organizationId: orgAId,
        workflowId: wfA.id,
        key: 'AWAIT_APPROVAL',
        name: 'Operator Approval Step',
        position: 1,
        status: 'WAITING',
        startedAt: new Date('2026-09-20T09:31:05Z'),
      },
    });

    await prisma.approval.create({
      data: {
        organizationId: orgAId,
        recoveryCaseId: caseA.id,
        workflowId: wfA.id,
        workflowStepId: stepA.id,
        status: ApprovalStatus.PENDING,
        requestedAt: new Date('2026-09-20T09:31:10Z'),
        previewSnapshot: {
          action: 'SHOPIFY_CREATE_FULFILLMENT',
          trackingNumber: '9400111899562537624123',
        },
      },
    });

    // Seed Org B Data for Tenant Isolation Tests
    const integrationB = await prisma.integration.create({
      data: {
        organizationId: orgBId,
        provider: IntegrationProvider.SHOPIFY,
        name: 'Beta Shopify Store',
        status: IntegrationStatus.CONNECTED,
        shopDomain: 'beta-shop.myshopify.com',
      },
    });
    integrationBId = integrationB.id;

    const orderB = await prisma.externalOrder.create({
      data: {
        organizationId: orgBId,
        primaryIntegrationId: integrationB.id,
        externalOrderNumber: '2001',
        status: ExternalOrderStatus.PENDING,
      },
    });
    orderBId = orderB.id;

    const caseB = await prisma.recoveryCase.create({
      data: {
        organizationId: orgBId,
        externalOrderId: orderB.id,
        sourceIntegrationId: integrationB.id,
        type: RecoveryCaseType.TEMPORARY_API_FAILURE,
        recoveryLevel: RecoveryLevel.AUTO_RECOVER,
        status: RecoveryCaseStatus.OPEN,
        summary: 'Temporary provider 500 failure for Order 2001',
      },
    });
    caseBId = caseB.id;

    const wfB = await prisma.workflow.create({
      data: {
        organizationId: orgBId,
        recoveryCaseId: caseB.id,
        templateKey: 'RETRY_TEMPORARY_FAILURE',
        templateVersion: 1,
        status: WorkflowStatus.RUNNING,
      },
    });
    workflowBId = wfB.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // Helper for recursive safety validation
  const assertRecursiveNoSecretsOrPii = (obj: any) => {
    if (!obj) return;
    if (typeof obj === 'string') {
      expect(obj).not.toContain(fakeSecretMarker);
      expect(obj).not.toContain(fakePiiEmail);
      expect(obj).not.toContain(fakePiiPhone);
      expect(obj).not.toContain(fakePiiAddress);
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        assertRecursiveNoSecretsOrPii(item);
      }
      return;
    }
    if (typeof obj === 'object') {
      const forbiddenKeyNames = [
        'encryptedcredentials',
        'accesstoken',
        'refreshtoken',
        'apikey',
        'clientsecret',
        'passwordhash',
        'customeremail',
        'recipientname',
      ];
      for (const [key, value] of Object.entries(obj)) {
        expect(forbiddenKeyNames).not.toContain(key.toLowerCase());
        assertRecursiveNoSecretsOrPii(value);
      }
    }
  };

  describe('1. Dashboard Summary (GET /dashboard/summary)', () => {
    it('returns aggregated counts, health summary, and recent activity for Org A', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/summary')
        .set('Authorization', `Bearer ${ownerTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.totalExceptionsCount).toBe(1);
      expect(res.body.openExceptionsCount).toBe(1);
      expect(res.body.casesRequiringApprovalCount).toBe(1);
      expect(res.body.recentExceptions.length).toBe(1);
      expect(res.body.recentExceptions[0].externalOrderNumber).toBe('1001');

      // Health rollup: Shopify is HEALTHY, ShipStation with dead-lettered job is DEGRADED!
      expect(res.body.integrationHealthSummary.total).toBe(2);
      expect(res.body.integrationHealthSummary.healthy).toBe(1);
      expect(res.body.integrationHealthSummary.degraded).toBe(1);

      assertRecursiveNoSecretsOrPii(res.body);
    });

    it('enforces tenant isolation: Org B sees only its own counts', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/summary')
        .set('Authorization', `Bearer ${ownerTokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.totalExceptionsCount).toBe(1);
      expect(res.body.casesRequiringApprovalCount).toBe(0); // Case B is AUTO_RECOVER
      expect(res.body.recentExceptions[0].summary).toContain('Order 2001');
      assertRecursiveNoSecretsOrPii(res.body);
    });

    it('allows VIEWER role to access dashboard summary', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/summary')
        .set('Authorization', `Bearer ${viewerTokenA}`);

      expect(res.status).toBe(200);
    });
  });

  describe('2. Exceptions Endpoints (GET /exceptions & GET /exceptions/:id)', () => {
    it('returns paginated exceptions list with pagination metadata', async () => {
      const res = await request(app.getHttpServer())
        .get('/exceptions?page=1&pageSize=10')
        .set('Authorization', `Bearer ${operatorTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(10);
      expect(res.body.total).toBe(1);
      expect(res.body.totalPages).toBe(1);
      expect(res.body.items.length).toBe(1);
      expect(res.body.items[0].id).toBe(caseAId);
      expect(res.body.items[0].approvalWaiting).toBe(true);
      assertRecursiveNoSecretsOrPii(res.body);
    });

    it('supports status and recoveryLevel filters', async () => {
      const matchingRes = await request(app.getHttpServer())
        .get(`/exceptions?status=${RecoveryCaseStatus.WAITING_APPROVAL}&recoveryLevel=${RecoveryLevel.REQUIRE_APPROVAL}`)
        .set('Authorization', `Bearer ${adminTokenA}`);
      expect(matchingRes.status).toBe(200);
      expect(matchingRes.body.items.length).toBe(1);

      const nonMatchingRes = await request(app.getHttpServer())
        .get(`/exceptions?status=${RecoveryCaseStatus.RESOLVED}`)
        .set('Authorization', `Bearer ${adminTokenA}`);
      expect(nonMatchingRes.status).toBe(200);
      expect(nonMatchingRes.body.items.length).toBe(0);
    });

    it('returns sanitized exception detail without customer PII or secrets', async () => {
      const res = await request(app.getHttpServer())
        .get(`/exceptions/${caseAId}`)
        .set('Authorization', `Bearer ${viewerTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(caseAId);
      expect(res.body.summary).toContain('Tracking 9400111899562537624123');
      expect(res.body.order.orderNumber).toBe('1001');
      expect(res.body.approval.status).toBe(ApprovalStatus.PENDING);

      // PII must be completely stripped
      expect(res.body.sanitizedEvidence.customerEmail).toBeUndefined();
      expect(res.body.sanitizedEvidence.phone).toBeUndefined();
      expect(res.body.sanitizedEvidence.shippingAddress).toBeUndefined();

      // Secrets redacted
      expect(res.body.sanitizedEvidence.secretApiKey).toBe('[REDACTED]');

      // Valid operational metadata preserved
      expect(res.body.sanitizedEvidence.trackingNumber).toBe('9400111899562537624123');

      assertRecursiveNoSecretsOrPii(res.body);
    });

    it('returns 404 for cross-tenant exception lookup (Org A user requesting Org B case)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/exceptions/${caseBId}`)
        .set('Authorization', `Bearer ${ownerTokenA}`);

      expect(res.status).toBe(404);
      const errMsg = res.body.message || res.body.error?.message || res.body.error;
      expect(errMsg).toContain(`Exception ${caseBId} not found`);
    });
  });

  describe('3. Orders Endpoints (GET /orders & GET /orders/:id)', () => {
    it('returns paginated orders list with connected providers and exception count', async () => {
      const res = await request(app.getHttpServer())
        .get('/orders?page=1&pageSize=25')
        .set('Authorization', `Bearer ${viewerTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(1);
      const orderItem = res.body.items[0];
      expect(orderItem.externalOrderNumber).toBe('1001');
      expect(orderItem.activeExceptionCount).toBe(1);
      expect(orderItem.hasOpenException).toBe(true);
      expect(orderItem.connectedProviders).toContain(IntegrationProvider.SHOPIFY);
      expect(orderItem.connectedProviders).toContain(IntegrationProvider.SHIPSTATION);
      assertRecursiveNoSecretsOrPii(res.body);
    });

    it('returns cross-system order detail presenting Shopify + ShipStation states and discrepancy', async () => {
      const res = await request(app.getHttpServer())
        .get(`/orders/${orderAId}`)
        .set('Authorization', `Bearer ${operatorTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(orderAId);
      expect(res.body.externalOrderNumber).toBe('1001');

      // Shopify factual state
      expect(res.body.shopifyState).not.toBeNull();
      expect(res.body.shopifyState.fulfillmentStatus).toBe('UNFULFILLED');
      expect(res.body.shopifyState.trackingNumbers.length).toBe(0);

      // ShipStation factual state
      expect(res.body.shipstationState).not.toBeNull();
      expect(res.body.shipstationState.shipmentStatus).toBe('LABEL_CREATED');
      expect(res.body.shipstationState.trackingNumbers).toContain('9400111899562537624123');

      // Authoritative unique tracking list
      expect(res.body.trackingNumbers).toContain('9400111899562537624123');

      // Cross-system discrepancy factual detection
      expect(res.body.crossSystemDiscrepancy.hasDiscrepancy).toBe(true);
      expect(res.body.crossSystemDiscrepancy.details.discrepancyType).toBe('TRACKING_MISSING_IN_SHOPIFY');

      assertRecursiveNoSecretsOrPii(res.body);
    });

    it('returns 404 for cross-tenant order lookup', async () => {
      const res = await request(app.getHttpServer())
        .get(`/orders/${orderBId}`)
        .set('Authorization', `Bearer ${ownerTokenA}`);

      expect(res.status).toBe(404);
    });
  });

  describe('4. Recoveries Endpoints (GET /recoveries & GET /recoveries/:id)', () => {
    it('returns paginated recoveries list', async () => {
      const res = await request(app.getHttpServer())
        .get('/recoveries?page=1&pageSize=10')
        .set('Authorization', `Bearer ${adminTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(1);
      expect(res.body.items[0].id).toBe(workflowAId);
      expect(res.body.items[0].caseType).toBe(RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY);
      expect(res.body.items[0].templateKey).toBe('TRACKING_SYNC_RECOVERY');
      assertRecursiveNoSecretsOrPii(res.body);
    });

    it('returns flight recorder detail with chronological timeline derived strictly from durable records', async () => {
      const res = await request(app.getHttpServer())
        .get(`/recoveries/${workflowAId}`)
        .set('Authorization', `Bearer ${viewerTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(workflowAId);
      expect(res.body.timeline.length).toBeGreaterThanOrEqual(4);

      // Verify events exist in chronological sequence
      const eventTypes = res.body.timeline.map((e: any) => e.eventType);
      expect(eventTypes).toContain('CASE_DETECTED');
      expect(eventTypes).toContain('WORKFLOW_CREATED');
      expect(eventTypes).toContain('WORKFLOW_STARTED');
      expect(eventTypes).toContain('APPROVAL_REQUESTED');

      // Approval snapshot is exposed safely
      expect(res.body.approval).not.toBeNull();
      expect(res.body.approval.previewSnapshot.action).toBe('SHOPIFY_CREATE_FULFILLMENT');

      assertRecursiveNoSecretsOrPii(res.body);
    });

    it('returns 404 for cross-tenant recovery lookup', async () => {
      const res = await request(app.getHttpServer())
        .get(`/recoveries/${workflowBId}`)
        .set('Authorization', `Bearer ${ownerTokenA}`);

      expect(res.status).toBe(404);
    });
  });

  describe('5. Integrations Operations Endpoints (GET /integrations & GET /integrations/:id)', () => {
    it('lists tenant-safe provider cards with deterministic health', async () => {
      const res = await request(app.getHttpServer())
        .get('/integrations')
        .set('Authorization', `Bearer ${viewerTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(2);

      const shopifyCard = res.body.find((c: any) => c.provider === 'SHOPIFY');
      const shipstationCard = res.body.find((c: any) => c.provider === 'SHIPSTATION');

      expect(shopifyCard).toBeDefined();
      expect(shopifyCard.health).toBe('HEALTHY');
      expect(shopifyCard.readCapability).toBe(true);
      expect(shopifyCard.mutationCapability).toBe(false);

      // Connected but failing sync is shown DEGRADED, not healthy!
      expect(shipstationCard).toBeDefined();
      expect(shipstationCard.health).toBe('DEGRADED');
      expect(shipstationCard.lastError.category).toBe('RATE_LIMITED');

      assertRecursiveNoSecretsOrPii(res.body);
    });

    it('returns operational detail for an integration', async () => {
      const res = await request(app.getHttpServer())
        .get(`/integrations/${integrationShipStationAId}`)
        .set('Authorization', `Bearer ${operatorTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(integrationShipStationAId);
      expect(res.body.recentSyncJobs.length).toBe(1);
      expect(res.body.recentSyncJobs[0].status).toBe('DEAD_LETTERED');
      expect(res.body.safeConfiguration.syncIntervalMinutes).toBe(15);
      assertRecursiveNoSecretsOrPii(res.body);
    });

    it('returns 404 for cross-tenant integration lookup', async () => {
      const res = await request(app.getHttpServer())
        .get(`/integrations/${integrationBId}`)
        .set('Authorization', `Bearer ${ownerTokenA}`);

      expect(res.status).toBe(404);
    });
  });

  describe('6. Zero Business Mutation Audit', () => {
    it('confirms all operations endpoints are strictly GET and produce zero database mutations', async () => {
      const countBefore = await prisma.recoveryCase.count();
      const ordersBefore = await prisma.externalOrder.count();

      await request(app.getHttpServer())
        .get('/dashboard/summary')
        .set('Authorization', `Bearer ${ownerTokenA}`);
      await request(app.getHttpServer())
        .get('/exceptions')
        .set('Authorization', `Bearer ${ownerTokenA}`);
      await request(app.getHttpServer())
        .get('/orders')
        .set('Authorization', `Bearer ${ownerTokenA}`);
      await request(app.getHttpServer())
        .get('/recoveries')
        .set('Authorization', `Bearer ${ownerTokenA}`);
      await request(app.getHttpServer())
        .get('/integrations')
        .set('Authorization', `Bearer ${ownerTokenA}`);

      const countAfter = await prisma.recoveryCase.count();
      const ordersAfter = await prisma.externalOrder.count();

      expect(countAfter).toBe(countBefore);
      expect(ordersAfter).toBe(ordersBefore);
    });
  });
});
