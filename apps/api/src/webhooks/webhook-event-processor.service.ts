import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  IntegrationEvent,
  IntegrationEventStatus,
  ExternalOrderStatus,
} from '@reloop/database';
import {
  WebhookAdapter,
  NormalizedWebhookEvent,
} from '@reloop/integration-sdk';
import { SimulatorWebhookAdapter } from '@reloop/connector-simulator';
import { PrismaService } from '../prisma/prisma.service';
import { TargetedReconciliationService } from './targeted-reconciliation.service';

@Injectable()
export class WebhookEventProcessorService {
  private readonly logger = new Logger(WebhookEventProcessorService.name);
  private readonly adapters = new Map<string, WebhookAdapter>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly targetedReconciliation: TargetedReconciliationService,
  ) {
    const simulatorAdapter = new SimulatorWebhookAdapter();
    this.adapters.set('SIMULATOR', simulatorAdapter);
    this.adapters.set('SHOPIFY', simulatorAdapter);
    this.adapters.set('SHIPSTATION', simulatorAdapter);
    this.adapters.set('GENERIC_3PL', simulatorAdapter);
  }

  getAdapter(provider: string): WebhookAdapter {
    const adapter = this.adapters.get(provider.toUpperCase());
    if (!adapter) {
      // Default to simulator adapter for now
      return this.adapters.get('SIMULATOR')!;
    }
    return adapter;
  }

  /**
   * Processes a single IntegrationEvent durably and idempotently.
   */
  async processEvent(eventId: string): Promise<IntegrationEvent> {
    const event = await this.prisma.integrationEvent.findUnique({
      where: { id: eventId },
      include: { integration: true },
    });

    if (!event) {
      throw new Error(`IntegrationEvent ${eventId} not found`);
    }

    if (
      event.status === IntegrationEventStatus.PROCESSED ||
      event.status === IntegrationEventStatus.IGNORED_DUPLICATE
    ) {
      return event;
    }

    // Mark as PROCESSING
    await this.prisma.integrationEvent.update({
      where: { id: eventId },
      data: { status: IntegrationEventStatus.PROCESSING },
    });

    const adapter = this.getAdapter(event.integration.provider);

    let normalized: NormalizedWebhookEvent | null = null;
    try {
      normalized = adapter.normalize(event.payload, event.eventType);
    } catch (err: any) {
      this.logger.warn(`Malformed webhook payload for event ${eventId}: ${err.message}`);
      return this.prisma.integrationEvent.update({
        where: { id: eventId },
        data: {
          status: IntegrationEventStatus.FAILED,
          errorCode: 'MALFORMED_PAYLOAD',
          errorMessage: err.message || 'Payload validation failed',
          processedAt: new Date(),
        },
      });
    }

    // Unsupported or intentionally ignored event type
    if (!normalized) {
      this.logger.log(`Ignoring unsupported or unhandled event type "${event.eventType}" for event ${eventId}`);
      return this.prisma.integrationEvent.update({
        where: { id: eventId },
        data: {
          status: IntegrationEventStatus.PROCESSED,
          processedAt: new Date(),
          errorMessage: 'UNSUPPORTED_EVENT_IGNORED',
        },
      });
    }

    const orgId = event.organizationId;
    const { domain } = normalized;

    // Handle ORDER, FULFILLMENT, or SHIPMENT updates
    if (domain.type === 'ORDER' || domain.type === 'FULFILLMENT' || domain.type === 'SHIPMENT') {
      const orderNumber = domain.data.orderNumber;
      const occurredAt = domain.data.occurredAt || event.receivedAt;

      // Check existing ExternalOrder for out-of-order detection
      const existingOrder = await this.prisma.externalOrder.findUnique({
        where: {
          organizationId_externalOrderNumber: {
            organizationId: orgId,
            externalOrderNumber: orderNumber,
          },
        },
      });

      // OUT-OF-ORDER GUARD:
      // If the incoming event is older than the existing state's lastObservedAt, do not regress!
      if (existingOrder && existingOrder.lastObservedAt > occurredAt) {
        this.logger.warn(
          `Out-of-order event detected for order ${orderNumber}. Existing: ${existingOrder.lastObservedAt.toISOString()}, Event: ${occurredAt.toISOString()}. Preserving newer state.`,
        );

        return this.prisma.integrationEvent.update({
          where: { id: eventId },
          data: {
            status: IntegrationEventStatus.PROCESSED,
            processedAt: new Date(),
            errorMessage: 'SUPERSEDED_BY_NEWER_STATE',
          },
        });
      }

      // Map domain status to ExternalOrderStatus
      let externalStatus: ExternalOrderStatus = ExternalOrderStatus.PENDING;
      if (domain.type === 'SHIPMENT' || (domain.type === 'ORDER' && domain.data.status === 'SHIPPED')) {
        externalStatus = ExternalOrderStatus.SHIPPED;
      } else if (domain.type === 'FULFILLMENT' && domain.data.fulfillmentStatus === 'FULFILLED') {
        externalStatus = ExternalOrderStatus.DELIVERED;
      } else if (existingOrder) {
        externalStatus = existingOrder.status;
      }

      // Project into ExternalOrder
      const externalOrder = await this.prisma.externalOrder.upsert({
        where: {
          organizationId_externalOrderNumber: {
            organizationId: orgId,
            externalOrderNumber: orderNumber,
          },
        },
        create: {
          organizationId: orgId,
          primaryIntegrationId: event.integrationId,
          externalOrderNumber: orderNumber,
          customerReference: domain.type === 'ORDER' ? domain.data.customerReference : undefined,
          status: externalStatus,
          currency: domain.type === 'ORDER' ? domain.data.currency : undefined,
          totalAmount: domain.type === 'ORDER' && domain.data.totalAmount ? new Prisma.Decimal(domain.data.totalAmount) : undefined,
          sourceCreatedAt: domain.type === 'ORDER' ? domain.data.sourceCreatedAt : undefined,
          lastObservedAt: occurredAt,
        },
        update: {
          status: externalStatus,
          lastObservedAt: occurredAt,
          customerReference: domain.type === 'ORDER' && domain.data.customerReference ? domain.data.customerReference : undefined,
          currency: domain.type === 'ORDER' && domain.data.currency ? domain.data.currency : undefined,
          totalAmount: domain.type === 'ORDER' && domain.data.totalAmount ? new Prisma.Decimal(domain.data.totalAmount) : undefined,
          updatedAt: new Date(),
        },
      });

      // Project ExternalReference based on event type & provider
      const resourceType =
        domain.type === 'SHIPMENT'
          ? 'WAREHOUSE_ORDER'
          : event.integration.provider === 'GENERIC_3PL'
          ? 'WAREHOUSE_ORDER'
          : 'SHOPIFY_ORDER';

      const externalId =
        (domain.type === 'SHIPMENT' && domain.data.externalShipmentId) ||
        (domain.type === 'ORDER' && domain.data.externalOrderId) ||
        orderNumber;

      const metadata: Record<string, any> = {
        orderNumber,
        status: domain.type === 'SHIPMENT' ? domain.data.shipmentStatus : domain.type === 'FULFILLMENT' ? domain.data.fulfillmentStatus : domain.data.status,
        fulfillmentStatus: domain.type === 'FULFILLMENT' ? domain.data.fulfillmentStatus : (event.payload as any)?.fulfillmentStatus || (domain.type === 'ORDER' && domain.data.status === 'UNFULFILLED' ? 'UNFULFILLED' : undefined),
        trackingNumber: domain.data.trackingNumber,
        carrier: domain.data.carrier,
        lineItems: domain.type === 'ORDER' ? domain.data.lineItems : undefined,
        candidateOrders: (event.payload as any)?.candidateOrders,
        error: (event.payload as any)?.error,
      };

      await this.prisma.externalReference.upsert({
        where: {
          organizationId_integrationId_resourceType_externalId: {
            organizationId: orgId,
            integrationId: event.integrationId,
            resourceType,
            externalId,
          },
        },
        create: {
          organizationId: orgId,
          externalOrderId: externalOrder.id,
          integrationId: event.integrationId,
          resourceType,
          externalId,
          externalReference: JSON.stringify(metadata),
        },
        update: {
          externalOrderId: externalOrder.id,
          externalReference: JSON.stringify(metadata),
          updatedAt: new Date(),
        },
      });

      // Trigger targeted reconciliation for this specific order
      await this.targetedReconciliation.reconcileTargetedOrder(
        orgId,
        orderNumber,
        externalOrder.id,
      );
    }

    // Mark as PROCESSED
    return this.prisma.integrationEvent.update({
      where: { id: eventId },
      data: {
        status: IntegrationEventStatus.PROCESSED,
        processedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
  }

  /**
   * Replays an event safely and idempotently.
   */
  async replayEvent(eventId: string): Promise<IntegrationEvent> {
    await this.prisma.integrationEvent.update({
      where: { id: eventId },
      data: {
        status: IntegrationEventStatus.RECEIVED,
        errorCode: null,
        errorMessage: null,
      },
    });

    return this.processEvent(eventId);
  }

  /**
   * Scanner tick to process pending RECEIVED or stale PROCESSING events.
   */
  async tick(batchSize = 50): Promise<number> {
    const staleThreshold = new Date(Date.now() - 60000);

    const events = await this.prisma.integrationEvent.findMany({
      where: {
        OR: [
          { status: IntegrationEventStatus.RECEIVED },
          {
            status: IntegrationEventStatus.PROCESSING,
            updatedAt: { lt: staleThreshold },
          },
        ],
      },
      take: batchSize,
      orderBy: { createdAt: 'asc' },
    });

    let processedCount = 0;
    for (const ev of events) {
      try {
        await this.processEvent(ev.id);
        processedCount++;
      } catch (err: any) {
        this.logger.error(`Error processing event ${ev.id}:`, err.message);
      }
    }

    return processedCount;
  }
}
