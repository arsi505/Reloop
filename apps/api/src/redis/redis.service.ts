import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const redisUrl = this.configService.get<string>('redisUrl') || 'redis://localhost:6380';
    try {
      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 3000,
        lazyConnect: true,
      });
      await this.client.connect();
      this.logger.log(`Successfully connected to Redis at ${redisUrl}`);
    } catch (error) {
      this.logger.warn(`Could not connect to Redis on startup: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit().catch(() => {});
      this.logger.log('Redis client disconnected');
    }
  }

  getClient(): Redis | null {
    return this.client;
  }

  async checkHealth(): Promise<{ status: 'ok' | 'down'; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      if (!this.client || this.client.status !== 'ready') {
        const redisUrl = this.configService.get<string>('redisUrl') || 'redis://localhost:6380';
        this.client = new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          connectTimeout: 2000,
          lazyConnect: true,
        });
        await this.client.connect();
      }
      const response = await this.client.ping();
      if (response !== 'PONG') {
        throw new Error(`Unexpected ping response: ${response}`);
      }
      return {
        status: 'ok',
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Date.now() - start,
        error: (error as Error).message,
      };
    }
  }
}
