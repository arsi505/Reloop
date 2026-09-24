import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for durability tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { PrismaClient, IntegrationProvider, IntegrationStatus, IntegrationEventStatus, RecoveryCaseType, RecoveryLevel, RecoveryCaseStatus } from '@reloop/database';
import { WebhookEventProcessorService } from './webhook-event-processor.service';
import { TargetedReconciliationService } from './targeted-reconciliation.service';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { ConfigService } from '@nestjs/config';
import { SimulatorWebhookAdapter } from '@reloop/connector-simulator';

describe('E-02: Durable Webhook Processing & Recovery Specification', () => {
  let prisma: PrismaService;
  let processor: WebhookEventProcessorService;
  let webhooksService: WebhooksService;
  let targetedReconciliation: TargetedReconciliationService;
  let configService: ConfigService;
  const adapter = new SimulatorWebhookAdapter();
  const testSecret = 'reloop_test_webhook_durability_secret_123';

  let orgId: string;
  let integrationId: string;
  let integration3PLId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    configService = new ConfigService({
      nodeEnv: 'test',
      webhookScannerEnabled: false, // We control lifecycle manually in tests
      webhookScannerIntervalMs: 50,
      webhookStaleThresholdMs: 1000, // 1 second stale threshold for fast testing
      webhookScannerBatchSize: 50,
      simulatorWebhookSecret: testSecret,
      webhookMaxPayloadBytes: 1048576,
    });

    const mockRealtimePublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as RealtimePublisher;

    targetedReconciliation = new TargetedReconciliationService(prisma, mockRealtimePublisher);
    processor = new WebhookEventProcessorService(prisma, targetedReconciliation, configService);
    webhooksService = new WebhooksService(prisma, configService, processor);
  });

  afterAll(async () => {
    if (processor) {
      await processor.stop();
    }
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
  });

  beforeEach(async () => {
    const runId = Math.random().toString(36).substring(2, 8);

    const org = await prisma.organization.create({
      data: { name: `Durability Org ${runId}`, slug: `durability-org-${runId}` },
    });
    orgId = org.id;

    const integration = await prisma.integration.create({
      data: {
        organizationId: orgId,
        provider: IntegrationProvider.SIMULATOR,
        name: 'Shopify Simulator Durability',
        status: IntegrationStatus.CONNECTED,
        configuration: { webhookSecret: testSecret },
      },
    });
    integrationId = integration.id;

    const integration3PL = await prisma.integration.create({
      data: {
        organizationId: orgId,
        provider: IntegrationProvider.SIMULATOR,
        name: '3PL Simulator Durability',
        status: IntegrationStatus.CONNECTED,
        configuration: { webhookSecret: testSecret },
      },
    });
    integration3PLId = integration3PL.id;
  });

  describe('1. Crash After INSERT Recovery', () => {
    it('recovers stranded RECEIVED event when API crashed before setImmediate callback executed', async () => {
      const orderNumber = `ORD-CRASH-INS-${Date.now()}`;
      const providerEventId = `evt_crash_ins_${Date.now()}`;

      // Simulate crash after database INSERT: row exists in PostgreSQL as RECEIVED,
      // but immediate processing callback never ran or died.
      const strandedEvent = await prisma.integrationEvent.create({
        data: {
          organizationId: orgId,
          integrationId,
          providerEventId,
          eventType: 'ORDER_CREATED',
          payload: {
            orderNumber,
            status: 'PAID',
            currency: 'USD',
            totalAmount: 150.0,
            customerReference: 'crash-recovery@example.com',
          },
          status: IntegrationEventStatus.RECEIVED,
        },
      });

      // Verify event is stranded in RECEIVED and no ExternalOrder exists
      expect(strandedEvent.status).toBe(IntegrationEventStatus.RECEIVED);
      const orderBefore = await prisma.externalOrder.findUnique({
        where: {
          organizationId_externalOrderNumber: {
            organizationId: orgId,
            externalOrderNumber: orderNumber,
          },
        },
      });
      expect(orderBefore).toBeNull();

      // Simulate restart: a new processor instance discovers stranded event via tick
      const processedCount = await processor.tick();
      expect(processedCount).toBeGreaterThanOrEqual(1);

      // Verify event reached PROCESSED
      const eventAfter = await prisma.integrationEvent.findUnique({
        where: { id: strandedEvent.id },
      });
      expect(eventAfter?.status).toBe(IntegrationEventStatus.PROCESSED);
      expect(eventAfter?.processedAt).toBeDefined();

      // Verify ExternalOrder projected exactly once
      const orderAfter = await prisma.externalOrder.findUnique({
        where: {
          organizationId_externalOrderNumber: {
            organizationId: orgId,
            externalOrderNumber: orderNumber,
          },
        },
      });
      expect(orderAfter).toBeDefined();
      expect(orderAfter?.externalOrderNumber).toBe(orderNumber);

      // Verify subsequent tick does not duplicate projection
      const secondTickCount = await processor.tick();
      expect(secondTickCount).toBe(0);

      const totalOrders = await prisma.externalOrder.count({
        where: { organizationId: orgId, externalOrderNumber: orderNumber },
      });
      expect(totalOrders).toBe(1);
    });
  });

  describe('2. Crash During PROCESSING & Stale Lease Recovery', () => {
    it('reclaims stale PROCESSING event after timeout while protecting actively running events', async () => {
      const orderNumber = `ORD-STALE-${Date.now()}`;
      const providerEventId = `evt_stale_${Date.now()}`;
      processor.setStaleThresholdMs(500); // 500ms timeout for test

      // 1. Create a stale event where process crashed in PROCESSING 2000ms ago
      const staleEvent = await prisma.integrationEvent.create({
        data: {
          organizationId: orgId,
          integrationId,
          providerEventId,
          eventType: 'ORDER_CREATED',
          payload: {
            orderNumber,
            status: 'PAID',
            currency: 'USD',
            totalAmount: 200.0,
          },
          status: IntegrationEventStatus.PROCESSING,
        },
      });

      // Manually backdate updatedAt to simulate crash 2 seconds ago
      await prisma.$executeRaw`
        UPDATE "integration_events"
        SET "updated_at" = NOW() - INTERVAL '2 seconds'
        WHERE "id" = ${staleEvent.id}::uuid
      `;

      // 2. Create an actively processing event (updatedAt = NOW())
      const activeEvent = await prisma.integrationEvent.create({
        data: {
          organizationId: orgId,
          integrationId,
          providerEventId: `evt_active_${Date.now()}`,
          eventType: 'ORDER_CREATED',
          payload: { orderNumber: `ORD-ACTIVE-${Date.now()}`, status: 'PAID' },
          status: IntegrationEventStatus.PROCESSING,
        },
      });

      // Active event must NOT be stolen immediately
      const activeClaim = await processor.processEvent(activeEvent.id);
      expect(activeClaim.status).toBe(IntegrationEventStatus.PROCESSING);

      // 3. Scanner tick reclaims the stale event
      const processedCount = await processor.tick();
      expect(processedCount).toBeGreaterThanOrEqual(1);

      // Verify stale event is now PROCESSED
      const recoveredEvent = await prisma.integrationEvent.findUnique({
        where: { id: staleEvent.id },
      });
      expect(recoveredEvent?.status).toBe(IntegrationEventStatus.PROCESSED);

      // Verify ExternalOrder projected with no duplicates
      const orderCount = await prisma.externalOrder.count({
        where: { organizationId: orgId, externalOrderNumber: orderNumber },
      });
      expect(orderCount).toBe(1);
    });
  });

  describe('3. Database-Atomic Concurrent Claims', () => {
    it('ensures exactly one processor instance successfully claims and processes an event', async () => {
      const orderNumber = `ORD-CONCUR-${Date.now()}`;
      const providerEventId = `evt_concur_${Date.now()}`;

      const event = await prisma.integrationEvent.create({
        data: {
          organizationId: orgId,
          integrationId,
          providerEventId,
          eventType: 'ORDER_CREATED',
          payload: {
            orderNumber,
            status: 'PAID',
            currency: 'USD',
            totalAmount: 300.0,
          },
          status: IntegrationEventStatus.RECEIVED,
        },
      });

      // Create 5 separate processor instances
      const processors = Array.from({ length: 5 }, () =>
        new WebhookEventProcessorService(prisma, targetedReconciliation, configService),
      );

      // Attempt concurrent claims simultaneously
      const results = await Promise.all(
        processors.map((p) => p.processEvent(event.id)),
      );

      // All 5 calls resolve cleanly
      expect(results).toHaveLength(5);

      // Final state must be PROCESSED
      const finalEvent = await prisma.integrationEvent.findUnique({
        where: { id: event.id },
      });
      expect(finalEvent?.status).toBe(IntegrationEventStatus.PROCESSED);

      // Exactly 1 ExternalOrder created
      const orderCount = await prisma.externalOrder.count({
        where: { organizationId: orgId, externalOrderNumber: orderNumber },
      });
      expect(orderCount).toBe(1);
    });
  });

  describe('4. Duplicate Webhook Submission', () => {
    it('preserves unique constraint on (integrationId, providerEventId) and acknowledges duplicates safely', async () => {
      const orderNumber = `ORD-DUPE-INGEST-${Date.now()}`;
      const providerEventId = `evt_dupe_${Date.now()}`;
      const payload = {
        orderNumber,
        status: 'PAID',
        currency: 'USD',
        totalAmount: 85.0,
      };
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = adapter.signPayload(rawBody, testSecret);
      const headers = {
        'x-reloop-signature': signature,
        'x-reloop-event-id': providerEventId,
        'x-reloop-event-type': 'ORDER_CREATED',
      };

      // Submit the exact same webhook 5 times concurrently
      const ingestResults = await Promise.all(
        Array.from({ length: 5 }, () =>
          webhooksService.ingestWebhook(
            'SIMULATOR',
            integrationId,
            rawBody,
            headers,
            payload,
          ),
        ),
      );

      // Exactly 1 accepted, others ignored_duplicate (or all safe acknowledgments)
      const accepted = ingestResults.filter((r) => r.status === 'accepted');
      const duplicates = ingestResults.filter((r) => r.status === 'ignored_duplicate');

      expect(accepted.length).toBe(1);
      expect(duplicates.length).toBe(4);

      // Exactly 1 IntegrationEvent row in database
      const eventRows = await prisma.integrationEvent.findMany({
        where: { integrationId, providerEventId },
      });
      expect(eventRows.length).toBe(1);

      // Let processor finish processing
      await processor.processEvent(eventRows[0].id);

      // Verify exactly 1 ExternalOrder created
      const orderCount = await prisma.externalOrder.count({
        where: { organizationId: orgId, externalOrderNumber: orderNumber },
      });
      expect(orderCount).toBe(1);
    });
  });

  describe('5. Permanent Malformed Payload Failure Handling', () => {
    it('marks malformed payload FAILED without creating infinite scanner retry loops', async () => {
      const providerEventId = `evt_malformed_${Date.now()}`;

      // Missing required orderNumber in payload
      const event = await prisma.integrationEvent.create({
        data: {
          organizationId: orgId,
          integrationId,
          providerEventId,
          eventType: 'ORDER_CREATED',
          payload: { invalidField: true },
          status: IntegrationEventStatus.RECEIVED,
        },
      });

      // First processing fails validation
      const result = await processor.processEvent(event.id);
      expect(result.status).toBe(IntegrationEventStatus.FAILED);
      expect(result.errorCode).toBe('MALFORMED_PAYLOAD');
      expect(result.errorMessage).toBeDefined();

      // Subsequent scanner tick must NOT retry or loop on FAILED event
      const tickCount = await processor.tick();
      expect(tickCount).toBe(0);

      // Event remains terminal FAILED
      const finalEvent = await prisma.integrationEvent.findUnique({
        where: { id: event.id },
      });
      expect(finalEvent?.status).toBe(IntegrationEventStatus.FAILED);
    });
  });

  describe('6. Production Lifecycle & Timer Hygiene', () => {
    it('starts and stops scanner loop cleanly without leaking timers or requiring --forceExit', async () => {
      const testProcessor = new WebhookEventProcessorService(
        prisma,
        targetedReconciliation,
        new ConfigService({
          nodeEnv: 'test',
          webhookScannerEnabled: true,
          webhookScannerIntervalMs: 50,
          webhookStaleThresholdMs: 1000,
          webhookScannerBatchSize: 10,
        }),
      );

      expect(testProcessor.getIsRunning()).toBe(false);

      // Start loop
      testProcessor.start();
      expect(testProcessor.getIsRunning()).toBe(true);

      // Stop loop gracefully
      await testProcessor.stop();
      expect(testProcessor.getIsRunning()).toBe(false);
    });
  });
});
