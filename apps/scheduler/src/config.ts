import * as dotenv from 'dotenv';

dotenv.config();

export interface SchedulerConfig {
  redisUrl: string;
  simulatorBaseUrl: string;
  databaseUrl?: string;
  jobStreamKey: string;
  jobConsumerGroup: string;
  schedulerIntervalMs: number;
  schedulerBatchSize: number;
  dispatchMarkerTtlMs: number;
  instanceId: string;
  workflowScanIntervalMs: number;
  workflowScanBatchSize: number;
  reconciliationScanIntervalMs: number;
  reconciliationScanBatchSize: number;
  recoveryRouterScanIntervalMs: number;
  recoveryRouterBatchSize: number;
}

export function loadSchedulerConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  const redisUrl = overrides.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6380';
  const simulatorBaseUrl =
    overrides.simulatorBaseUrl ??
    process.env.SIMULATOR_BASE_URL ??
    'http://localhost:3102';
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

  const rawReconcileInterval = overrides.reconciliationScanIntervalMs ?? (process.env.RECONCILIATION_SCAN_INTERVAL_MS ? parseInt(process.env.RECONCILIATION_SCAN_INTERVAL_MS, 10) : 5000);
  const reconciliationScanIntervalMs = Number.isFinite(rawReconcileInterval) && rawReconcileInterval > 0 ? rawReconcileInterval : 5000;

  const rawReconcileBatchSize = overrides.reconciliationScanBatchSize ?? (process.env.RECONCILIATION_SCAN_BATCH_SIZE ? parseInt(process.env.RECONCILIATION_SCAN_BATCH_SIZE, 10) : 50);
  const reconciliationScanBatchSize = Number.isFinite(rawReconcileBatchSize) && rawReconcileBatchSize > 0 ? rawReconcileBatchSize : 50;

  const rawRouterInterval = overrides.recoveryRouterScanIntervalMs ?? (process.env.RECOVERY_ROUTER_SCAN_INTERVAL_MS ? parseInt(process.env.RECOVERY_ROUTER_SCAN_INTERVAL_MS, 10) : 2000);
  const recoveryRouterScanIntervalMs = Number.isFinite(rawRouterInterval) && rawRouterInterval > 0 ? rawRouterInterval : 2000;

  const rawRouterBatchSize = overrides.recoveryRouterBatchSize ?? (process.env.RECOVERY_ROUTER_BATCH_SIZE ? parseInt(process.env.RECOVERY_ROUTER_BATCH_SIZE, 10) : 50);
  const recoveryRouterBatchSize = Number.isFinite(rawRouterBatchSize) && rawRouterBatchSize > 0 ? rawRouterBatchSize : 50;

  const instanceId = overrides.instanceId ?? ('scheduler-' + process.pid + '-' + Math.random().toString(36).substring(2, 9));

  return {
    redisUrl,
    simulatorBaseUrl,
    databaseUrl,
    jobStreamKey,
    jobConsumerGroup,
    schedulerIntervalMs,
    schedulerBatchSize,
    dispatchMarkerTtlMs,
    workflowScanIntervalMs,
    workflowScanBatchSize,
    reconciliationScanIntervalMs,
    reconciliationScanBatchSize,
    recoveryRouterScanIntervalMs,
    recoveryRouterBatchSize,
    instanceId,
  };
}
