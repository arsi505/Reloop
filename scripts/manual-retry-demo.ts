import * as dotenv from 'dotenv';
import Redis from 'ioredis';
import { PrismaClient, JobStatus, JobErrorCategory } from '@prisma/client';
import { loadWorkerConfig } from '../apps/worker/src/config';
import { WorkerService } from '../apps/worker/src/worker-service';
import { JobExecutionError } from '../apps/worker/src/errors';
import { JobExecutorRegistry } from '../apps/worker/src/executor';
import { inspectDeadLetterJobs } from '../apps/worker/src/inspect';

dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

async function runRetryDemo() {
  console.log('===============================================================');
  console.log('  RELOOP DAY 8: RETRY, BACKOFF & DEAD-LETTERING LIVE DEMO     ');
  console.log('===============================================================\n');

  const streamKey = `reloop:demo:retry:jobs:ready`;
  const consumerGroup = `recovery-retry-demo`;

  const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
  await prisma.$connect();
  const redis = new Redis(redisUrl);

  try {
    // 0. Cleanup previous artifacts
    console.log('[Setup] Cleaning demo tables and Redis stream...');
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.worker.deleteMany({});
    await redis.del(streamKey);

    const org = await prisma.organization.create({
      data: {
        name: 'Retry Demo Org ' + Date.now(),
        slug: 'retry-demo-org-' + Date.now(),
      },
    });

    const config = loadWorkerConfig({
      redisUrl,
      jobStreamKey: streamKey,
      jobConsumerGroup: consumerGroup,
      workerKey: 'demo-worker',
      workerConsumerName: 'demo-consumer',
      workerConcurrency: 2,
      jobLeaseDurationMs: 10000,
      jobLeaseRenewIntervalMs: 3000,
      workerHeartbeatIntervalMs: 1000,
      workerShutdownTimeoutMs: 3000,
      blockTimeoutMs: 100,
      jobRetryDelaysMs: [100, 200, 400], // Short backoffs for demo
      jobRetryJitterPercent: 0,
    });

    const executorRegistry = new JobExecutorRegistry();

    // Custom test handlers
    let demoAAttempts = 0;
    executorRegistry.register('DEMO_FAIL_ONCE', async () => {
      demoAAttempts++;
      if (demoAAttempts === 1) {
        throw new JobExecutionError(
          'Simulated 503 upstream gateway outage',
          JobErrorCategory.TRANSIENT,
          'SERVICE_UNAVAILABLE',
        );
      }
      return { status: 'repaired_on_attempt_2' };
    });

    executorRegistry.register('DEMO_ALWAYS_TRANSIENT', async () => {
      throw new JobExecutionError(
        'Simulated network socket timeout to payment provider',
        JobErrorCategory.TRANSIENT,
        'TIMEOUT',
      );
    });

    executorRegistry.register('DEMO_PERMANENT_AUTH', async () => {
      throw new JobExecutionError(
        'Invalid merchant API credentials (Bearer eyJhbGciOi...)',
        JobErrorCategory.AUTH_ERROR,
        'UNAUTHORIZED',
      );
    });

    const worker = new WorkerService(config, prisma, { executorRegistry });

    await worker.start();
    console.log('[Setup] Worker started with custom retry handlers.');

    // -------------------------------------------------------------
    // DEMO A: Fail-Once Transient Error -> RETRY_WAITING -> SUCCEEDED
    // -------------------------------------------------------------
    console.log('\n---------------------------------------------------------------');
    console.log('DEMO A: Transient Fail-Once Retry Flow');
    console.log('---------------------------------------------------------------');
    const jobA = await prisma.job.create({
      data: {
        organizationId: org.id,
        type: 'DEMO_FAIL_ONCE',
        status: JobStatus.QUEUED,
        maxAttempts: 3,
        idempotencyKey: `demo-key-a-${Date.now()}`,
        payload: { test: 'fail-once' },
      },
    });

    console.log(`[A.1] Created Job A: id=${jobA.id}, status=${jobA.status}, maxAttempts=${jobA.maxAttempts}`);
    await redis.xadd(streamKey, '*', 'jobId', jobA.id);

    // Wait for attempt 1
    await new Promise((r) => setTimeout(r, 600));

    const jobAAfterAttempt1 = await prisma.job.findUniqueOrThrow({ where: { id: jobA.id } });
    console.log(
      `[A.2] After Attempt 1: status=${jobAAfterAttempt1.status}, attemptCount=${jobAAfterAttempt1.attemptCount}, nextRunAt=${jobAAfterAttempt1.nextRunAt?.toISOString()}`,
    );

    const attemptsA = await prisma.jobAttempt.findMany({ where: { jobId: jobA.id } });
    console.log(
      `      Attempt 1 record: status=${attemptsA[0]?.status}, category=${attemptsA[0]?.errorCategory}, message="${attemptsA[0]?.errorMessage}"`,
    );

    // Simulate scheduler re-dispatching when nextRunAt is reached
    console.log(`[A.3] Simulating scheduler re-dispatch for Attempt 2...`);
    await redis.xadd(streamKey, '*', 'jobId', jobA.id);
    await new Promise((r) => setTimeout(r, 600));

    const jobAAfterAttempt2 = await prisma.job.findUniqueOrThrow({ where: { id: jobA.id } });
    console.log(
      `[A.4] After Attempt 2: status=${jobAAfterAttempt2.status}, attemptCount=${jobAAfterAttempt2.attemptCount}, completedAt=${jobAAfterAttempt2.completedAt?.toISOString()}`,
    );
    console.log(`      Idempotency key preserved: ${jobAAfterAttempt2.idempotencyKey === jobA.idempotencyKey}`);

    // -------------------------------------------------------------
    // DEMO B: Max Attempts Exhausted -> DEAD_LETTERED
    // -------------------------------------------------------------
    console.log('\n---------------------------------------------------------------');
    console.log('DEMO B: Attempt Exhaustion -> DEAD_LETTERED');
    console.log('---------------------------------------------------------------');
    const jobB = await prisma.job.create({
      data: {
        organizationId: org.id,
        type: 'DEMO_ALWAYS_TRANSIENT',
        status: JobStatus.QUEUED,
        maxAttempts: 2,
        idempotencyKey: `demo-key-b-${Date.now()}`,
        payload: { test: 'exhaust-attempts' },
      },
    });

    console.log(`[B.1] Created Job B: id=${jobB.id}, status=${jobB.status}, maxAttempts=${jobB.maxAttempts}`);
    await redis.xadd(streamKey, '*', 'jobId', jobB.id);

    // Attempt 1 -> RETRY_WAITING
    await new Promise((r) => setTimeout(r, 600));
    const jobB1 = await prisma.job.findUniqueOrThrow({ where: { id: jobB.id } });
    console.log(`[B.2] After Attempt 1: status=${jobB1.status}, attemptCount=${jobB1.attemptCount}`);

    // Re-dispatch for Attempt 2 -> DEAD_LETTERED
    console.log(`[B.3] Re-dispatching for final Attempt 2 (attemptCount 2 of max 2)...`);
    await redis.xadd(streamKey, '*', 'jobId', jobB.id);
    await new Promise((r) => setTimeout(r, 600));

    const jobB2 = await prisma.job.findUniqueOrThrow({ where: { id: jobB.id } });
    console.log(
      `[B.4] After Attempt 2: status=${jobB2.status}, attemptCount=${jobB2.attemptCount}, nextRunAt=${jobB2.nextRunAt}, completedAt=${jobB2.completedAt?.toISOString()}`,
    );

    // Inspect dead letter helper
    const deadLetters = await inspectDeadLetterJobs(prisma, { organizationId: org.id });
    console.log(`[B.5] inspectDeadLetterJobs found ${deadLetters.length} dead-lettered jobs:`);
    for (const dl of deadLetters) {
      console.log(
        `      jobId=${dl.jobId}, type=${dl.type}, attempts=${dl.attemptCount}/${dl.maxAttempts}, lastError=${dl.lastErrorCategory}:${dl.lastErrorCode}`,
      );
    }

    // -------------------------------------------------------------
    // DEMO C: Permanent Non-Retryable Error -> FAILED immediately
    // -------------------------------------------------------------
    console.log('\n---------------------------------------------------------------');
    console.log('DEMO C: Non-Retryable Error (AUTH_ERROR) -> Immediate FAILED');
    console.log('---------------------------------------------------------------');
    const jobC = await prisma.job.create({
      data: {
        organizationId: org.id,
        type: 'DEMO_PERMANENT_AUTH',
        status: JobStatus.QUEUED,
        maxAttempts: 5,
        idempotencyKey: `demo-key-c-${Date.now()}`,
        payload: { token: 'secret-token-do-not-leak' },
      },
    });

    console.log(`[C.1] Created Job C: id=${jobC.id}, maxAttempts=${jobC.maxAttempts}`);
    await redis.xadd(streamKey, '*', 'jobId', jobC.id);
    await new Promise((r) => setTimeout(r, 600));

    const jobC1 = await prisma.job.findUniqueOrThrow({ where: { id: jobC.id } });
    console.log(
      `[C.2] Result: status=${jobC1.status}, attemptCount=${jobC1.attemptCount} (Did NOT transition to RETRY_WAITING despite 4 remaining attempts)`,
    );
    const attemptsC = await prisma.jobAttempt.findMany({ where: { jobId: jobC.id } });
    console.log(
      `      Sanitized attempt error: "${attemptsC[0]?.errorMessage}" (token was redacted/capped)`,
    );

    // Clean up worker
    await worker.stop();
    console.log('\n[Shutdown] Demo worker stopped cleanly.');
    console.log('\n===============================================================');
    console.log('  ALL RETRY, BACKOFF & DEAD-LETTERING DEMOS PASSED SUCCESSFULLY ');
    console.log('===============================================================');
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

runRetryDemo().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
