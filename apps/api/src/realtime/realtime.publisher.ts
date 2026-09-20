import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { RealtimeNotification } from '@reloop/contracts';
import { EventEmitter } from 'events';

export const REALTIME_REDIS_CHANNEL = 'reloop:realtime:events';

/**
 * RealtimePublisher
 *
 * Single-responsibility abstraction for publishing safe realtime invalidation events.
 * Dispatches to Redis Pub/Sub channel `reloop:realtime:events` to ensure cross-instance fanout.
 * Under no circumstances does this touch the `reloop:jobs:ready` durable Redis stream.
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger(RealtimePublisher.name);
  public static readonly localBus = new EventEmitter();

  constructor(private readonly redisService: RedisService) {}

  /**
   * Publishes an invalidation notification after a durable PostgreSQL transaction has committed.
   */
  async publish(notification: RealtimeNotification): Promise<void> {
    try {
      const payloadString = JSON.stringify(notification);

      // 1. Emit locally on process event bus (for single-process resilience / testing)
      RealtimePublisher.localBus.emit('notification', notification);

      // 2. Publish to Redis channel for multi-instance fanout across all API instances
      const redisClient = this.redisService.getClient();
      if (redisClient && redisClient.status === 'ready') {
        await redisClient.publish(REALTIME_REDIS_CHANNEL, payloadString);
      } else {
        this.logger.debug(
          `Redis client not ready; event ${notification.eventType} emitted via local bus only.`,
        );
      }

      this.logger.log(
        `[RealtimePublisher] Published ${notification.eventType} for org:${notification.organizationId} (resource: ${notification.resourceId ?? 'N/A'})`,
      );
    } catch (err: unknown) {
      // Realtime notifications are best-effort optimizations. Failure to emit must never fail a durable DB commit.
      this.logger.warn(
        `Failed to publish realtime event ${notification.eventType}: ${(err as Error).message}`,
      );
    }
  }
}
