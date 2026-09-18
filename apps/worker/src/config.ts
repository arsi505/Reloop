import * as dotenv from 'dotenv';
import * as os from 'os';

dotenv.config();

export interface WorkerConfig {
  redisUrl: string;
  databaseUrl?: string;
  jobStreamKey: string;
  jobConsumerGroup: string;
  workerConsumerName: string;
  workerKey: string;
  workerConcurrency: number;
  workerHeartbeatIntervalMs: number;
  jobLeaseDurationMs: number;
  jobLeaseRenewIntervalMs: number;
  workerShutdownTimeoutMs: number;
  blockTimeoutMs: number;
  jobRetryDelaysMs: number[];
  jobRetryJitterPercent: number;
}

export function loadWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const redisUrl = overrides.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6380';
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL;
  const jobStreamKey = overrides.jobStreamKey ?? process.env.JOB_STREAM_KEY ?? 'reloop:jobs:ready';
  const jobConsumerGroup = overrides.jobConsumerGroup ?? process.env.JOB_CONSUMER_GROUP ?? 'recovery-workers';

  const randomSuffix = Math.random().toString(36).substring(2, 9);
  const hostname = os.hostname();
  const pid = process.pid;

  const defaultIdentity = `worker-${hostname}-${pid}-${randomSuffix}`;
  const workerConsumerName = overrides.workerConsumerName ?? process.env.WORKER_CONSUMER_NAME ?? defaultIdentity;
  const workerKey = overrides.workerKey ?? process.env.WORKER_KEY ?? defaultIdentity;

  const rawConcurrency = overrides.workerConcurrency ?? (process.env.WORKER_CONCURRENCY ? parseInt(process.env.WORKER_CONCURRENCY, 10) : 5);
  const workerConcurrency = Number.isFinite(rawConcurrency) ? rawConcurrency : 5;

  const rawHeartbeat = overrides.workerHeartbeatIntervalMs ?? (process.env.WORKER_HEARTBEAT_INTERVAL_MS ? parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 10) : 5000);
  const workerHeartbeatIntervalMs = Number.isFinite(rawHeartbeat) ? rawHeartbeat : 5000;

  const rawLeaseDuration = overrides.jobLeaseDurationMs ?? (process.env.JOB_LEASE_DURATION_MS ? parseInt(process.env.JOB_LEASE_DURATION_MS, 10) : 15000);
  const jobLeaseDurationMs = Number.isFinite(rawLeaseDuration) ? rawLeaseDuration : 15000;

  const rawLeaseRenew = overrides.jobLeaseRenewIntervalMs ?? (process.env.JOB_LEASE_RENEW_INTERVAL_MS ? parseInt(process.env.JOB_LEASE_RENEW_INTERVAL_MS, 10) : 5000);
  const jobLeaseRenewIntervalMs = Number.isFinite(rawLeaseRenew) ? rawLeaseRenew : 5000;

  const rawShutdownTimeout = overrides.workerShutdownTimeoutMs ?? (process.env.WORKER_SHUTDOWN_TIMEOUT_MS ? parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS, 10) : 30000);
  const workerShutdownTimeoutMs = Number.isFinite(rawShutdownTimeout) ? rawShutdownTimeout : 30000;

  const rawBlockTimeout = overrides.blockTimeoutMs ?? (process.env.WORKER_BLOCK_TIMEOUT_MS ? parseInt(process.env.WORKER_BLOCK_TIMEOUT_MS, 10) : 1500);
  const blockTimeoutMs = Number.isFinite(rawBlockTimeout) ? rawBlockTimeout : 1500;

  let jobRetryDelaysMs = overrides.jobRetryDelaysMs;
  if (!jobRetryDelaysMs) {
    const rawDelays = process.env.JOB_RETRY_DELAYS_MS;
    if (rawDelays) {
      jobRetryDelaysMs = rawDelays
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    if (!jobRetryDelaysMs || jobRetryDelaysMs.length === 0) {
      jobRetryDelaysMs = [30000, 120000, 600000, 1800000];
    }
  }

  const rawJitter = overrides.jobRetryJitterPercent ?? (process.env.JOB_RETRY_JITTER_PERCENT ? parseInt(process.env.JOB_RETRY_JITTER_PERCENT, 10) : 15);
  const jobRetryJitterPercent = Number.isFinite(rawJitter) ? rawJitter : 15;

  // Validation
  if (workerConcurrency <= 0) {
    throw new Error('Invalid configuration: workerConcurrency must be greater than 0');
  }
  if (jobLeaseDurationMs <= 0) {
    throw new Error('Invalid configuration: jobLeaseDurationMs must be greater than 0');
  }
  if (jobLeaseRenewIntervalMs <= 0) {
    throw new Error('Invalid configuration: jobLeaseRenewIntervalMs must be greater than 0');
  }
  if (jobLeaseRenewIntervalMs >= jobLeaseDurationMs) {
    throw new Error(
      `Unsafe lease configuration: renewal interval (${jobLeaseRenewIntervalMs}ms) must be strictly less than lease duration (${jobLeaseDurationMs}ms)`,
    );
  }
  if (workerHeartbeatIntervalMs <= 0) {
    throw new Error('Invalid configuration: workerHeartbeatIntervalMs must be greater than 0');
  }
  if (workerShutdownTimeoutMs <= 0) {
    throw new Error('Invalid configuration: workerShutdownTimeoutMs must be greater than 0');
  }
  if (blockTimeoutMs <= 0) {
    throw new Error('Invalid configuration: blockTimeoutMs must be greater than 0');
  }
  if (!jobRetryDelaysMs || jobRetryDelaysMs.length === 0) {
    throw new Error('Invalid configuration: jobRetryDelaysMs must contain at least one positive delay');
  }
  for (const d of jobRetryDelaysMs) {
    if (d <= 0) {
      throw new Error('Invalid configuration: all jobRetryDelaysMs must be greater than 0');
    }
  }
  if (jobRetryJitterPercent < 0 || jobRetryJitterPercent > 100) {
    throw new Error('Invalid configuration: jobRetryJitterPercent must be between 0 and 100');
  }

  return {
    redisUrl,
    databaseUrl,
    jobStreamKey,
    jobConsumerGroup,
    workerConsumerName,
    workerKey,
    workerConcurrency,
    workerHeartbeatIntervalMs,
    jobLeaseDurationMs,
    jobLeaseRenewIntervalMs,
    workerShutdownTimeoutMs,
    blockTimeoutMs,
    jobRetryDelaysMs,
    jobRetryJitterPercent,
  };
}