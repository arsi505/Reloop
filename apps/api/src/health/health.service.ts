import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ServiceHealth } from '@reloop/contracts';

@Injectable()
export class HealthService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  async check(): Promise<ServiceHealth> {
    const dbResult = await this.prismaService.checkHealth();
    const redisResult = await this.redisService.checkHealth();

    let overallStatus: 'ok' | 'degraded' | 'down' = 'ok';
    if (dbResult.status !== 'ok' && redisResult.status !== 'ok') {
      overallStatus = 'down';
    } else if (dbResult.status !== 'ok' || redisResult.status !== 'ok') {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      service: 'api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      components: {
        database: {
          status: dbResult.status,
          latencyMs: dbResult.latencyMs,
          message: dbResult.error,
        },
        redis: {
          status: redisResult.status,
          latencyMs: redisResult.latencyMs,
          message: redisResult.error,
        },
      },
    };
  }
}
