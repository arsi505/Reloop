import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for E2E tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WebhookEventProcessorService } from '../src/webhooks/webhook-event-processor.service';
import { SimulatorWebhookAdapter } from '@reloop/connector-simulator';
import {
  IntegrationProvider,
  IntegrationStatus,
  IntegrationEventStatus,
  RecoveryCaseStatus,
  RecoveryCaseType,
  RecoveryLevel,
} from '@reloop/database';

describe('Day 14: Secure Webhook Ingestion, Deduplication & Targeted Reconciliation E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let processor: WebhookEventProcessorService;
  const adapter = new SimulatorWebhookAdapter();
  const testSecret = 'reloop_test_webhook_secret_dev_123';

  let orgAId: string;
  let orgBId: string;
  let integrationAId: string;
  let integrationBId: string;
  let integration3PLAId: string;

  beforeAll(async () => {
    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
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
    processor = app.get(WebhookEventProcessorService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
  });

  beforeEach(async () => {
    const runId = Math.random().toString(36).substring(2, 8);

    const orgA = await prisma.organization.create({
      data: { name: `Webhook Org A ${runId}`, slug: `webhook-org-a-${runId}` },
    });
    orgAId = orgA.id;

    const orgB = await prisma.organization.create({
      data: { name: `Webhook Org B ${runId}`, slug: `webhook-org-b-${runId}` },
    });
    orgBId = orgBId = orgB.id;

    const integrationA = await prisma.integration.create({
      data: {
        organizationId: orgAId,
        provider: IntegrationProvider.SIMULATOR,
        name: 'Shopify Simulator A',
        status: IntegrationStatus.CONNECTED,
        configuration: { webhookSecret: testSecret },
      },
    });
    integrationAId = integrationA.id;

    const integration3PLA = await prisma.integration.create({
      data: {
        organizationId: orgAId,
        provider: IntegrationProvider.GENERIC_3PL,
        name: '3PL Simulator A',
        status: IntegrationStatus.CONNECTED,
        configuration: { webhookSecret: testSecret },
      },
    });
    integration3PLAId = integration3PLA.id;

    const integrationB = await prisma.integration.create({
      data: {
        organizationId: orgBId,
        provider: IntegrationProvider.SIMULATOR,
        name: 'Shopify Simulator B',
        status: IntegrationStatus.CONNECTED,
        configuration: { webhookSecret: testSecret },
      },
    });
    integrationBId = integrationB.id;
  });

  describe('1. Webhook Signature Verification & Ingestion Endpoint', () => {
    it('accepts valid signed webhook and stores IntegrationEvent with status RECEIVED', async () => {
      const payload = {
        orderNumber: 'ORD-TEST-101',
        status: 'PAID',
        currency: 'USD',
        totalAmount: 99.99,
      };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = adapter.signPayload(rawBody, testSecret);
      const providerEventId = `evt_${Date.now()}_1`;

      const res = await request(app.getHttpServer())
        .post(`/webhooks/simulator/${integrationAId}`)
        .set('Content-Type', 'application/json')
        .set('x-reloop-signature', signature)
        .set('x-reloop-event-id', providerEventId)
        .set('x-reloop-event-type', 'ORDER_CREATED')
        .send(payload)
        .expect(200);

      expect(res.body.status).toBe('accepted');
      expect(res.body.providerEventId).toBe(providerEventId);
      expect(res.body.eventId).toBeDefined();

      const stored = await prisma.integrationEvent.findUnique({
        where: { id: res.body.eventId },
      });
      expect(stored).toBeDefined();
      expect(stored?.organizationId).toBe(orgAId);
      expect(stored?.integrationId).toBe(integrationAId);
      expect(stored?.providerEventId).toBe(providerEventId);
    });

    it('rejects webhook with missing signature header with 401', async () => {
      const payload = { orderNumber: 'ORD-NO-SIG' };

      const res = await request(app.getHttpServer())
        .post(`/webhooks/simulator/${integrationAId}`)
        .set('Content-Type', 'application/json')
        .set('x-reloop-event-id', `evt_no_sig_${Date.now()}`)
        .send(payload)
        .expect(401);

      expect(res.body.message).toMatch(/Missing required webhook signature/i);

      // Verify no IntegrationEvent was persisted
      const eventsCount = await prisma.integrationEvent.count({
        where: { integrationId: integrationAId },
      });
      expect(eventsCount).toBe(0);
    });

    it('rejects webhook with invalid signature with 401', async () => {
      const payload = { orderNumber: 'ORD-BAD-SIG' };
      const badSig = 'a'.repeat(64); // wrong signature

      const res = await request(app.getHttpServer())
        .post(`/webhooks/simulator/${integrationAId}`)
        .set('Content-Type', 'application/json')
        .set('x-reloop-signature', badSig)
        .set('x-reloop-event-id', `evt_bad_sig_${Date.now()}`)
        .send(payload)
        .expect(401);

      expect(res.body.message).toMatch(/Invalid webhook signature/i);
    });

    it('safely rejects wrong-length signature without throwing 500 error', async () => {
      const payload = { orderNumber: 'ORD-SHORT-SIG' };

      await request(app.getHttpServer())
        .post(`/webhooks/simulator/${integrationAId}`)
        .set('Content-Type', 'application/json')
        .set('x-reloop-signature', 'short-invalid-sig')
        .set('x-reloop-event-id', `evt_short_${Date.now()}`)
        .send(payload)
        .expect(401);
    });

    it('rejects unknown integration ID with 404', async () => {
      const fakeIntegrationId = '00000000-0000-0000-0000-000000000000';
      const payload = { orderNumber: 'ORD-UNKNOWN' };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = adapter.signPayload(rawBody, testSecret);

      await request(app.getHttpServer())
        .post(`/webhooks/simulator/${fakeIntegrationId}`)
        .set('Content-Type', 'application/json')
        .set('x-reloop-signature', signature)
        .set('x-reloop-event-id', `evt_unknown_${Date.now()}`)
        .send(payload)
        .expect(404);
    });

    it('rejects oversized payload exceeding limit with 413', async () => {
      // Create payload > 1MB
      const bigString = 'x'.repeat(1024 * 1024 + 100);
      const payload = { orderNumber: 'ORD-OVERSIZED', bigData: bigString };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = adapter.signPayload(rawBody, testSecret);

      await request(app.getHttpServer())
        .post(`/webhooks/simulator/${integrationAId}`)
        .set('Content-Type', 'application/json')
        .set('x-reloop-signature', signature)
        .set('x-reloop-event-id', `evt_big_${Date.now()}`)
        .send(payload)
        .expect(413);
    });
  });

  describe('2. Tenant Authority & Isolation', () => {
    it('strictly derives tenant authority from Integration.organizationId, ignoring payload claims', async () => {
      // Attacker claims organizationId of Org B in payload
      const payload = {
        organizationId: orgBId,
        orderNumber: 'ORD-TENANT-HIJACK',
        status: 'PAID',
      };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = adapter.signPayload(rawBody, testSecret);
      const providerEventId = `evt_hijack_${Date.now()}`;

      const res = await request(app.getHttpServer())
        .post(`/webhooks/simulator/${integrationAId}`)
        .set('Content-Type', 'application/json')
        .set('x-reloop-signature', signature)
        .set('x-reloop-event-id', providerEventId)
        .set('x-reloop-event-type', 'ORDER_CREATED')
        .send(payload)
        .expect(200);

      // Verify event was saved under Org A (derived from integrationAId), NEVER Org B
      const stored = await prisma.integrationEvent.findUnique({
        where: { id: res.body.eventId },
      });
      expect(stored?.organizationId).toBe(orgAId);
      expect(stored?.organizationId).not.toBe(orgBId);

      // Verify event cannot be queried under Org B
      const orgBEvents = await prisma.integrationEvent.findMany({
        where: { organizationId: orgBId, providerEventId },
      });
      expect(orgBEvents.length).toBe(0);
    });
  });

  describe('3. Deduplication & Multi-Instance Concurrency', () => {
    it('deduplicates duplicate delivery and returns ignored_duplicate with existing event ID', async () => {
      const payload = { orderNumber: 'ORD-DEDUPE-1' };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = adapter.signPayload(rawBody, testSecret);
      const providerEventId = `evt_dedupe_${Date.now()}`;

      // First delivery
      const res1 = await request(app.getHttpServer())
        .post(`/webhooks/simulator/${integrationAId}`)
        .set('Content-Type', 'application/json')
        .set('x-reloop-signature', signature)
        .set('x-reloop-event-id', providerEventId)
        .set('x-reloop-event-type', 'ORDER_CREATED')
        .send(payload)
        .expect(200);

      expect(res1.body.status).toBe('accepted');
      const originalEventId = res1.body.eventId;

      // Second delivery (e.g. commit-then-response-loss provider retry)
      const res2 = await request(app.getHttpServer())
        .post(`/webhooks/simulator/${integrationAId}`)
        .set('Content-Type', 'application/json')
        .set('x-reloop-signature', signature)
        .set('x-reloop-event-id', providerEventId)
        .set('x-reloop-event-type', 'ORDER_CREATED')
        .send(payload)
        .expect(200);

      expect(res2.body.status).toBe('ignored_duplicate');
      expect(res2.body.eventId).toBe(originalEventId);

      // Database verification: exactly 1 row
      const count = await prisma.integrationEvent.count({
        where: { integrationId: integrationAId, providerEventId },
      });
      expect(count).toBe(1);
    });

    it('10 concurrent duplicate deliveries safely converge to exactly 1 IntegrationEvent', async () => {
      const payload = { orderNumber: 'ORD-CONCURRENT-1' };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = adapter.signPayload(rawBody, testSecret);
      const providerEventId = `evt_concurrent_${Date.now()}`;

      // Launch 10 parallel requests with identical providerEventId
      const requests = Array.from({ length: 10 }, () =>
        request(app.getHttpServer())
          .post(`/webhooks/simulator/${integrationAId}`)
          .set('Content-Type', 'application/json')
          .set('x-reloop-signature', signature)
          .set('x-reloop-event-id', providerEventId)
          .set('x-reloop-event-type', 'ORDER_CREATED')
          .send(payload),
      );

      const responses = await Promise.all(requests);

      // All 10 must succeed with HTTP 200
      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      // Exactly one was 'accepted', remaining nine were 'ignored_duplicate'
      const accepted = responses.filter((r) => r.body.status === 'accepted');
      const ignored = responses.filter((r) => r.body.status === 'ignored_duplicate');
      expect(accepted.length).toBe(1);
      expect(ignored.length).toBe(9);

      // DB check: exactly 1 event
      const count = await prisma.integrationEvent.count({
        where: { integrationId: integrationAId, providerEventId },
      });
      expect(count).toBe(1);
    });
  });

  describe('4. Asynchronous Event Processor & State Projection', () => {
    it('processes valid order webhook and projects into ExternalOrder and ExternalReference', async () => {
      const orderNumber = `ORD-PROJ-${Date.now()}`;
      const payload = {
        orderNumber,
        externalOrderId: `ext_${orderNumber}`,
        status: 'PAID',
        currency: 'USD',
        totalAmount: 120.0,
        customerReference: 'proj@example.com',
      };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = adapter.signPayload(rawBody, testSecret);
      const providerEventId = `evt_proj_${Date.now()}`;

      const res = await request(app.getHttpServer())
        .post(`/webhooks/simulator/${integrationAId}`)
        .set('Content-Type', 'application/json')
        .set('x-reloop-signature', signature)
        .set('x-reloop-event-id', providerEventId)
        .set('x-reloop-event-type', 'ORDER_CREATED')
        .send(payload)
        .expect(200);

      // Process event
      await processor.processEvent(res.body.eventId);

      // Verify ExternalOrder created
      const order = await prisma.externalOrder.findUnique({
        where: {
          organizationId_externalOrderNumber: {
            organizationId: orgAId,
            externalOrderNumber: orderNumber,
          },
        },
      });
      expect(order).toBeDefined();
      expect(order?.externalOrderNumber).toBe(orderNumber);
      expect(order?.customerReference).toBe('proj@example.com');

      // Verify ExternalReference created
      const ref = await prisma.externalReference.findFirst({
        where: {
          organizationId: orgAId,
          externalOrderId: order!.id,
          integrationId: integrationAId,
        },
      });
      expect(ref).toBeDefined();

      // Verify event is PROCESSED
      const updatedEvent = await prisma.integrationEvent.findUnique({
        where: { id: res.body.eventId },
      });
      expect(updatedEvent?.status).toBe(IntegrationEventStatus.PROCESSED);
    });

    it('out-of-order protection: older event does NOT overwrite newer projected state', async () => {
      const orderNumber = `ORD-OOO-${Date.now()}`;
      const timeNewer = new Date('2026-09-19T12:00:00Z');
      const timeOlder = new Date('2026-09-19T11:00:00Z');

      // 1. Ingest and process newer event first (Status: SHIPPED at 12:00)
      const eventNewer = await prisma.integrationEvent.create({
        data: {
          organizationId: orgAId,
          integrationId: integrationAId,
          providerEventId: `evt_new_${Date.now()}`,
          eventType: 'ORDER_UPDATED',
          payload: {
            orderNumber,
            status: 'SHIPPED',
            occurredAt: timeNewer.toISOString(),
          },
          status: IntegrationEventStatus.RECEIVED,
        },
      });
      await processor.processEvent(eventNewer.id);

      const orderAfterNewer = await prisma.externalOrder.findUnique({
        where: {
          organizationId_externalOrderNumber: {
            organizationId: orgAId,
            externalOrderNumber: orderNumber,
          },
        },
      });
      expect(orderAfterNewer?.status).toBe('SHIPPED');
      expect(orderAfterNewer?.lastObservedAt.toISOString()).toBe(timeNewer.toISOString());

      // 2. Ingest and process older delayed event (Status: PENDING at 11:00)
      const eventOlder = await prisma.integrationEvent.create({
        data: {
          organizationId: orgAId,
          integrationId: integrationAId,
          providerEventId: `evt_old_${Date.now()}`,
          eventType: 'ORDER_UPDATED',
          payload: {
            orderNumber,
            status: 'PENDING',
            occurredAt: timeOlder.toISOString(),
          },
          status: IntegrationEventStatus.RECEIVED,
        },
      });
      await processor.processEvent(eventOlder.id);

      // Verify ExternalOrder was NOT regressed to PENDING
      const orderAfterOlder = await prisma.externalOrder.findUnique({
        where: {
          organizationId_externalOrderNumber: {
            organizationId: orgAId,
            externalOrderNumber: orderNumber,
          },
        },
      });
      expect(orderAfterOlder?.status).toBe('SHIPPED');
      expect(orderAfterOlder?.lastObservedAt.toISOString()).toBe(timeNewer.toISOString());

      // Verify older event is marked PROCESSED with note
      const olderStored = await prisma.integrationEvent.findUnique({
        where: { id: eventOlder.id },
      });
      expect(olderStored?.status).toBe(IntegrationEventStatus.PROCESSED);
      expect(olderStored?.errorMessage).toBe('SUPERSEDED_BY_NEWER_STATE');
    });

    it('marks permanently malformed payload as FAILED without looping', async () => {
      const eventMalformed = await prisma.integrationEvent.create({
        data: {
          organizationId: orgAId,
          integrationId: integrationAId,
          providerEventId: `evt_malformed_${Date.now()}`,
          eventType: 'ORDER_CREATED',
          payload: {
            // Missing required orderNumber!
            status: 'PAID',
          },
          status: IntegrationEventStatus.RECEIVED,
        },
      });

      const processed = await processor.processEvent(eventMalformed.id);
      expect(processed.status).toBe(IntegrationEventStatus.FAILED);
      expect(processed.errorCode).toBe('MALFORMED_PAYLOAD');
      expect(processed.errorMessage).toMatch(/missing valid orderNumber/i);
    });

    it('marks unsupported event type as PROCESSED safely with 0 cases', async () => {
      const eventUnsupported = await prisma.integrationEvent.create({
        data: {
          organizationId: orgAId,
          integrationId: integrationAId,
          providerEventId: `evt_unsupported_${Date.now()}`,
          eventType: 'SOME_RANDOM_VENDOR_EVENT',
          payload: { foo: 'bar' },
          status: IntegrationEventStatus.RECEIVED,
        },
      });

      const processed = await processor.processEvent(eventUnsupported.id);
      expect(processed.status).toBe(IntegrationEventStatus.PROCESSED);
      expect(processed.errorMessage).toBe('UNSUPPORTED_EVENT_IGNORED');

      // Verify zero cases created
      const cases = await prisma.recoveryCase.count({
        where: { organizationId: orgAId },
      });
      expect(cases).toBe(0);
    });

    it('event replay is idempotent and does not duplicate entities', async () => {
      const orderNumber = `ORD-REPLAY-${Date.now()}`;
      const event = await prisma.integrationEvent.create({
        data: {
          organizationId: orgAId,
          integrationId: integrationAId,
          providerEventId: `evt_rep_${Date.now()}`,
          eventType: 'ORDER_CREATED',
          payload: { orderNumber, status: 'PAID' },
          status: IntegrationEventStatus.RECEIVED,
        },
      });

      // Initial process
      await processor.processEvent(event.id);

      // Replay event
      await processor.replayEvent(event.id);

      // Verify exactly 1 ExternalOrder and 1 ExternalReference
      const orderCount = await prisma.externalOrder.count({
        where: { organizationId: orgAId, externalOrderNumber: orderNumber },
      });
      expect(orderCount).toBe(1);

      const refCount = await prisma.externalReference.count({
        where: { organizationId: orgAId, externalReference: { contains: orderNumber } },
      });
      expect(refCount).toBe(1);
    });
  });

  describe('5. Targeted Reconciliation Trigger & Invariant Boundaries', () => {
    it('healthy event: triggers reconciliation and produces 0 RecoveryCases', async () => {
      const orderNumber = `ORD-HLTH-${Date.now()}`;

      // 1. Shopify fulfilled event
      const shopifyEvent = await prisma.integrationEvent.create({
        data: {
          organizationId: orgAId,
          integrationId: integrationAId,
          providerEventId: `evt_sh_${Date.now()}`,
          eventType: 'FULFILLMENT_UPDATED',
          payload: {
            orderNumber,
            fulfillmentStatus: 'FULFILLED',
            trackingNumber: 'TRK-MATCH-100',
            carrier: 'USPS',
          },
          status: IntegrationEventStatus.RECEIVED,
        },
      });
      await processor.processEvent(shopifyEvent.id);

      // 2. 3PL shipped event with matching tracking
      const warehouseEvent = await prisma.integrationEvent.create({
        data: {
          organizationId: orgAId,
          integrationId: integration3PLAId,
          providerEventId: `evt_3pl_${Date.now()}`,
          eventType: 'SHIPMENT_UPDATED',
          payload: {
            orderNumber,
            shipmentStatus: 'SHIPPED',
            trackingNumber: 'TRK-MATCH-100',
            carrier: 'USPS',
          },
          status: IntegrationEventStatus.RECEIVED,
        },
      });
      await processor.processEvent(warehouseEvent.id);

      // Verify ZERO RecoveryCase records created
      const cases = await prisma.recoveryCase.findMany({
        where: { organizationId: orgAId, dedupeKey: { startsWith: orderNumber } },
      });
      expect(cases.length).toBe(0);
    });

    it('shipped/unfulfilled event: triggers reconciliation, creates 1 REQUIRE_APPROVAL case, and performs ZERO direct recovery', async () => {
      const orderNumber = `ORD-SHP-UNF-${Date.now()}`;

      // 1. Shopify unfulfilled order
      const shopifyEvent = await prisma.integrationEvent.create({
        data: {
          organizationId: orgAId,
          integrationId: integrationAId,
          providerEventId: `evt_sh_unf_${Date.now()}`,
          eventType: 'ORDER_CREATED',
          payload: {
            orderNumber,
            status: 'UNFULFILLED',
            fulfillmentStatus: 'UNFULFILLED',
          },
          status: IntegrationEventStatus.RECEIVED,
        },
      });
      await processor.processEvent(shopifyEvent.id);

      // 2. 3PL shipped event
      const warehouseEvent = await prisma.integrationEvent.create({
        data: {
          organizationId: orgAId,
          integrationId: integration3PLAId,
          providerEventId: `evt_3pl_shp_${Date.now()}`,
          eventType: 'SHIPMENT_UPDATED',
          payload: {
            orderNumber,
            shipmentStatus: 'SHIPPED',
            trackingNumber: 'TRK-3PL-999',
            carrier: 'FedEx',
          },
          status: IntegrationEventStatus.RECEIVED,
        },
      });
      await processor.processEvent(warehouseEvent.id);

      // Verify exactly ONE RecoveryCase created
      const cases = await prisma.recoveryCase.findMany({
        where: { organizationId: orgAId, dedupeKey: { startsWith: orderNumber } },
      });
      expect(cases.length).toBe(1);
      const c = cases[0];
      expect(c.type).toBe(RecoveryCaseType.SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY);
      expect(c.recoveryLevel).toBe(RecoveryLevel.REQUIRE_APPROVAL);
      expect(c.status).toBe(RecoveryCaseStatus.OPEN);

      // STRICT BOUNDARY INVARIANT:
      // Webhook pipeline MUST NOT create an Approval or Workflow directly!
      const approvals = await prisma.approval.findMany({
        where: { recoveryCaseId: c.id },
      });
      expect(approvals.length).toBe(0);

      const workflows = await prisma.workflow.findMany({
        where: { recoveryCaseId: c.id },
      });
      expect(workflows.length).toBe(0);
    });

    it('duplicate-risk event: creates 1 BLOCK RecoveryCase and performs ZERO mutations', async () => {
      const orderNumber = `ORD-DUP-RISK-${Date.now()}`;

      const warehouseEvent = await prisma.integrationEvent.create({
        data: {
          organizationId: orgAId,
          integrationId: integration3PLAId,
          providerEventId: `evt_3pl_dup_${Date.now()}`,
          eventType: 'SHIPMENT_UPDATED',
          payload: {
            orderNumber,
            shipmentStatus: 'SHIPPED',
            trackingNumber: 'TRK-DUP',
            candidateOrders: [
              { id: 'cand_1', orderNumber, status: 'SHIPPED' },
              { id: 'cand_2', orderNumber, status: 'RECEIVED' },
            ],
          },
          status: IntegrationEventStatus.RECEIVED,
        },
      });
      await processor.processEvent(warehouseEvent.id);

      const cases = await prisma.recoveryCase.findMany({
        where: { organizationId: orgAId, dedupeKey: { startsWith: orderNumber } },
      });
      expect(cases.length).toBe(1);
      expect(cases[0].type).toBe(RecoveryCaseType.DUPLICATE_RISK);
      expect(cases[0].recoveryLevel).toBe(RecoveryLevel.BLOCK);
      expect(cases[0].status).toBe(RecoveryCaseStatus.OPEN);
    });
  });
});
