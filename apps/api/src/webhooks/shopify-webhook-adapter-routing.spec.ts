import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { UnauthorizedException } from '@nestjs/common';
import {
  Prisma,
  IntegrationProvider,
  IntegrationStatus,
  IntegrationEventStatus,
  ExternalOrderStatus,
} from '@reloop/database';
import { WebhookEventProcessorService } from './webhook-event-processor.service';
import { TargetedReconciliationService } from './targeted-reconciliation.service';
import { WebhooksService } from './webhooks.service';
import { WebhookAdapterRegistry } from './webhook-adapter.registry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { ConfigService } from '@nestjs/config';
import { SimulatorWebhookAdapter } from '@reloop/connector-simulator';
import { ShopifyWebhookAdapter } from '@reloop/connector-shopify';

describe('E-03: Shopify Webhook Adapter Routing & Normalization Specification', () => {
  let prisma: PrismaService;
  let registry: WebhookAdapterRegistry;
  let processor: WebhookEventProcessorService;
  let webhooksService: WebhooksService;
  let targetedReconciliation: TargetedReconciliationService;
  let configService: ConfigService;

  const shopifySecret = 'shpss_test_shopify_client_secret_xyz123';
  const shopDomain = 'reloop-e03-test-store.myshopify.com';

  let orgId: string;
  let shopifyIntegrationId: string;
  let simulatorIntegrationId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    configService = new ConfigService({
      nodeEnv: 'test',
      webhookScannerEnabled: false,
      webhookScannerIntervalMs: 50,
      webhookStaleThresholdMs: 1000,
      webhookScannerBatchSize: 50,
      simulatorWebhookSecret: 'sim_secret_123',
      shopifyClientSecret: shopifySecret,
      shopifyScopes: 'read_orders',
      webhookMaxPayloadBytes: 1048576,
    });

    const mockRealtimePublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as RealtimePublisher;

    registry = new WebhookAdapterRegistry();
    targetedReconciliation = new TargetedReconciliationService(prisma, mockRealtimePublisher);
    processor = new WebhookEventProcessorService(prisma, targetedReconciliation, configService, registry);
    webhooksService = new WebhooksService(prisma, configService, processor, registry);
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
      data: { name: `E03 Test Org ${runId}`, slug: `e03-test-org-${runId}` },
    });
    orgId = org.id;

    const shopifyIntegration = await prisma.integration.create({
      data: {
        organizationId: orgId,
        provider: IntegrationProvider.SHOPIFY,
        name: 'Shopify E03 Store',
        status: IntegrationStatus.CONNECTED,
        shopDomain: `${runId}-${shopDomain}`,
        configuration: {
          webhookSecret: shopifySecret,
        },
      },
    });
    shopifyIntegrationId = shopifyIntegration.id;

    const simulatorIntegration = await prisma.integration.create({
      data: {
        organizationId: orgId,
        provider: IntegrationProvider.SIMULATOR,
        name: 'Simulator E03 Store',
        status: IntegrationStatus.CONNECTED,
        configuration: {
          webhookSecret: 'sim_secret_123',
        },
      },
    });
    simulatorIntegrationId = simulatorIntegration.id;
  });

  function generateShopifyHmac(body: string, secret = shopifySecret): string {
    return crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');
  }

  describe('1. Shared Adapter Registry & Provider Mappings', () => {
    it('maps SHOPIFY to ShopifyWebhookAdapter instance', () => {
      const adapter = registry.getAdapter('SHOPIFY');
      expect(adapter).toBeInstanceOf(ShopifyWebhookAdapter);
      expect(adapter.provider).toBe('SHOPIFY');
    });

    it('maps SIMULATOR to SimulatorWebhookAdapter instance', () => {
      const adapter = registry.getAdapter('SIMULATOR');
      expect(adapter).toBeInstanceOf(SimulatorWebhookAdapter);
      expect(adapter.provider).toBe('SIMULATOR');
    });

    it('maps SHIPSTATION to SimulatorWebhookAdapter instance', () => {
      const adapter = registry.getAdapter('SHIPSTATION');
      expect(adapter).toBeInstanceOf(SimulatorWebhookAdapter);
    });

    it('maps GENERIC_3PL to SimulatorWebhookAdapter instance', () => {
      const adapter = registry.getAdapter('GENERIC_3PL');
      expect(adapter).toBeInstanceOf(SimulatorWebhookAdapter);
    });

    it('fails explicitly for unknown provider without falling back to simulator', () => {
      expect(() => registry.getAdapter('NON_EXISTENT_PROVIDER')).toThrow(
        /Unsupported webhook provider: NON_EXISTENT_PROVIDER/,
      );
      expect(() => webhooksService.getAdapter('UNKNOWN_PROVIDER')).toThrow(
        /Unsupported webhook provider: UNKNOWN_PROVIDER/,
      );
      expect(() => processor.getAdapter('UNKNOWN_PROVIDER')).toThrow(
        /Unsupported webhook provider: UNKNOWN_PROVIDER/,
      );
    });
  });

  describe('2. Wrong-Adapter Regression (Proves Defect Reproduction & Resolution)', () => {
    const realisticShopifyPayload = {
      id: 99881122,
      order_number: 1001, // Numeric! Not string
      admin_graphql_api_id: 'gid://shopify/Order/99881122',
      fulfillment_status: 'fulfilled',
      total_price: '149.99',
      currency: 'USD',
      line_items: [
        { id: 101, sku: 'SKU-HOODIE-M', quantity: 2, title: 'Classic Hoodie' },
      ],
      fulfillments: [
        { tracking_number: '1Z999AA10123456784', tracking_company: 'UPS' },
      ],
      created_at: '2026-09-24T10:00:00Z',
      updated_at: '2026-09-24T10:05:00Z',
    };

    it('proves that SimulatorWebhookAdapter fails to normalize realistic Shopify payload with numeric order_number', () => {
      const simulatorAdapter = new SimulatorWebhookAdapter();
      // When fed realistic Shopify payload, SimulatorWebhookAdapter throws because order_number is numeric
      expect(() => {
        simulatorAdapter.normalize(realisticShopifyPayload, 'orders/create');
      }).toThrow(/Malformed order webhook payload: missing valid orderNumber/);
    });

    it('proves that ShopifyWebhookAdapter succeeds in normalizing realistic Shopify payload with numeric order_number', () => {
      const shopifyAdapter = registry.getAdapter('SHOPIFY');
      const normalized = shopifyAdapter.normalize(realisticShopifyPayload, 'orders/create');

      expect(normalized).not.toBeNull();
      expect(normalized?.domain.type).toBe('ORDER');
      if (normalized?.domain.type === 'ORDER') {
        expect(normalized.domain.data.orderNumber).toBe('1001');
        expect(normalized.domain.data.externalOrderId).toBe('gid://shopify/Order/99881122');
        expect(normalized.domain.data.status).toBe('SHIPPED');
        expect(normalized.domain.data.totalAmount).toBe(149.99);
        expect(normalized.domain.data.trackingNumber).toBe('1Z999AA10123456784');
        expect(normalized.domain.data.carrier).toBe('UPS');
        expect(normalized.domain.data.lineItems).toEqual([
          { sku: 'SKU-HOODIE-M', quantity: 2, name: 'Classic Hoodie' },
        ]);
      }
    });
  });

  describe('3. End-to-End Durable Ingestion, Normalization & Projection Path', () => {
    it('ingests, durably stores, normalizes via ShopifyWebhookAdapter, and projects ExternalOrder for numeric order_number', async () => {
      const webhookId = crypto.randomUUID();
      const payload = {
        id: 55443322,
        order_number: 1002, // Numeric
        admin_graphql_api_id: 'gid://shopify/Order/55443322',
        fulfillment_status: null,
        total_price: '89.50',
        currency: 'USD',
        line_items: [
          { id: 201, sku: 'SKU-TEE-S', quantity: 1, title: 'Summer Tee' },
        ],
        created_at: new Date().toISOString(),
      };
      const rawPayload = JSON.stringify(payload);
      const rawBody = Buffer.from(rawPayload, 'utf8');
      const hmac = generateShopifyHmac(rawPayload);

      const headers = {
        'x-shopify-topic': 'orders/create',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-webhook-id': webhookId,
      };

      // 1. Ingestion
      const ingestResult = await webhooksService.ingestWebhook(
        'SHOPIFY',
        shopifyIntegrationId,
        rawBody,
        headers,
        payload,
      );

      expect(ingestResult.status).toBe('accepted');
      expect(ingestResult.providerEventId).toBe(webhookId);

      // 2. Persisted IntegrationEvent
      const persisted = await prisma.integrationEvent.findFirst({
        where: { providerEventId: webhookId },
      });
      expect(persisted).toBeDefined();
      expect(persisted?.status).toBe(IntegrationEventStatus.RECEIVED);
      expect(persisted?.organizationId).toBe(orgId);

      // 3. Durable processing via WebhookEventProcessorService
      const processed = await processor.processEvent(persisted!.id);

      expect(processed.status).toBe(IntegrationEventStatus.PROCESSED);
      expect(processed.errorCode).toBeNull();

      // 4. Projection into ExternalOrder
      const externalOrder = await prisma.externalOrder.findUnique({
        where: {
          organizationId_externalOrderNumber: {
            organizationId: orgId,
            externalOrderNumber: '1002',
          },
        },
      });

      expect(externalOrder).toBeDefined();
      expect(externalOrder?.externalOrderNumber).toBe('1002');
      expect(externalOrder?.status).toBe(ExternalOrderStatus.PENDING);
      expect(externalOrder?.currency).toBe('USD');
      expect(Number(externalOrder?.totalAmount)).toBe(89.5);

      // 5. Projection into ExternalReference
      const externalRef = await prisma.externalReference.findFirst({
        where: {
          organizationId: orgId,
          integrationId: shopifyIntegrationId,
          externalId: 'gid://shopify/Order/55443322',
        },
      });

      expect(externalRef).toBeDefined();
      expect(externalRef?.resourceType).toBe('SHOPIFY_ORDER');
    });

    it('correctly processes Shopify fulfillment webhook and updates ExternalOrder to DELIVERED', async () => {
      // First create order
      await prisma.externalOrder.create({
        data: {
          organizationId: orgId,
          primaryIntegrationId: shopifyIntegrationId,
          externalOrderNumber: '1003',
          status: ExternalOrderStatus.SHIPPED,
          lastObservedAt: new Date(Date.now() - 60000),
        },
      });

      const fulfillmentWebhookId = crypto.randomUUID();
      const fulfillmentPayload = {
        id: 771122,
        order_id: 889900,
        order_number: 1003, // Numeric
        status: 'success',
        tracking_number: '1Z888TRACK123',
        tracking_company: 'FedEx',
        updated_at: new Date().toISOString(),
      };
      const rawPayload = JSON.stringify(fulfillmentPayload);
      const rawBody = Buffer.from(rawPayload, 'utf8');
      const hmac = generateShopifyHmac(rawPayload);

      const headers = {
        'x-shopify-topic': 'fulfillments/create',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-webhook-id': fulfillmentWebhookId,
      };

      const ingestResult = await webhooksService.ingestWebhook(
        'SHOPIFY',
        shopifyIntegrationId,
        rawBody,
        headers,
        fulfillmentPayload,
      );

      expect(ingestResult.status).toBe('accepted');

      const persisted = await prisma.integrationEvent.findFirst({
        where: { providerEventId: fulfillmentWebhookId },
      });

      const processed = await processor.processEvent(persisted!.id);
      expect(processed.status).toBe(IntegrationEventStatus.PROCESSED);

      const updatedOrder = await prisma.externalOrder.findUnique({
        where: {
          organizationId_externalOrderNumber: {
            organizationId: orgId,
            externalOrderNumber: '1003',
          },
        },
      });

      expect(updatedOrder?.status).toBe(ExternalOrderStatus.DELIVERED);
    });
  });

  describe('4. Malformed Shopify Payload Handling', () => {
    it('fails safely with MALFORMED_PAYLOAD when payload is not a valid JSON object', async () => {
      const corruptEvent = await prisma.integrationEvent.create({
        data: {
          organizationId: orgId,
          integrationId: shopifyIntegrationId,
          eventType: 'orders/create',
          providerEventId: crypto.randomUUID(),
          payload: 'not-an-object' as any,
          status: IntegrationEventStatus.RECEIVED,
        },
      });

      const result = await processor.processEvent(corruptEvent.id);

      expect(result.status).toBe(IntegrationEventStatus.FAILED);
      expect(result.errorCode).toBe('MALFORMED_PAYLOAD');
      expect(result.errorMessage).toContain('expected JSON object');
    });
  });

  describe('5. Unsupported Provider Handling in WebhookEventProcessorService', () => {
    it('fails safely with UNSUPPORTED_PROVIDER when integration has an unsupported provider', async () => {
      const fakeIntegration = await prisma.integration.create({
        data: {
          organizationId: orgId,
          provider: 'SIMULATOR',
          name: 'Fake Integration',
          status: IntegrationStatus.CONNECTED,
        },
      });

      const event = await prisma.integrationEvent.create({
        data: {
          organizationId: orgId,
          integrationId: fakeIntegration.id,
          eventType: 'custom/event',
          providerEventId: crypto.randomUUID(),
          payload: { orderNumber: '123' },
          status: IntegrationEventStatus.RECEIVED,
        },
      });

      jest.spyOn(processor, 'getAdapter').mockImplementationOnce(() => {
        throw new Error('Unsupported webhook provider: UNKNOWN_TEST_PROVIDER');
      });

      const result = await processor.processEvent(event.id);

      expect(result.status).toBe(IntegrationEventStatus.FAILED);
      expect(result.errorCode).toBe('UNSUPPORTED_PROVIDER');
      expect(result.errorMessage).toContain('Unsupported webhook provider: UNKNOWN_TEST_PROVIDER');
    });
  });

  describe('6. Deduplication & Tenant Isolation Safety', () => {
    it('ensures duplicate Shopify deliveries produce exactly 1 IntegrationEvent and 1 ExternalOrder', async () => {
      const webhookId = crypto.randomUUID();
      const payload = {
        id: 334455,
        order_number: 1004,
        admin_graphql_api_id: 'gid://shopify/Order/334455',
        fulfillment_status: 'fulfilled',
        total_price: '50.00',
        created_at: new Date().toISOString(),
      };
      const rawPayload = JSON.stringify(payload);
      const rawBody = Buffer.from(rawPayload, 'utf8');
      const hmac = generateShopifyHmac(rawPayload);

      const headers = {
        'x-shopify-topic': 'orders/create',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-webhook-id': webhookId,
      };

      // Delivery 1
      const res1 = await webhooksService.ingestWebhook(
        'SHOPIFY',
        shopifyIntegrationId,
        rawBody,
        headers,
        payload,
      );
      expect(res1.status).toBe('accepted');

      // Process event 1
      const event1 = await prisma.integrationEvent.findFirst({
        where: { providerEventId: webhookId },
      });
      await processor.processEvent(event1!.id);

      // Delivery 2 (Identical delivery ID)
      const res2 = await webhooksService.ingestWebhook(
        'SHOPIFY',
        shopifyIntegrationId,
        rawBody,
        headers,
        payload,
      );
      expect(res2.status).toBe('ignored_duplicate');

      // Assert exactly 1 IntegrationEvent exists
      const eventCount = await prisma.integrationEvent.count({
        where: { providerEventId: webhookId },
      });
      expect(eventCount).toBe(1);

      // Assert exactly 1 ExternalOrder exists
      const orderCount = await prisma.externalOrder.count({
        where: {
          organizationId: orgId,
          externalOrderNumber: '1004',
        },
      });
      expect(orderCount).toBe(1);
    });

    it('derives tenant authority strictly from Integration, never trusting payload organizationId', async () => {
      const orderNum = Math.floor(100000 + Math.random() * 900000);
      const webhookId = crypto.randomUUID();
      const attackerSpoofedOrgId = crypto.randomUUID();
      const payload = {
        id: 778899,
        order_number: orderNum,
        organizationId: attackerSpoofedOrgId,
        admin_graphql_api_id: 'gid://shopify/Order/778899',
      };
      const rawPayload = JSON.stringify(payload);
      const rawBody = Buffer.from(rawPayload, 'utf8');
      const hmac = generateShopifyHmac(rawPayload);

      const headers = {
        'x-shopify-topic': 'orders/create',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-webhook-id': webhookId,
      };

      await webhooksService.ingestWebhook(
        'SHOPIFY',
        shopifyIntegrationId,
        rawBody,
        headers,
        payload,
      );

      const event = await prisma.integrationEvent.findFirst({
        where: { providerEventId: webhookId },
      });
      expect(event?.organizationId).toBe(orgId);
      expect(event?.organizationId).not.toBe(attackerSpoofedOrgId);

      await processor.processEvent(event!.id);

      const externalOrder = await prisma.externalOrder.findUnique({
        where: {
          organizationId_externalOrderNumber: {
            organizationId: orgId,
            externalOrderNumber: String(orderNum),
          },
        },
      });
      expect(externalOrder).toBeDefined();
      expect(externalOrder?.organizationId).toBe(orgId);
      expect(externalOrder?.organizationId).not.toBe(attackerSpoofedOrgId);
    });

    it('rejects tampered raw body with 401 Unauthorized', async () => {
      const payload = { id: 1, order_number: 1006 };
      const rawPayload = JSON.stringify(payload);
      const hmac = generateShopifyHmac(rawPayload);
      const tamperedBody = Buffer.from(JSON.stringify({ id: 1, order_number: 1007 }), 'utf8');

      const headers = {
        'x-shopify-topic': 'orders/create',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-webhook-id': crypto.randomUUID(),
      };

      await expect(
        webhooksService.ingestWebhook(
          'SHOPIFY',
          shopifyIntegrationId,
          tamperedBody,
          headers,
          payload,
        ),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
