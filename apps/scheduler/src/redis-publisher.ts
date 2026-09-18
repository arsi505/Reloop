import Redis from 'ioredis';
import { SchedulerConfig } from './config';

export const DISPATCH_LUA_SCRIPT = `
local markerAcquired = redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1])
if markerAcquired then
  redis.call('XADD', KEYS[2], '*', 'jobId', ARGV[2])
  return 1
else
  return 0
end
`;

export class RedisPublisher {
  private redis: Redis;
  private config: SchedulerConfig;
  private isConnected: boolean = false;

  constructor(config: SchedulerConfig, redisInstance?: Redis) {
    this.config = config;
    this.redis = redisInstance ?? new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
    });
  }

  async connect(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
    this.isConnected = true;
  }

  async ensureConsumerGroup(): Promise<void> {
    try {
      // XGROUP CREATE <stream> <group> $ MKSTREAM
      await this.redis.xgroup(
        'CREATE',
        this.config.jobStreamKey,
        this.config.jobConsumerGroup,
        '$',
        'MKSTREAM',
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('BUSYGROUP')) {
        // Consumer group already exists - expected on normal startup
        return;
      }
      if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string' && ((err as { message: string }).message).includes('BUSYGROUP')) {
        return;
      }
      throw err;
    }
  }

  async publishJob(jobId: string): Promise<boolean> {
    const markerKey = `reloop:dispatch:${jobId}`;
    const result = await this.redis.eval(
      DISPATCH_LUA_SCRIPT,
      2,
      markerKey,
      this.config.jobStreamKey,
      this.config.dispatchMarkerTtlMs.toString(),
      jobId,
    );

    return result === 1;
  }

  async close(): Promise<void> {
    if (this.redis.status !== 'end') {
      try {
        await this.redis.quit();
      } catch {
        this.redis.disconnect();
      }
    }
    this.isConnected = false;
  }

  getRedis(): Redis {
    return this.redis;
  }
}