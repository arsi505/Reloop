import { PrismaClient } from '@prisma/client';
import { loadSchedulerConfig } from './config';
import { RedisPublisher } from './redis-publisher';
import { SchedulerService } from './scheduler-service';

export * from './config';
export * from './redis-publisher';
export * from './job-scanner';
export * from './scheduler-service';

async function bootstrap() {
  const config = loadSchedulerConfig();
  console.log(`[Reloop Scheduler] Initializing scheduler instance: ${config.instanceId}`);
  console.log(`[Reloop Scheduler] Configuration: Redis=${config.redisUrl}, Stream=${config.jobStreamKey}, Group=${config.jobConsumerGroup}, Interval=${config.schedulerIntervalMs}ms, Batch=${config.schedulerBatchSize}, MarkerTTL=${config.dispatchMarkerTtlMs}ms`);

  const prisma = new PrismaClient();
  const publisher = new RedisPublisher(config);
  const scheduler = new SchedulerService(config, prisma, publisher);

  const shutdown = async (signal: string) => {
    console.log(`[Reloop Scheduler] Received ${signal}. Initiating graceful shutdown...`);
    await scheduler.stop();
    await prisma.$disconnect();
    console.log('[Reloop Scheduler] Graceful shutdown complete. Exiting.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await scheduler.start();
    console.log('[Reloop Scheduler] Scheduler is running actively.');
  } catch (err) {
    console.error('[Reloop Scheduler] Fatal error starting scheduler:', err);
    await scheduler.stop().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrap();
}
