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

export interface Run10kResult {
  runNumber: number;
  jobsCreated: number;
  jobsCompleted: number;
  elapsedSec: number;
  completedJobsPerSec: number;
  duplicateBusinessEffects: number;
  blocked: number;
  deadLettered: number;
  unfinished: number;
}

async function runSingle10k(
  prisma: PrismaClient,
  redis: Redis,
  orgId: string,
  runNumber: number,
  baseRunId: string,
): Promise<Run10kResult> {
  const runId = `${baseRunId}_r${runNumber}`;
  const streamKey = `reloop:bench10k:${runId}:ready`;
  const consumerGroup = `bench10k-group-${runId}`;
  await redis.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM').catch(() => {});

  const total10kJobs = 10000;
  console.log(`\n--- [10k Run #${runNumber}] Staging ${total10kJobs} synthetic jobs ---`);

  const batchSize = 500;
  for (let b = 0; b < total10kJobs; b += batchSize) {
    const chunk = Array.from({ length: batchSize }, (_, idx) => ({
      organizationId: orgId,
      type: `BENCHMARK_10K_R${runNumber}`,
      status: JobStatus.QUEUED,
      payload: { index: b + idx, runNumber, runId },
      idempotencyKey: `bench10k-${runId}-${b + idx}`,
    }));
    await prisma.job.createMany({ data: chunk });
  }

  const allJobs = await prisma.job.findMany({
    where: { organizationId: orgId, type: `BENCHMARK_10K_R${runNumber}` },
    select: { id: true },
  });

  const pipeline = redis.pipeline();
  for (const job of allJobs) {
    pipeline.xadd(streamKey, '*', 'jobId', job.id, 'orgId', orgId);
  }
  await pipeline.exec();

  const executorRegistry = new JobExecutorRegistry();
  let duplicateExecutions = 0;
  const executedJobIds = new Set<string>();

  executorRegistry.register(`BENCHMARK_10K_R${runNumber}`, async (ctx) => {
    if (executedJobIds.has(ctx.jobId)) {
      duplicateExecutions++;
    } else {
      executedJobIds.add(ctx.jobId);
    }
    return { success: true };
  });

  // 5 Workers x 10 Concurrency = 50 concurrent consumers
  const baseConfig = loadWorkerConfig();
  const workers: WorkerService[] = [];
  for (let w = 1; w <= 5; w++) {
    const worker = new WorkerService(
      loadWorkerConfig({
        ...baseConfig,
        redisUrl,
        jobStreamKey: streamKey,
        jobConsumerGroup: consumerGroup,
        workerConcurrency: 10,
        jobLeaseDurationMs: 15000,
        jobLeaseRenewIntervalMs: 5000,
        workerKey: `worker-10k-r${runNumber}-${w}-${runId}`,
        workerConsumerName: `consumer-10k-r${runNumber}-${w}-${runId}`,
      }),
      prisma,
      { executorRegistry },
    );
    workers.push(worker);
  }

  const tStart = performance.now();
  await Promise.all(workers.map((w) => w.start()));

  let completedCount = 0;
  const maxWaitMs = 120000;
  const pollStart = Date.now();

  while (Date.now() - pollStart < maxWaitMs) {
    completedCount = await prisma.job.count({
      where: {
        organizationId: orgId,
        type: `BENCHMARK_10K_R${runNumber}`,
        status: JobStatus.SUCCEEDED,
      },
    });
    if (completedCount >= total10kJobs) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const elapsedSec = Number(((performance.now() - tStart) / 1000).toFixed(2));
  const completedJobsPerSec = Number((completedCount / elapsedSec).toFixed(1));

  await Promise.all(workers.map((w) => w.stop()));

  const unfinished = await prisma.job.count({
    where: {
      organizationId: orgId,
      type: `BENCHMARK_10K_R${runNumber}`,
      status: { not: JobStatus.SUCCEEDED },
    },
  });
  const deadLettered = await prisma.job.count({
    where: {
      organizationId: orgId,
      type: `BENCHMARK_10K_R${runNumber}`,
      status: JobStatus.DEAD_LETTERED,
    },
  });
  const blocked = await prisma.job.count({
    where: {
      organizationId: orgId,
      type: `BENCHMARK_10K_R${runNumber}`,
      status: JobStatus.BLOCKED,
    },
  });

  console.log(`  [10k Run #${runNumber}] Completed: ${completedCount}/${total10kJobs} in ${elapsedSec}s (${completedJobsPerSec} completed jobs/sec)`);
  console.log(`  [10k Run #${runNumber}] Dupes: ${duplicateExecutions} | Blocked: ${blocked} | Dead-Lettered: ${deadLettered} | Unfinished: ${unfinished}`);

  return {
    runNumber,
    jobsCreated: total10kJobs,
    jobsCompleted: completedCount,
    elapsedSec,
    completedJobsPerSec,
    duplicateBusinessEffects: duplicateExecutions,
    blocked,
    deadLettered,
    unfinished,
  };
}

async function main() {
  console.log('===============================================================');
  console.log('  RELOOP DAY 21: 10K THROUGHPUT REPEATABILITY BENCHMARK        ');
  console.log('  (3 Independent Runs Under 50 Concurrency Configuration)       ');
  console.log('===============================================================');

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await prisma.$connect();
  const redis = new Redis(redisUrl);

  const baseRunId = Math.random().toString(36).substring(2, 8);
  const org = await prisma.organization.create({
    data: {
      name: `10k Repeatability Org ${baseRunId}`,
      slug: `repeatability-10k-org-${baseRunId}`,
    },
  });

  console.log(`Test Org ID: ${org.id}`);

  const results: Run10kResult[] = [];

  for (let r = 1; r <= 3; r++) {
    const res = await runSingle10k(prisma, redis, org.id, r, baseRunId);
    results.push(res);
    // 1-second pause between runs to let connections drain cleanly
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const throughputs = results.map((r) => r.completedJobsPerSec).sort((a, b) => a - b);
  const minThroughput = throughputs[0];
  const medianThroughput = throughputs[1];
  const maxThroughput = throughputs[2];
  const medianTargetMet = medianThroughput >= 250;

  const totalDupes = results.reduce((acc, r) => acc + r.duplicateBusinessEffects, 0);
  const totalBlocked = results.reduce((acc, r) => acc + r.blocked, 0);
  const totalDeadLettered = results.reduce((acc, r) => acc + r.deadLettered, 0);
  const totalUnfinished = results.reduce((acc, r) => acc + r.unfinished, 0);

  console.log('\n===============================================================');
  console.log('  10K THROUGHPUT REPEATABILITY SUMMARY (3 RUNS)                 ');
  console.log('===============================================================');
  console.log('| Run # | Jobs Created | Jobs Completed | Elapsed (s) | Throughput (jobs/s) | Dupes | Blocked | Dead-Lettered | Unfinished |');
  console.log('| :---: | :----------: | :------------: | :---------: | :-----------------: | :---: | :-----: | :-----------: | :--------: |');
  for (const r of results) {
    console.log(
      `|   ${r.runNumber}   |    ${r.jobsCreated}    |     ${r.jobsCompleted}     |    ${r.elapsedSec.toFixed(2)}   |        ${r.completedJobsPerSec.toFixed(1)}        |   ${r.duplicateBusinessEffects}   |    ${r.blocked}    |       ${r.deadLettered}       |     ${r.unfinished}      |`,
    );
  }
  console.log('---------------------------------------------------------------');
  console.log(`Minimum Completed Jobs/Sec:          ${minThroughput.toFixed(1)} jobs/sec`);
  console.log(`Median Completed Jobs/Sec:           ${medianThroughput.toFixed(1)} jobs/sec`);
  console.log(`Maximum Completed Jobs/Sec:          ${maxThroughput.toFixed(1)} jobs/sec`);
  console.log(`Target Evaluation (Median >= 250):   ${medianTargetMet ? 'PASS' : 'MISS'}`);
  console.log(`Total Duplicate Business Effects:    ${totalDupes} (MUST BE 0)`);
  console.log(`Total Blocked:                       ${totalBlocked}`);
  console.log(`Total Dead-Lettered:                 ${totalDeadLettered}`);
  console.log(`Total Unfinished:                    ${totalUnfinished}`);
  console.log('===============================================================\n');

  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('[Repeatability Benchmark] Error:', err);
  process.exit(1);
});
