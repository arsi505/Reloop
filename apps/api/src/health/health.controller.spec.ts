import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

describe('HealthController', () => {
  let healthController: HealthController;

  const mockPrismaService = {
    checkHealth: jest.fn().mockResolvedValue({ status: 'ok', latencyMs: 2 }),
  };

  const mockRedisService = {
    checkHealth: jest.fn().mockResolvedValue({ status: 'ok', latencyMs: 1 }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    healthController = module.get<HealthController>(HealthController);
  });

  it('should return ok when both database and redis are healthy', async () => {
    const result = await healthController.getHealth();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('api');
    expect(result.components.database.status).toBe('ok');
    expect(result.components.redis.status).toBe('ok');
  });

  it('should return degraded when one component fails', async () => {
    mockRedisService.checkHealth.mockResolvedValueOnce({
      status: 'down',
      latencyMs: 10,
      error: 'Connection refused',
    });

    const result = await healthController.getHealth();
    expect(result.status).toBe('degraded');
    expect(result.components.database.status).toBe('ok');
    expect(result.components.redis.status).toBe('down');
  });
});
