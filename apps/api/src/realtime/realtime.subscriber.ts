import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RealtimeNotification } from '@reloop/contracts';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimePublisher, REALTIME_REDIS_CHANNEL } from './realtime.publisher';

/**
 * RealtimeSubscriber
 *
 * Listens on the Redis pub/sub channel `reloop:realtime:events` using a dedicated subscriber connection.
 * Guarantees that any event published by workers, schedulers, or other API instances
 * is immediately dispatched to the appropriate tenant room in this Socket.IO gateway.
 */
@Injectable()
export class RealtimeSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeSubscriber.name);
  private subscriberClient: Redis | null = null;
  private isRedisSubscribed = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  private localBusListener: ((notification: RealtimeNotification) => void) | null = null;

  async onModuleInit() {
    const redisUrl = this.configService.get<string>('redisUrl') || 'redis://localhost:6380';

    try {
      this.subscriberClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 3000,
        lazyConnect: true,
      });

      await this.subscriberClient.connect();
      await this.subscriberClient.subscribe(REALTIME_REDIS_CHANNEL);
      this.isRedisSubscribed = true;

      this.subscriberClient.on('message', (channel: string, message: string) => {
        if (channel !== REALTIME_REDIS_CHANNEL) return;
        try {
          const notification = JSON.parse(message) as RealtimeNotification;
          this.realtimeGateway.emitToOrganization(notification);
        } catch (err: unknown) {
          this.logger.warn(`Failed to parse realtime message from Redis: ${(err as Error).message}`);
        }
      });

      this.logger.log(`Successfully subscribed to Redis channel: ${REALTIME_REDIS_CHANNEL}`);
    } catch (err: unknown) {
      this.logger.warn(
        `Could not connect Redis subscriber on startup (${(err as Error).message}). Falling back to local event bus.`,
      );
    }

    // Fallback: local bus listener for environments without active Redis or during disconnection
    this.localBusListener = (notification: RealtimeNotification) => {
      // If Redis subscriber is active, Redis will handle delivery; otherwise local bus delivers
      if (!this.isRedisSubscribed) {
        this.realtimeGateway.emitToOrganization(notification);
      }
    };
    RealtimePublisher.localBus.on('notification', this.localBusListener);
  }

  async onModuleDestroy() {
    if (this.localBusListener) {
      RealtimePublisher.localBus.off('notification', this.localBusListener);
      this.localBusListener = null;
    }
    if (this.subscriberClient) {
      try {
        await this.subscriberClient.unsubscribe(REALTIME_REDIS_CHANNEL).catch(() => {});
        this.subscriberClient.disconnect();
      } catch {
        // ignore on shutdown
      }
      this.subscriberClient = null;
      this.logger.log('Redis subscriber disconnected cleanly');
    }
  }
}
