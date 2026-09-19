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
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventProcessorService } from './webhook-event-processor.service';
import { WebhookIngestResponseDto } from './dto/webhook-response.dto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly adapters = new Map<string, WebhookAdapter>();
  private readonly maxPayloadBytes: number;
  private readonly defaultSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly processor: WebhookEventProcessorService,
  ) {
    const simulatorAdapter = new SimulatorWebhookAdapter();
    this.adapters.set('SIMULATOR', simulatorAdapter);
    this.adapters.set('SHOPIFY', simulatorAdapter);
    this.adapters.set('SHIPSTATION', simulatorAdapter);
    this.adapters.set('GENERIC_3PL', simulatorAdapter);

    this.maxPayloadBytes =
      this.configService.get<number>('webhookMaxPayloadBytes') || 1048576; // 1MB
    this.defaultSecret =
      this.configService.get<string>('simulatorWebhookSecret') ||
      'reloop_simulator_webhook_secret_dev';
  }

  getAdapter(provider: string): WebhookAdapter {
    const adapter = this.adapters.get(provider.toUpperCase());
    if (!adapter) {
      return this.adapters.get('SIMULATOR')!;
    }
    return adapter;
  }

  /**
   * Securely ingests a provider webhook:
   * 1. Validates payload size limits.
   * 2. Resolves Integration and derives tenant authority from Integration.organizationId.
   * 3. Verifies HMAC-SHA256 signature against raw body bytes in constant-time.
   * 4. Enforces deduplication on (integrationId, providerEventId).
   * 5. Durably stores IntegrationEvent BEFORE responding.
   * 6. Dispatches asynchronous processing.
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
      this.logger.warn(`Rejected webhook payload: ${bodyBuffer.length} bytes exceeds limit of ${this.maxPayloadBytes}`);
      throw new PayloadTooLargeException(`Webhook payload exceeds ${this.maxPayloadBytes} bytes limit`);
    }

    // 2. Resolve Integration
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
    });

    if (!integration) {
      throw new NotFoundException(`Integration with ID ${integrationId} not found`);
    }

    if (integration.status === 'DISCONNECTED') {
      throw new BadRequestException(`Integration ${integrationId} is disconnected`);
    }

    // 3. Resolve signing secret
    const config = (integration.configuration as Record<string, any>) || {};
    const secret = config.webhookSecret || this.defaultSecret;

    // 4. Extract signature from headers
    const signature =
      (headers['x-reloop-signature'] as string) ||
      (headers['x-simulator-signature'] as string) ||
      (headers['x-hub-signature-256'] as string);

    if (!signature) {
      this.logger.warn(`Rejected webhook: missing signature header for integration ${integrationId}`);
      throw new UnauthorizedException('Missing required webhook signature header');
    }

    // 5. Cryptographically verify signature
    const adapter = this.getAdapter(provider);
    const isValid = adapter.verifySignature(bodyBuffer, signature, secret);

    if (!isValid) {
      this.logger.warn(`Rejected webhook: invalid signature for integration ${integrationId}`);
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

    // 7. Durable persistence & deduplication
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
          this.logger.error(`Background processing failed for event ${createdEvent.id}:`, err);
        });
      });

      return {
        status: 'accepted',
        eventId: createdEvent.id,
        providerEventId,
        receivedAt: createdEvent.receivedAt.toISOString(),
      };
    } catch (err: any) {
      // Catch duplicate constraint on (integrationId, providerEventId)
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.integrationEvent.findUnique({
          where: {
            integrationId_providerEventId: {
              integrationId: integration.id,
              providerEventId,
            },
          },
        });

        if (existing) {
          this.logger.log(
            `Deduped duplicate delivery of event ${existing.id} (providerEventId: ${providerEventId})`,
          );
          return {
            status: 'ignored_duplicate',
            eventId: existing.id,
            providerEventId,
            receivedAt: existing.receivedAt.toISOString(),
          };
        }
      }

      throw err;
    }
  }
}
