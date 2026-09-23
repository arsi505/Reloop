import { execSync } from 'child_process';
import Redis from 'ioredis';
import { PrismaClient, JobStatus } from '@prisma/client';
import { loadWorkerConfig } from '../../apps/worker/src/config';
import { WorkerService } from '../../apps/worker/src/worker-service';
import { JobExecutorRegistry } from '../../apps/worker/src/executor';

const dbUrl =
  process.env.RELOOP_TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://reloop@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

async function main() {
  console.log('===============================================================');
  console.log('  RELOOP DAY 21: POSTGRESQL APPLICATION-LEVEL OUTAGE DRILL     ');
  console.log('===============================================================\n');

  let prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await prisma.$connect();
  const redis = new Redis(redisUrl);

  const baselineOrgCount = await prisma.organization.count();
  const runId = Math.random().toString(36).substring(2, 8);
  const testOrg = await prisma.organization.create({
    data: {
      name: `PG Outage Test Org ${runId}`,
      slug: `pg-outage-org-${runId}`,
    },
  });

  console.log(`[PG Outage Drill] Baseline Org Count: ${baselineOrgCount} (Created test org: ${testOrg.id})`);

  // Stage a durable job in PostgreSQL and enqueue into Redis stream
  const streamKey = `reloop:drill:pg_outage:${runId}`;
  const group = `group-pg-outage-${runId}`;
  await redis.xgroup('CREATE', streamKey, group, '$', 'MKSTREAM').catch(() => {});

  const testJob = await prisma.job.create({
    data: {
      organizationId: testOrg.id,
      type: 'PG_OUTAGE_DURABLE_JOB',
      status: JobStatus.QUEUED,
      idempotencyKey: `pg-outage-job-${runId}`,
    },
  });
  await redis.xadd(streamKey, '*', 'jobId', testJob.id, 'orgId', testOrg.id);

  // Disconnect active client before stopping container
  await prisma.$disconnect();

  console.log('[PG Outage Drill] Inducing bounded PostgreSQL outage via container stop...');
  try {
    execSync('docker stop reloop-postgres', { stdio: 'pipe' });
  } catch (err: any) {
    console.warn('[PG Outage Drill] Could not execute docker stop directly:', err.message);
  }

  // Allow container port to close
  await new Promise((r) => setTimeout(r, 1500));

  // ---------------------------------------------------------------------------
  // A. Attempt authenticated API mutation requiring durable PostgreSQL write
  // ---------------------------------------------------------------------------
  console.log('[PG Outage Drill] Part A: Attempting API mutation during outage...');
  let apiMutationFailedSafely = false;
  let falseApiSuccessReturned = false;

  const outagePrisma = new PrismaClient({
    datasources: { db: { url: dbUrl.concat('?connect_timeout=2') } },
  });

  try {
    // Attempt mutation: creating an order
    await outagePrisma.externalOrder.create({
      data: {
        organizationId: testOrg.id,
        externalOrderNumber: `ORD-OUTAGE-${runId}`,
        status: 'FULFILLING',
      },
    });
    // If it did not throw, false success occurred
    falseApiSuccessReturned = true;
  } catch (err) {
    apiMutationFailedSafely = true;
    console.log('  -> API mutation rejected safely with connection error (no false success).');
  } finally {
    await outagePrisma.$disconnect().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // B. Allow worker operation to encounter the unavailable database
  // ---------------------------------------------------------------------------
  console.log('[PG Outage Drill] Part B: Worker encountering unavailable PostgreSQL...');
  let workerFalselyMarkedSuccess = false;
  let workerEncounteredDbFailure = false;

  let workerExecutions = 0;
  const executorRegistry = new JobExecutorRegistry();
  executorRegistry.register('PG_OUTAGE_DURABLE_JOB', async () => {
    workerExecutions++;
    return { done: true };
  });

  const baseConfig = loadWorkerConfig();
  const outageWorker = new WorkerService(
    loadWorkerConfig({
      ...baseConfig,
      redisUrl,
      jobStreamKey: streamKey,
      jobConsumerGroup: group,
      workerKey: `worker-pg-outage-${runId}`,
      workerConsumerName: `consumer-pg-outage-${runId}`,
    }),
    new PrismaClient({ datasources: { db: { url: dbUrl.concat('?connect_timeout=2') } } }),
    { executorRegistry },
  );

  try {
    await outageWorker.start();
    await new Promise((r) => setTimeout(r, 1000));
    await outageWorker.stop();
  } catch {
    workerEncounteredDbFailure = true;
  }

  // ---------------------------------------------------------------------------
  // Restore PostgreSQL
  // ---------------------------------------------------------------------------
  console.log('[PG Outage Drill] Restoring PostgreSQL container...');
  try {
    execSync('docker start reloop-postgres', { stdio: 'pipe' });
  } catch (err: any) {
    console.error('[PG Outage Drill] Error starting container:', err.message);
  }

  // Poll until PostgreSQL is ready
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  let dbRestored = false;
  const restorePollStart = Date.now();
  while (Date.now() - restorePollStart < 20000) {
    try {
      const q = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 as ok`;
      if (q[0]?.ok === 1) {
        dbRestored = true;
        break;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`[PG Outage Drill] PostgreSQL Restored: ${dbRestored}`);

  // Check state of the job in PostgreSQL
  const jobAfterOutage = await prisma.job.findUnique({ where: { id: testJob.id } });
  // Worker must NOT have marked the job SUCCEEDED during outage!
  if (jobAfterOutage?.status === JobStatus.SUCCEEDED) {
    workerFalselyMarkedSuccess = true;
  }

  // Verify existing records remained intact (no volume loss)
  const currentOrgCount = await prisma.organization.count();
  const recordsIntact = currentOrgCount === baselineOrgCount + 1;

  // Process the surviving job now that DB is restored
  const recoveryWorker = new WorkerService(
    loadWorkerConfig({
      ...baseConfig,
      redisUrl,
      jobStreamKey: streamKey,
      jobConsumerGroup: group,
      workerPelMinIdleMs: 50,
      workerKey: `worker-pg-recovery-${runId}`,
      workerConsumerName: `consumer-pg-recovery-${runId}`,
    }),
    prisma,
    { executorRegistry },
  );

  await recoveryWorker.start();
  await recoveryWorker.getRecoveryService().scanOnce();
  await new Promise((r) => setTimeout(r, 1000));
  await recoveryWorker.stop();

  const finalJob = await prisma.job.findUnique({ where: { id: testJob.id } });

  console.log('\n===============================================================');
  console.log('  POSTGRESQL APPLICATION-LEVEL OUTAGE DRILL RESULTS            ');
  console.log('===============================================================');
  console.log(`PostgreSQL API-Mutation Outage:      ${apiMutationFailedSafely && !falseApiSuccessReturned ? 'PASS' : 'FAIL'}`);
  console.log(`False API Success During Outage?:    ${falseApiSuccessReturned ? 'YES' : 'NO'} (MUST BE NO)`);
  console.log(`PostgreSQL Worker Outage:            ${!workerFalselyMarkedSuccess && finalJob?.status === JobStatus.SUCCEEDED ? 'PASS' : 'FAIL'}`);
  console.log(`Worker Falsely Marked Success?:      ${workerFalselyMarkedSuccess ? 'YES' : 'NO'} (MUST BE NO)`);
  console.log(`Existing DB Records Intact:          ${recordsIntact ? 'YES' : 'NO'} (Baseline: ${baselineOrgCount}, Current: ${currentOrgCount})`);
  console.log(`Normal DB Operation Resumed:         ${dbRestored ? 'YES' : 'NO'}`);
  console.log(`Final Job Status After Recovery:     ${finalJob?.status}`);
  console.log(`Duplicate Business Executions:       ${workerExecutions > 1 ? workerExecutions - 1 : 0} (MUST BE 0)`);
  console.log('===============================================================\n');

  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('[PG Outage Drill] Error:', err);
  // Ensure container is running even if script crashes
  try {
    execSync('docker start reloop-postgres', { stdio: 'pipe' });
  } catch {}
  process.exit(1);
});
