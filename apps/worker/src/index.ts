import { createWorkerRuntime } from './runtime';

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
export * from './recovery-step-handlers';
export * from './shopify-sync-executor';
export * from './worker-service';
export * from './runtime';

async function bootstrap() {
  const runtime = createWorkerRuntime();
  const config = runtime.config;
  console.log(`[Reloop Worker] Initializing worker instance: ${config.workerKey} (${config.workerConsumerName})`);
  console.log(
    `[Reloop Worker] Configuration: Redis=${config.redisUrl}, Stream=${config.jobStreamKey}, Group=${config.jobConsumerGroup}, Concurrency=${config.workerConcurrency}, Lease=${config.jobLeaseDurationMs}ms, RenewInterval=${config.jobLeaseRenewIntervalMs}ms`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[Reloop Worker] Received ${signal}. Initiating graceful shutdown...`);
    await runtime.stop();
    console.log('[Reloop Worker] Graceful shutdown complete. Exiting.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await runtime.start();
    console.log('[Reloop Worker] Worker engine running actively.');
  } catch (err) {
    console.error('[Reloop Worker] Fatal error starting worker:', err);
    await runtime.stop().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrap();
}
