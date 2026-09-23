import Redis from 'ioredis';
import { PrismaClient, JobStatus } from '@prisma/client';
import { performance } from 'perf_hooks';
import { loadWorkerConfig } from '../../apps/worker/src/config';
import { WorkerService } from '../../apps/worker/src/worker-service';
import { JobExecutorRegistry } from '../../apps/worker/src/executor';

const dbUrl =
  process.env.RELOOP_TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://reloop@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

export interface ThroughputResult {
  workersCount: number;
  workerPoolConcurrency: number;
  jobsCount: number;
  scheduleRate: number;
  claimRate: number;
  completionRate: number;
  duplicateClaims: number;
  leaseConflicts: number;
  failedJobs: number;
  blockedJobs: number;
  elapsedSec: number;
}

async function main() {
  console.log('===============================================================');
  console.log('  RELOOP DAY 21: JOB THROUGHPUT & CONCURRENCY BENCHMARK         ');
  console.log('===============================================================\n');

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await prisma.$connect();
  const redis = new Redis(redisUrl);

  const runId = Math.random().toString(36).substring(2, 8);
  const streamKey = `reloop:bench:${runId}:jobs:ready`;
  const consumerGroup = `bench-group-${runId}`;

  // 1. Setup Redis stream and consumer group
  await redis.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM').catch(() => {});

  // 2. Setup benchmark organization
  const org = await prisma.organization.create({
    data: {
      name: `Throughput Benchmark Org ${runId}`,
      slug: `throughput-bench-org-${runId}`,
    },
  });

  console.log(`[Throughput Benchmark] Test Org ID: ${org.id}`);
  console.log(`[Throughput Benchmark] Stream Key: ${streamKey} | Group: ${consumerGroup}\n`);

  // Section 1: Scheduler & Ingestion Pipeline (Measure jobs scheduled/sec)
  const scheduledCount = 500;
  console.log(`--- 1. Measuring Scheduling Pipeline Throughput (${scheduledCount} jobs) ---`);
  const tSchedStart = performance.now();

  const jobsData = Array.from({ length: scheduledCount }, (_, i) => ({
    organizationId: org.id,
    type: 'BENCHMARK_JOB',
    status: JobStatus.QUEUED,
    payload: { jobIndex: i, runId },
    idempotencyKey: `bench-${runId}-${i}`,
  }));

  // Batch insert into PostgreSQL
  await prisma.job.createMany({
    data: jobsData,
  });

  const createdJobs = await prisma.job.findMany({
    where: { organizationId: org.id, type: 'BENCHMARK_JOB' },
    select: { id: true },
  });

  // Publish in pipeline to Redis Stream
  const pipeline = redis.pipeline();
  for (const job of createdJobs) {
    pipeline.xadd(streamKey, '*', 'jobId', job.id, 'orgId', org.id);
  }
  await pipeline.exec();

  const tSchedEnd = performance.now();
  const schedTimeSec = (tSchedEnd - tSchedStart) / 1000;
  const jobsScheduledPerSec = Number((scheduledCount / schedTimeSec).toFixed(1));
  console.log(`  -> Scheduled & Enqueued: ${scheduledCount} jobs in ${schedTimeSec.toFixed(2)}s (${jobsScheduledPerSec} jobs scheduled/sec)\n`);

  // Section 2: Concurrency Stress Test with 3 Workers (Concurrency = 3 x 10 = 30)
  console.log('--- 2. Concurrency Benchmark with 3 Workers (Concurrency 3 x 10 = 30) ---');
  let duplicateExecutionCount = 0;
  const executedJobIds = new Set<string>();

  const executorRegistry = new JobExecutorRegistry();
  executorRegistry.register('BENCHMARK_JOB', async (ctx) => {
    if (executedJobIds.has(ctx.jobId)) {
      duplicateExecutionCount++;
    } else {
      executedJobIds.add(ctx.jobId);
    }
    // Simulate lightweight deterministic work
    return { success: true };
  });

  const baseConfig = loadWorkerConfig();
  const workerConfig3 = {
    ...baseConfig,
    redisUrl,
    jobStreamKey: streamKey,
    jobConsumerGroup: consumerGroup,
    workerConcurrency: 10,
    jobLeaseDurationMs: 15000,
    jobLeaseRenewIntervalMs: 5000,
  };

  const workers3: WorkerService[] = [];
  for (let w = 1; w <= 3; w++) {
    const worker = new WorkerService(
      loadWorkerConfig({
        ...workerConfig3,
        workerKey: `worker-bench-3-${w}-${runId}`,
        workerConsumerName: `consumer-bench-3-${w}-${runId}`,
      }),
      prisma,
      { executorRegistry },
    );
    workers3.push(worker);
  }

  const tClaimStart = performance.now();
  await Promise.all(workers3.map((w) => w.start()));

  // Wait until all 500 jobs reach SUCCEEDED
  let completedCount = 0;
  const timeoutMs = 30000;
  const pollStart = Date.now();
  while (Date.now() - pollStart < timeoutMs) {
    completedCount = await prisma.job.count({
      where: { organizationId: org.id, type: 'BENCHMARK_JOB', status: JobStatus.SUCCEEDED },
    });
    if (completedCount >= scheduledCount) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const tClaimEnd = performance.now();
  const executionTimeSec = (tClaimEnd - tClaimStart) / 1000;
  const jobsCompletedPerSec = Number((completedCount / (executionTimeSec || 0.001)).toFixed(1));

  // Stop 3 workers cleanly
  await Promise.all(workers3.map((w) => w.stop()));

  console.log(`  -> Completed: ${completedCount}/${scheduledCount} jobs in ${executionTimeSec.toFixed(2)}s`);
  console.log(`  -> Measured Completion Throughput (3 workers): ${jobsCompletedPerSec} jobs completed/sec`);
  console.log(`  -> Duplicate Business Effects: ${duplicateExecutionCount}\n`);

  // Section 3: High Concurrency Benchmark with 5 Workers (Concurrency = 5 x 10 = 50+)
  console.log('--- 3. Concurrency Benchmark with 5 Workers (Concurrency 5 x 10 = 50 concurrent jobs) ---');
  const streamKey5 = `reloop:bench5:${runId}:jobs:ready`;
  const consumerGroup5 = `bench5-group-${runId}`;
  await redis.xgroup('CREATE', streamKey5, consumerGroup5, '$', 'MKSTREAM').catch(() => {});

  const jobsData5 = Array.from({ length: 500 }, (_, i) => ({
    organizationId: org.id,
    type: 'BENCHMARK_JOB_5',
    status: JobStatus.QUEUED,
    payload: { jobIndex: i, runId },
    idempotencyKey: `bench5-${runId}-${i}`,
  }));

  await prisma.job.createMany({ data: jobsData5 });
  const createdJobs5 = await prisma.job.findMany({
    where: { organizationId: org.id, type: 'BENCHMARK_JOB_5' },
    select: { id: true },
  });

  const pipeline5 = redis.pipeline();
  for (const job of createdJobs5) {
    pipeline5.xadd(streamKey5, '*', 'jobId', job.id, 'orgId', org.id);
  }
  await pipeline5.exec();

  const executorRegistry5 = new JobExecutorRegistry();
  let duplicateExecutionCount5 = 0;
  const executedJobIds5 = new Set<string>();

  executorRegistry5.register('BENCHMARK_JOB_5', async (ctx) => {
    if (executedJobIds5.has(ctx.jobId)) {
      duplicateExecutionCount5++;
    } else {
      executedJobIds5.add(ctx.jobId);
    }
    return { success: true };
  });

  const workers5: WorkerService[] = [];
  for (let w = 1; w <= 5; w++) {
    const worker = new WorkerService(
      loadWorkerConfig({
        ...baseConfig,
        redisUrl,
        jobStreamKey: streamKey5,
        jobConsumerGroup: consumerGroup5,
        workerConcurrency: 10,
        jobLeaseDurationMs: 15000,
        jobLeaseRenewIntervalMs: 5000,
        workerKey: `worker-bench-5-${w}-${runId}`,
        workerConsumerName: `consumer-bench-5-${w}-${runId}`,
      }),
      prisma,
      { executorRegistry: executorRegistry5 },
    );
    workers5.push(worker);
  }

  const tStart5 = performance.now();
  await Promise.all(workers5.map((w) => w.start()));

  let completedCount5 = 0;
  const pollStart5 = Date.now();
  while (Date.now() - pollStart5 < timeoutMs) {
    completedCount5 = await prisma.job.count({
      where: { organizationId: org.id, type: 'BENCHMARK_JOB_5', status: JobStatus.SUCCEEDED },
    });
    if (completedCount5 >= 500) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const executionTimeSec5 = (performance.now() - tStart5) / 1000;
  const jobsCompletedPerSec5 = Number((completedCount5 / (executionTimeSec5 || 0.001)).toFixed(1));

  await Promise.all(workers5.map((w) => w.stop()));

  console.log(`  -> Completed: ${completedCount5}/500 jobs in ${executionTimeSec5.toFixed(2)}s`);
  console.log(`  -> Measured Completion Throughput (5 workers, 50 concurrency): ${jobsCompletedPerSec5} jobs completed/sec`);
  console.log(`  -> Duplicate Business Effects: ${duplicateExecutionCount5}\n`);

  // Section 4: Bounded High-Volume Workload (10,000 jobs stress test)
  console.log('--- 4. Bounded High-Volume Stress Workload (10,000 jobs) ---');
  const streamKey10k = `reloop:bench10k:${runId}:jobs:ready`;
  const consumerGroup10k = `bench10k-group-${runId}`;
  await redis.xgroup('CREATE', streamKey10k, consumerGroup10k, '$', 'MKSTREAM').catch(() => {});

  const total10kJobs = 10000;
  console.log(`  [10k Test] Generating and batch-inserting ${total10kJobs} synthetic jobs...`);
  const tStart10k = performance.now();

  const batchSize = 500;
  for (let b = 0; b < total10kJobs; b += batchSize) {
    const chunk = Array.from({ length: batchSize }, (_, idx) => ({
      organizationId: org.id,
      type: 'BENCHMARK_JOB_10K',
      status: JobStatus.QUEUED,
      payload: { index: b + idx, runId },
      idempotencyKey: `bench10k-${runId}-${b + idx}`,
    }));
    await prisma.job.createMany({ data: chunk });
  }

  const all10kJobs = await prisma.job.findMany({
    where: { organizationId: org.id, type: 'BENCHMARK_JOB_10K' },
    select: { id: true },
  });

  const pipeline10k = redis.pipeline();
  for (const job of all10kJobs) {
    pipeline10k.xadd(streamKey10k, '*', 'jobId', job.id, 'orgId', org.id);
  }
  await pipeline10k.exec();

  const executorRegistry10k = new JobExecutorRegistry();
  let duplicateExecution10k = 0;
  const executed10k = new Set<string>();

  executorRegistry10k.register('BENCHMARK_JOB_10K', async (ctx) => {
    if (executed10k.has(ctx.jobId)) {
      duplicateExecution10k++;
    } else {
      executed10k.add(ctx.jobId);
    }
    return { success: true };
  });

  // Run with 5 workers, 10 concurrency each (50 concurrent consumers)
  const workers10k: WorkerService[] = [];
  for (let w = 1; w <= 5; w++) {
    const worker = new WorkerService(
      loadWorkerConfig({
        ...baseConfig,
        redisUrl,
        jobStreamKey: streamKey10k,
        jobConsumerGroup: consumerGroup10k,
        workerConcurrency: 10,
        jobLeaseDurationMs: 15000,
        jobLeaseRenewIntervalMs: 5000,
        workerKey: `worker-10k-${w}-${runId}`,
        workerConsumerName: `consumer-10k-${w}-${runId}`,
      }),
      prisma,
      { executorRegistry: executorRegistry10k },
    );
    workers10k.push(worker);
  }

  await Promise.all(workers10k.map((w) => w.start()));

  let completed10k = 0;
  const maxWaitMs = 120000;
  const poll10k = Date.now();
  while (Date.now() - poll10k < maxWaitMs) {
    completed10k = await prisma.job.count({
      where: { organizationId: org.id, type: 'BENCHMARK_JOB_10K', status: JobStatus.SUCCEEDED },
    });
    if (completed10k >= total10kJobs) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const elapsed10kSec = Number(((performance.now() - tStart10k) / 1000).toFixed(2));
  const rate10k = Number((completed10k / elapsed10kSec).toFixed(1));

  await Promise.all(workers10k.map((w) => w.stop()));

  const remaining10k = await prisma.job.count({
    where: { organizationId: org.id, type: 'BENCHMARK_JOB_10K', status: { not: JobStatus.SUCCEEDED } },
  });
  const deadLettered10k = await prisma.job.count({
    where: { organizationId: org.id, type: 'BENCHMARK_JOB_10K', status: JobStatus.DEAD_LETTERED },
  });
  const blocked10k = await prisma.job.count({
    where: { organizationId: org.id, type: 'BENCHMARK_JOB_10K', status: JobStatus.BLOCKED },
  });

  console.log(`  [10k Test] Jobs Created: ${total10kJobs}`);
  console.log(`  [10k Test] Jobs Completed: ${completed10k}`);
  console.log(`  [10k Test] Jobs Remaining: ${remaining10k}`);
  console.log(`  [10k Test] Jobs Dead-Lettered: ${deadLettered10k}`);
  console.log(`  [10k Test] Jobs Blocked: ${blocked10k}`);
  console.log(`  [10k Test] Duplicate Business Effects: ${duplicateExecution10k}`);
  console.log(`  [10k Test] Elapsed Time: ${elapsed10kSec}s (${rate10k} jobs/sec overall)\n`);

  console.log('===============================================================');
  console.log('  JOB THROUGHPUT & CONCURRENCY BENCHMARK SUMMARY               ');
  console.log('===============================================================');
  console.log(`Scheduled Rate:           ${jobsScheduledPerSec} jobs/sec`);
  console.log(`Claimed & Completed (3w): ${jobsCompletedPerSec} jobs/sec`);
  console.log(`Claimed & Completed (5w): ${jobsCompletedPerSec5} jobs/sec`);
  console.log(`Peak 50 Concurrency Rate: ${jobsCompletedPerSec5} jobs/sec`);
  console.log(`High-Volume Batch (2.5k): ${rate10k} jobs/sec (Total: ${completed10k}/${total10kJobs})`);
  console.log(`Duplicate Business Mutation Count: ${duplicateExecutionCount + duplicateExecutionCount5 + duplicateExecution10k} (MUST BE 0)`);

  await redis.quit();
  await prisma.$disconnect();
  console.log('\n[Throughput Benchmark] All workers cleanly stopped and resources disconnected.');
}

main().catch((err) => {
  console.error('[Throughput Benchmark] Error running benchmark:', err);
  process.exit(1);
});
