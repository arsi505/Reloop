import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { SimulatorWebhookAdapter } from '@reloop/connector-simulator';
import { WebhooksService } from './webhooks.service';
import { WebhookAdapterRegistry } from './webhook-adapter.registry';

describe('N-08: provider-specific webhook signing', () => {
  const shopifySecret = 'n08_shopify_secret';
  const simulatorSecret = 'reloop_simulator_webhook_secret_dev';
  const rawBody = Buffer.from(JSON.stringify({ id: 801, order_number: 801 }), 'utf8');

  function createHarness(options: {
    provider: 'SHOPIFY' | 'SIMULATOR';
    integrationSecret?: string;
    applicationSecret?: string;
  }) {
    const integration = {
      id: `n08-${options.provider.toLowerCase()}`,
      organizationId: 'n08-org',
      provider: options.provider,
      status: 'CONNECTED',
      shopDomain: options.provider === 'SHOPIFY' ? 'n08.myshopify.com' : null,
      configuration: options.integrationSecret
        ? { webhookSecret: options.integrationSecret }
        : {},
    };
    const createdAt = new Date();
    const prisma = {
      integration: {
        findUnique: jest.fn().mockResolvedValue(integration),
      },
      integrationEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'n08-event', createdAt }),
      },
    } as any;
    const processor = {
      scheduleEventProcessing: jest.fn(),
    } as any;
    const config = new ConfigService({
      webhookMaxPayloadBytes: 1048576,
      shopifyClientSecret: options.applicationSecret || '',
      simulatorWebhookSecret: simulatorSecret,
      shopifyScopes: 'read_orders',
    });
    const service = new WebhooksService(
      prisma,
      config,
      processor,
      new WebhookAdapterRegistry(),
    );
    return { service, prisma, processor, integration };
  }

  function shopifySignature(secret: string, body: Buffer = rawBody): string {
    return crypto.createHmac('sha256', secret).update(body).digest('base64');
  }

  function shopifyHeaders(signature?: string) {
    return {
      'x-shopify-topic': 'orders/create',
      'x-shopify-webhook-id': crypto.randomUUID(),
      ...(signature ? { 'x-shopify-hmac-sha256': signature } : {}),
    };
  }

  it('accepts a valid Shopify signature from the configured Shopify secret', async () => {
    const { service } = createHarness({ provider: 'SHOPIFY', applicationSecret: shopifySecret });
    await expect(
      service.ingestWebhook(
        'SHOPIFY',
        'n08-shopify',
        rawBody,
        shopifyHeaders(shopifySignature(shopifySecret)),
        JSON.parse(rawBody.toString('utf8')),
      ),
    ).resolves.toMatchObject({ status: 'accepted' });
  });

  it('rejects an invalid Shopify signature', async () => {
    const { service } = createHarness({ provider: 'SHOPIFY', applicationSecret: shopifySecret });
    await expect(
      service.ingestWebhook(
        'SHOPIFY',
        'n08-shopify',
        rawBody,
        shopifyHeaders(shopifySignature('wrong-secret')),
        JSON.parse(rawBody.toString('utf8')),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a Shopify request signed with the simulator secret when Shopify config is absent', async () => {
    const { service } = createHarness({ provider: 'SHOPIFY' });
    await expect(
      service.ingestWebhook(
        'SHOPIFY',
        'n08-shopify',
        rawBody,
        shopifyHeaders(shopifySignature(simulatorSecret)),
        JSON.parse(rawBody.toString('utf8')),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unsigned Shopify request when Shopify config is absent', async () => {
    const { service } = createHarness({ provider: 'SHOPIFY' });
    await expect(
      service.ingestWebhook(
        'SHOPIFY',
        'n08-shopify',
        rawBody,
        shopifyHeaders(),
        JSON.parse(rawBody.toString('utf8')),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('keeps simulator verification on the simulator-specific secret', async () => {
    const { service } = createHarness({ provider: 'SIMULATOR' });
    const adapter = new SimulatorWebhookAdapter();
    await expect(
      service.ingestWebhook(
        'SIMULATOR',
        'n08-simulator',
        rawBody,
        {
          'x-reloop-event-type': 'ORDER_CREATED',
          'x-reloop-event-id': crypto.randomUUID(),
          'x-reloop-signature': adapter.signPayload(rawBody, simulatorSecret),
        },
        JSON.parse(rawBody.toString('utf8')),
      ),
    ).resolves.toMatchObject({ status: 'accepted' });
  });

  it('preserves raw-body verification for Shopify', async () => {
    const { service } = createHarness({ provider: 'SHOPIFY', applicationSecret: shopifySecret });
    const alteredBody = Buffer.from(JSON.stringify({ id: 801, order_number: 802 }), 'utf8');
    await expect(
      service.ingestWebhook(
        'SHOPIFY',
        'n08-shopify',
        alteredBody,
        shopifyHeaders(shopifySignature(shopifySecret)),
        JSON.parse(rawBody.toString('utf8')),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
