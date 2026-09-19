import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, IntegrationEventStatus } from '@reloop/database';
import { WebhookAdapter } from '@reloop/integration-sdk';
import { SimulatorWebhookAdapter } from '@reloop/connector-simulator';
import { ShopifyWebhookAdapter } from '@reloop/connector-shopify';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventProcessorService } from './webhook-event-processor.service';
import { WebhookIngestResponseDto } from './dto/webhook-response.dto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly adapters = new Map<string, WebhookAdapter>();
  private readonly maxPayloadBytes: number;
  private readonly defaultSecret: string;
  private readonly shopifyClientSecret: string;
  private readonly requiredScopes: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly processor: WebhookEventProcessorService,
  ) {
    const simulatorAdapter = new SimulatorWebhookAdapter();
    const shopifyAdapter = new ShopifyWebhookAdapter();

    this.adapters.set('SIMULATOR', simulatorAdapter);
    this.adapters.set('SHOPIFY', shopifyAdapter);
    this.adapters.set('SHIPSTATION', simulatorAdapter);
    this.adapters.set('GENERIC_3PL', simulatorAdapter);

    this.maxPayloadBytes =
      this.configService.get<number>('webhookMaxPayloadBytes') || 1048576; // 1MB
    this.defaultSecret =
      this.configService.get<string>('simulatorWebhookSecret') ||
      'reloop_simulator_webhook_secret_dev';
    this.shopifyClientSecret =
      this.configService.get<string>('shopifyClientSecret') || '';
    this.requiredScopes = (
      this.configService.get<string>('shopifyScopes') || 'read_orders'
    )
      .split(',')
      .map((s) => s.trim());
  }

  getAdapter(provider: string): WebhookAdapter {
    const adapter = this.adapters.get(provider.toUpperCase());
    if (!adapter) {
      throw new BadRequestException(`Unsupported webhook provider: ${provider}`);
    }
    return adapter;
  }

  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) {
        const val = headers[key];
        return Array.isArray(val) ? val[0] : val;
      }
    }
    return undefined;
  }

  /**
   * Securely ingests a provider webhook:
   * 1. Validates payload size limits (< 1MB).
   * 2. Resolves Integration and derives tenant authority from Integration.organizationId.
   *    For Shopify, resolves tenant via verified X-Shopify-Shop-Domain header or integrationId.
   * 3. Validates provider path binding (Integration.provider MUST match route provider).
   * 4. Verifies HMAC-SHA256 signature against raw body bytes in constant-time.
   * 5. Enforces deduplication on (integrationId, providerEventId).
   * 6. Durably stores IntegrationEvent BEFORE responding.
   * 7. Handles provider-specific events (e.g. app/uninstalled).
   * 8. Dispatches asynchronous background processing for targeted reconciliation.
   */
  async ingestWebhook(
    provider: string,
    integrationId: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
    parsedPayload: unknown,
  ): Promise<WebhookIngestResponseDto> {
    const bodyBuffer = rawBody || Buffer.from(JSON.stringify(parsedPayload || {}), 'utf8');

    // 1. Payload size guard
    if (bodyBuffer.length > this.maxPayloadBytes) {
      this.logger.warn(
        `Rejected webhook payload: ${bodyBuffer.length} bytes exceeds limit of ${this.maxPayloadBytes}`,
      );
      throw new PayloadTooLargeException(
        `Webhook payload exceeds ${this.maxPayloadBytes} bytes limit`,
      );
    }

    const upperProvider = provider.toUpperCase();
    const adapter = this.getAdapter(upperProvider);

    // 2. Resolve Integration
    let integration: any = null;
    const shopDomainHeader = this.getHeader(headers, 'x-shopify-shop-domain');

    if (upperProvider === 'SHOPIFY' && shopDomainHeader) {
      // Lookup integration by Shopify shop domain for authentic tenant resolution
      integration = await this.prisma.integration.findUnique({
        where: { shopDomain: shopDomainHeader.toLowerCase() },
      });
      if (!integration) {
        throw new NotFoundException(
          `No integration registered for Shopify store "${shopDomainHeader}"`,
        );
      }
    } else {
      integration = await this.prisma.integration.findUnique({
        where: { id: integrationId },
      });
      if (!integration) {
        throw new NotFoundException(`Integration with ID ${integrationId} not found`);
      }
    }

    // Provider path binding: Integration.provider MUST match selected adapter
    if (integration.provider !== upperProvider) {
      throw new BadRequestException(
        `Provider mismatch: integration ${integration.id} is ${integration.provider}, cannot receive ${upperProvider} webhooks`,
      );
    }

    // 3. Resolve signing secret
    const config = (integration.configuration as Record<string, any>) || {};
    let secret: string;
    if (upperProvider === 'SHOPIFY') {
      secret = config.webhookSecret || this.shopifyClientSecret || this.defaultSecret;
    } else {
      secret = config.webhookSecret || this.defaultSecret;
    }

    // 4. Extract signature from headers
    const signature =
      this.getHeader(headers, 'x-shopify-hmac-sha256') ||
      this.getHeader(headers, 'x-reloop-signature') ||
      this.getHeader(headers, 'x-simulator-signature') ||
      this.getHeader(headers, 'x-hub-signature-256');

    if (!signature) {
      this.logger.warn(`Rejected webhook: missing signature header for integration ${integration.id}`);
      throw new UnauthorizedException('Missing required webhook signature header');
    }

    // 5. Cryptographically verify signature
    const isValid = adapter.verifySignature(bodyBuffer, signature, secret);

    if (!isValid) {
      this.logger.warn(`Rejected webhook: invalid signature for integration ${integration.id}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // 6. Extract event identity
    const identity = adapter.identifyEvent(headers, parsedPayload);
    if (!identity.providerEventId) {
      throw new BadRequestException('Missing provider event ID in webhook');
    }

    const organizationId = integration.organizationId;
    const providerEventId = identity.providerEventId;
    const eventType = identity.eventType;

    // 7. Deduplication check: return 200 ignored_duplicate for already ingested webhook IDs
    const existingEvent = await this.prisma.integrationEvent.findUnique({
      where: {
        integrationId_providerEventId: {
          integrationId: integration.id,
          providerEventId,
        },
      },
    });

    if (existingEvent) {
      this.logger.log(
        `Deduplicated incoming event (providerEventId: ${providerEventId}) for integration ${integration.id}`,
      );
      return {
        status: 'ignored_duplicate',
        eventId: existingEvent.id,
        providerEventId,
        receivedAt: existingEvent.createdAt.toISOString(),
      };
    }

    // 8. Disconnected Integration check: valid HMAC on disconnected store acknowledged with 200 ignored_disconnected
    if (integration.status === 'DISCONNECTED') {
      this.logger.log(
        `Safely acknowledging webhook for disconnected integration ${integration.id} (topic: ${eventType})`,
      );
      return {
        status: 'ignored_disconnected',
        providerEventId,
        receivedAt: new Date().toISOString(),
      };
    }

    // 9. Special Shopify lifecycle event handling: app/uninstalled
    if (upperProvider === 'SHOPIFY' && eventType.toLowerCase() === 'app/uninstalled') {
      this.logger.log(`Received app/uninstalled for shop ${integration.shopDomain}; disconnecting integration.`);
      await this.prisma.integration.update({
        where: { id: integration.id },
        data: {
          status: 'DISCONNECTED',
          encryptedCredentials: Prisma.DbNull,
        },
      });

      await this.prisma.auditLog.create({
        data: {
          organizationId,
          entityType: 'INTEGRATION',
          entityId: integration.id,
          action: 'SHOPIFY_INTEGRATION_UNINSTALLED',
          metadata: {
            shopDomain: integration.shopDomain,
          },
        },
      });

      const createdEvent = await this.prisma.integrationEvent.create({
        data: {
          organizationId,
          integrationId: integration.id,
          providerEventId,
          eventType,
          payload: (parsedPayload || {}) as Prisma.InputJsonValue,
          status: IntegrationEventStatus.PROCESSED,
        },
      });

      return {
        status: 'accepted',
        eventId: createdEvent.id,
        providerEventId,
        receivedAt: createdEvent.createdAt.toISOString(),
      };
    }

    // 10. Special Shopify lifecycle event handling: app/scopes_update
    if (upperProvider === 'SHOPIFY' && eventType.toLowerCase() === 'app/scopes_update') {
      const payloadObj = (parsedPayload as Record<string, any>) || {};
      const granted = (payloadObj.current || []) as string[];
      const missing = this.requiredScopes.filter((s) => !granted.includes(s));
      if (missing.length > 0) {
        this.logger.warn(`Shopify scopes revoked for ${integration.shopDomain}; missing: ${missing.join(', ')}`);
        await this.prisma.integration.update({
          where: { id: integration.id },
          data: { status: 'DEGRADED' },
        });

        await this.prisma.auditLog.create({
          data: {
            organizationId,
            entityType: 'INTEGRATION',
            entityId: integration.id,
            action: 'SHOPIFY_INTEGRATION_SCOPES_REVOKED',
            metadata: {
              shopDomain: integration.shopDomain,
              missingScopes: missing,
              currentScopes: granted,
            },
          },
        });
      }

      const createdEvent = await this.prisma.integrationEvent.create({
        data: {
          organizationId,
          integrationId: integration.id,
          providerEventId,
          eventType,
          payload: (parsedPayload || {}) as Prisma.InputJsonValue,
          status: IntegrationEventStatus.PROCESSED,
        },
      });

      return {
        status: 'accepted',
        eventId: createdEvent.id,
        providerEventId,
        receivedAt: createdEvent.createdAt.toISOString(),
      };
    }

    // 11. Durable persistence & asynchronous background processing
    try {
      const createdEvent = await this.prisma.integrationEvent.create({
        data: {
          organizationId,
          integrationId: integration.id,
          providerEventId,
          eventType,
          payload: (parsedPayload || {}) as Prisma.InputJsonValue,
          status: IntegrationEventStatus.RECEIVED,
        },
      });

      this.logger.log(
        `Ingested event ${createdEvent.id} (providerEventId: ${providerEventId}) for integration ${integration.id}`,
      );

      // Trigger background processing asynchronously
      setImmediate(() => {
        this.processor.processEvent(createdEvent.id).catch((err) => {
          this.logger.error(`Failed to process event ${createdEvent.id}: ${err.message}`, err.stack);
        });
      });

      return {
        status: 'accepted',
        eventId: createdEvent.id,
        providerEventId,
        receivedAt: createdEvent.createdAt.toISOString(),
      };
    } catch (err: any) {
      // Prisma P2002: Unique constraint violation on (integrationId, providerEventId)
      if (err.code === 'P2002') {
        this.logger.log(
          `Deduplicated incoming event (providerEventId: ${providerEventId}) for integration ${integration.id}`,
        );

        const existingRaceEvent = await this.prisma.integrationEvent.findUnique({
          where: {
            integrationId_providerEventId: {
              integrationId: integration.id,
              providerEventId,
            },
          },
        });

        return {
          status: 'ignored_duplicate',
          eventId: existingRaceEvent?.id || 'duplicate',
          providerEventId,
          receivedAt: existingRaceEvent?.createdAt
            ? existingRaceEvent.createdAt.toISOString()
            : new Date().toISOString(),
        };
      }

      this.logger.error(`Error saving integration event: ${err.message}`, err.stack);
      throw err;
    }
  }
}
