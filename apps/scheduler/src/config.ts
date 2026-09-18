import * as dotenv from 'dotenv';

dotenv.config();

export interface SchedulerConfig {
  redisUrl: string;
  databaseUrl?: string;
  jobStreamKey: string;
  jobConsumerGroup: string;
  schedulerIntervalMs: number;
  schedulerBatchSize: number;
  dispatchMarkerTtlMs: number;
  instanceId: string;
  workflowScanIntervalMs: number;
  workflowScanBatchSize: number;
}

export function loadSchedulerConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  const redisUrl = overrides.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6380';
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL;
  const jobStreamKey = overrides.jobStreamKey ?? process.env.JOB_STREAM_KEY ?? 'reloop:jobs:ready';
  const jobConsumerGroup = overrides.jobConsumerGroup ?? process.env.JOB_CONSUMER_GROUP ?? 'recovery-workers';

  const rawInterval = overrides.schedulerIntervalMs ?? (process.env.SCHEDULER_INTERVAL_MS ? parseInt(process.env.SCHEDULER_INTERVAL_MS, 10) : 1000);
  const schedulerIntervalMs = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 1000;

  const rawBatchSize = overrides.schedulerBatchSize ?? (process.env.SCHEDULER_BATCH_SIZE ? parseInt(process.env.SCHEDULER_BATCH_SIZE, 10) : 50);
  const schedulerBatchSize = Number.isFinite(rawBatchSize) && rawBatchSize > 0 ? rawBatchSize : 50;

  const rawTtl = overrides.dispatchMarkerTtlMs ?? (process.env.DISPATCH_MARKER_TTL_MS ? parseInt(process.env.DISPATCH_MARKER_TTL_MS, 10) : 30000);
  const dispatchMarkerTtlMs = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 30000;

  const rawWorkflowInterval = overrides.workflowScanIntervalMs ?? (process.env.WORKFLOW_SCAN_INTERVAL_MS ? parseInt(process.env.WORKFLOW_SCAN_INTERVAL_MS, 10) : 1000);
  const workflowScanIntervalMs = Number.isFinite(rawWorkflowInterval) && rawWorkflowInterval > 0 ? rawWorkflowInterval : 1000;

  const rawWorkflowBatchSize = overrides.workflowScanBatchSize ?? (process.env.WORKFLOW_SCAN_BATCH_SIZE ? parseInt(process.env.WORKFLOW_SCAN_BATCH_SIZE, 10) : 20);
  const workflowScanBatchSize = Number.isFinite(rawWorkflowBatchSize) && rawWorkflowBatchSize > 0 ? rawWorkflowBatchSize : 20;

  const instanceId = overrides.instanceId ?? ('scheduler-' + process.pid + '-' + Math.random().toString(36).substring(2, 9));

  return {
    redisUrl,
    databaseUrl,
    jobStreamKey,
    jobConsumerGroup,
    schedulerIntervalMs,
    schedulerBatchSize,
    dispatchMarkerTtlMs,
    workflowScanIntervalMs,
    workflowScanBatchSize,
    instanceId,
  };
}
