import { createSchedulerRuntime } from './runtime';

export * from './config';
export * from './redis-publisher';
export * from './job-scanner';
export * from './scheduler-service';
export * from './workflow-coordinator';
export * from './workflow-creator';
export * from './recovery-router-scanner';
export * from './reconciliation-scanner';
export * from './simulator-snapshot-provider';
export * from './runtime';

async function bootstrap() {
  const runtime = createSchedulerRuntime();
  const config = runtime.config;
  console.log(`[Reloop Scheduler] Initializing scheduler instance: ${config.instanceId}`);
  console.log(`[Reloop Scheduler] Configuration: Redis=${config.redisUrl}, Stream=${config.jobStreamKey}, Group=${config.jobConsumerGroup}, Interval=${config.schedulerIntervalMs}ms, Batch=${config.schedulerBatchSize}, MarkerTTL=${config.dispatchMarkerTtlMs}ms`);

  const shutdown = async (signal: string) => {
    console.log(`[Reloop Scheduler] Received ${signal}. Initiating graceful shutdown...`);
    await runtime.stop();
    console.log('[Reloop Scheduler] Graceful shutdown complete. Exiting.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await runtime.start();
    console.log('[Reloop Scheduler] Scheduler is running actively.');
  } catch (err) {
    console.error('[Reloop Scheduler] Fatal error starting scheduler:', err);
    await runtime.stop().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrap();
}
