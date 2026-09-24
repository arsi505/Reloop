import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { PrismaService } from '../prisma/prisma.service';
import { TargetedReconciliationService } from './targeted-reconciliation.service';
import { WebhookAdapterRegistry } from './webhook-adapter.registry';

@Injectable()
export class WebhookEventProcessorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WebhookEventProcessorService.name);
  private readonly adapterRegistry: WebhookAdapterRegistry;

  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<unknown> | null = null;
  private readonly pendingDispatches = new Set<NodeJS.Immediate>();
  private running = false;
  private acceptingBackgroundWork = true;
  private isTicking = false;
  private intervalMs = 2000;
  private staleThresholdMs = 60000;
  private batchSize = 50;
  private enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly targetedReconciliation: TargetedReconciliationService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() adapterRegistry?: WebhookAdapterRegistry,
  ) {
    this.adapterRegistry = adapterRegistry ?? new WebhookAdapterRegistry();

    if (this.configService) {
      const nodeEnv = this.configService.get<string>('nodeEnv');
      this.enabled =
        this.configService.get<boolean>('webhookScannerEnabled') ?? true;
      this.intervalMs =
        this.configService.get<number>('webhookScannerIntervalMs') ??
        (nodeEnv === 'test' ? 100 : 2000);
      this.staleThresholdMs =
        this.configService.get<number>('webhookStaleThresholdMs') ?? 60000;
      this.batchSize =
        this.configService.get<number>('webhookScannerBatchSize') ?? 50;
    }
  }

  onModuleInit(): void {
    if (this.enabled) {
      this.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.acceptingBackgroundWork = true;
    this.running = true;
    this.logger.log(
      `[Reloop WebhookProcessor] Started durable recovery scanner (interval: ${this.intervalMs}ms, staleThreshold: ${this.staleThresholdMs}ms, batchSize: ${this.batchSize})`,
    );

    this.timer = setInterval(() => {
      if (!this.acceptingBackgroundWork || this.activeTick) return;

      const activeTick = this.tick()
        .catch((err: any) => {
          this.logger.error(
            `[Reloop WebhookProcessor] Error in scan tick: ${err.message}`,
            err.stack,
          );
        })
        .finally(() => {
          if (this.activeTick === activeTick) {
            this.activeTick = null;
          }
        });
      this.activeTick = activeTick;
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.acceptingBackgroundWork = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const dispatch of this.pendingDispatches) {
      clearImmediate(dispatch);
    }
    this.pendingDispatches.clear();

    const activeTick = this.activeTick;
    if (activeTick) {
      await Promise.allSettled([activeTick]);
    }
    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
    this.logger.log('[Reloop WebhookProcessor] Stopped durable recovery scanner.');
  }

  /**
   * Queues best-effort processing while retaining lifecycle ownership of the
   * scheduled callback. Shutdown cancels callbacks that have not started and
   * waits for callbacks that have already entered processEvent().
   */
  scheduleEventProcessing(eventId: string, description = 'event'): void {
    if (!this.acceptingBackgroundWork) return;

    const dispatch = setImmediate(() => {
      this.pendingDispatches.delete(dispatch);
      if (!this.acceptingBackgroundWork) return;

      void this.processEvent(eventId).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        this.logger.error(
          `Failed to process ${description} ${eventId}: ${message}`,
          stack,
        );
      });
    });
    this.pendingDispatches.add(dispatch);
  }

  getIsRunning(): boolean {
    return this.running;
  }

  setStaleThresholdMs(ms: number): void {
    this.staleThresholdMs = ms;
  }

  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
  }

  private readonly inFlight = new Map<string, Promise<IntegrationEvent>>();

  getAdapter(provider: string): WebhookAdapter {
    return this.adapterRegistry.getAdapter(provider);
  }

  /**
   * Processes a single IntegrationEvent durably and idempotently.
   * Joins in-flight promise if currently processing in-process,
   * otherwise atomically claims eligible events (RECEIVED or stale PROCESSING) via conditional updateMany.
   */
  async processEvent(
    eventId: string,
    overrideStaleThresholdMs?: number,
  ): Promise<IntegrationEvent> {
    const existing = this.inFlight.get(eventId);
    if (existing) {
      return existing;
    }

    const promise = this.doProcessEvent(eventId, overrideStaleThresholdMs);
    this.inFlight.set(eventId, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(eventId);
    }
  }

  private async doProcessEvent(
    eventId: string,
    overrideStaleThresholdMs?: number,
  ): Promise<IntegrationEvent> {
    const effectiveStaleThresholdMs =
      overrideStaleThresholdMs ?? this.staleThresholdMs;
    const staleThreshold = new Date(Date.now() - effectiveStaleThresholdMs);

    // 1. Atomic CAS claim:
    // Only an event in RECEIVED or stale PROCESSING (updatedAt < staleThreshold) can be claimed.
    // If active processing is underway or event is already terminal (PROCESSED/FAILED/IGNORED_DUPLICATE), count is 0.
    const claimResult = await this.prisma.integrationEvent.updateMany({
      where: {
        id: eventId,
        OR: [
          { status: IntegrationEventStatus.RECEIVED },
          {
            status: IntegrationEventStatus.PROCESSING,
            updatedAt: { lt: staleThreshold },
          },
        ],
      },
      data: {
        status: IntegrationEventStatus.PROCESSING,
        updatedAt: new Date(),
      },
    });

    if (claimResult.count === 0) {
      // Event could not be claimed: either already claimed by an active processor,
      // already processed, or terminal failed. Return current state without duplicate work.
      const current = await this.prisma.integrationEvent.findUnique({
        where: { id: eventId },
        include: { integration: true },
      });
      if (!current) {
        throw new Error(`IntegrationEvent ${eventId} not found`);
      }
      return current;
    }

    const event = await this.prisma.integrationEvent.findUnique({
      where: { id: eventId },
      include: { integration: true },
    });

    if (!event) {
      throw new Error(`IntegrationEvent ${eventId} not found`);
    }

    let adapter: WebhookAdapter;
    try {
      adapter = this.getAdapter(event.integration.provider);
    } catch (err: any) {
      this.logger.warn(`Unsupported provider for event ${eventId}: ${err.message}`);
      return this.prisma.integrationEvent.update({
        where: { id: eventId },
        data: {
          status: IntegrationEventStatus.FAILED,
          errorCode: 'UNSUPPORTED_PROVIDER',
          errorMessage: err.message || `Unsupported webhook provider: ${event.integration.provider}`,
          processedAt: new Date(),
        },
      });
    }

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
   * Guarded against re-entrancy and uses configured batchSize and staleThresholdMs.
   */
  async tick(batchSize = this.batchSize): Promise<number> {
    if (this.isTicking) {
      return 0;
    }
    this.isTicking = true;
    try {
      const staleThreshold = new Date(Date.now() - this.staleThresholdMs);

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
        select: { id: true },
      });

      let processedCount = 0;
      for (const ev of events) {
        try {
          const res = await this.processEvent(ev.id);
          if (res.status === IntegrationEventStatus.PROCESSED) {
            processedCount++;
          }
        } catch (err: any) {
          this.logger.error(
            `[Reloop WebhookProcessor] Error processing event ${ev.id}: ${err.message}`,
            err.stack,
          );
        }
      }

      return processedCount;
    } finally {
      this.isTicking = false;
    }
  }
}
