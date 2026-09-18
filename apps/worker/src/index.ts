import { PrismaClient } from '@prisma/client';
import { loadWorkerConfig } from './config';
import { WorkerService } from './worker-service';

export * from './config';
export * from './errors';
export * from './executor';
export * from './heartbeat';
export * from './inspect';
export * from './job-claim';
export * from './lease-manager';
export * from './retry-policy';
export * from './stale-message-recovery';
export * from './workflow-step-registry';
export * from './workflow-step-executor';
export * from './worker-service';

async function bootstrap() {
  const config = loadWorkerConfig();
  console.log(`[Reloop Worker] Initializing worker instance: ${config.workerKey} (${config.workerConsumerName})`);
  console.log(
    `[Reloop Worker] Configuration: Redis=${config.redisUrl}, Stream=${config.jobStreamKey}, Group=${config.jobConsumerGroup}, Concurrency=${config.workerConcurrency}, Lease=${config.jobLeaseDurationMs}ms, RenewInterval=${config.jobLeaseRenewIntervalMs}ms`,
  );

  const prisma = new PrismaClient();
  const workerService = new WorkerService(config, prisma);

  const shutdown = async (signal: string) => {
    console.log(`[Reloop Worker] Received ${signal}. Initiating graceful shutdown...`);
    await workerService.stop();
    await prisma.$disconnect();
    console.log('[Reloop Worker] Graceful shutdown complete. Exiting.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await workerService.start();
    console.log('[Reloop Worker] Worker engine running actively.');
  } catch (err) {
    console.error('[Reloop Worker] Fatal error starting worker:', err);
    await workerService.stop().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrap();
}
