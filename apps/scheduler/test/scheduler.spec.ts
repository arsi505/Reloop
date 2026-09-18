import * as dotenv from 'dotenv';
import * as path from 'path';
import Redis from 'ioredis';
import { PrismaClient, JobStatus } from '@prisma/client';
import { loadSchedulerConfig } from '../src/config';
import { RedisPublisher, DISPATCH_LUA_SCRIPT } from '../src/redis-publisher';
import { JobScanner } from '../src/job-scanner';
import { SchedulerService } from '../src/scheduler-service';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

describe('Day 6: Redis Streams Job Dispatch Scheduler', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let testOrgId: string;
  let runId: string;
  let testStreamKey: string;
  let testGroup: string;
  let publisher: RedisPublisher;
  let scheduler: SchedulerService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
    redis = new Redis(redisUrl);
  });

  afterAll(async () => {
    if (scheduler && scheduler.getIsRunning()) {
      await scheduler.stop();
    }
    if (publisher) {
      await publisher.close();
    }
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(async () => {
    runId = Math.random().toString(36).substring(2, 9);
    testStreamKey = `reloop:test:${runId}:jobs:ready`;
    testGroup = `test-group-${runId}`;

    // Clean database tables in dependency order
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});

    const org = await prisma.organization.create({
      data: {
        name: `Test Org ${runId}`,
        slug: `test-org-${runId}`,
      },
    });
    testOrgId = org.id;
  });

  afterEach(async () => {
    if (scheduler && scheduler.getIsRunning()) {
      await scheduler.stop();
    }
    // Clean up isolated Redis keys created during test
    const keys = await redis.keys(`reloop:test:${runId}:*`);
    const dispatchKeys = await redis.keys('reloop:dispatch:*');
    const allKeys = [...keys, ...dispatchKeys];
    if (allKeys.length > 0) {
      await redis.del(...allKeys);
    }
  });

  describe('1. Stream and Consumer Group Initialization', () => {
    it('creates stream and consumer group idempotently via MKSTREAM and handles BUSYGROUP cleanly', async () => {
      const config = loadSchedulerConfig({
        redisUrl,
        jobStreamKey: testStreamKey,
        jobConsumerGroup: testGroup,
      });
      const pub = new RedisPublisher(config);
      await pub.connect();

      // Stream should not exist yet
      const existsBefore = await redis.exists(testStreamKey);
      expect(existsBefore).toBe(0);

      // Ensure group created
      await pub.ensureConsumerGroup();

      // Stream should now exist
      const existsAfter = await redis.exists(testStreamKey);
      expect(existsAfter).toBe(1);

      // Group info should show our group
      const groups = (await redis.xinfo('GROUPS', testStreamKey)) as any[];
      expect(groups.length).toBe(1);
      expect(groups[0][1]).toBe(testGroup);

      // Calling again should not throw (BUSYGROUP is cleanly swallowed)
      await expect(pub.ensureConsumerGroup()).resolves.not.toThrow();

      await pub.close();
    });
  });

  describe('2. Job Eligibility & Scanning', () => {
    it('dispatches due QUEUED jobs and RETRY_WAITING jobs, suppressing future jobs and non-ready states', async () => {
      const now = new Date();
      const past = new Date(Date.now() - 60000);
      const future = new Date(Date.now() + 60000);

      // Due QUEUED (current nextRunAt)
      const jobQueuedDue1 = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'DISPATCH_TEST',
          status: JobStatus.QUEUED,
          nextRunAt: past,
          idempotencyKey: `idemp-${runId}-queued-1`,
        },
      });

      // Due QUEUED (past nextRunAt)
      const jobQueuedDue2 = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'DISPATCH_TEST',
          status: JobStatus.QUEUED,
          nextRunAt: past,
          idempotencyKey: `idemp-${runId}-queued-2`,
        },
      });

      // Future QUEUED (should be suppressed)
      const jobQueuedFuture = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'DISPATCH_TEST',
          status: JobStatus.QUEUED,
          nextRunAt: future,
          idempotencyKey: `idemp-${runId}-queued-future`,
        },
      });

      // Due RETRY_WAITING (past nextRunAt)
      const jobRetryDue = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'DISPATCH_TEST',
          status: JobStatus.RETRY_WAITING,
          nextRunAt: past,
          idempotencyKey: `idemp-${runId}-retry-due`,
        },
      });

      // Future RETRY_WAITING (should be suppressed)
      const jobRetryFuture = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'DISPATCH_TEST',
          status: JobStatus.RETRY_WAITING,
          nextRunAt: future,
          idempotencyKey: `idemp-${runId}-retry-future`,
        },
      });

      // Non-ready statuses (should all be suppressed)
      const nonReadyStatuses: JobStatus[] = [
        JobStatus.CLAIMED,
        JobStatus.RUNNING,
        JobStatus.WAITING_APPROVAL,
        JobStatus.SUCCEEDED,
        JobStatus.FAILED,
        JobStatus.BLOCKED,
        JobStatus.DEAD_LETTERED,
        JobStatus.CANCELLED,
      ];
      for (let i = 0; i < nonReadyStatuses.length; i++) {
        const status = nonReadyStatuses[i];
        await prisma.job.create({
          data: {
            organizationId: testOrgId,
            type: 'DISPATCH_TEST',
            status,
            nextRunAt: past,
            idempotencyKey: `idemp-${runId}-nonready-${i}`,
          },
        });
      }

      const config = loadSchedulerConfig({
        redisUrl,
        jobStreamKey: testStreamKey,
        jobConsumerGroup: testGroup,
      });
      publisher = new RedisPublisher(config);
      scheduler = new SchedulerService(config, prisma, publisher);
      await publisher.connect();
      await publisher.ensureConsumerGroup();

      const tickResult = await scheduler.tick();
      expect(tickResult.scanned).toBe(3); // jobQueuedDue1, jobQueuedDue2, jobRetryDue
      expect(tickResult.published).toBe(3);
      expect(tickResult.suppressed).toBe(0);

      // Read stream entries
      const entries = await redis.xrange(testStreamKey, '-', '+');
      expect(entries.length).toBe(3);
      const publishedIds = entries.map((entry) => entry[1][1]);
      expect(publishedIds).toContain(jobQueuedDue1.id);
      expect(publishedIds).toContain(jobQueuedDue2.id);
      expect(publishedIds).toContain(jobRetryDue.id);
      expect(publishedIds).not.toContain(jobQueuedFuture.id);
      expect(publishedIds).not.toContain(jobRetryFuture.id);
    });
  });

  describe('3. Message Format Minimality & Non-Mutation Invariant', () => {
    it('verifies stream message contains ONLY jobId and does NOT mutate Job status or nextRunAt in database', async () => {
      const jobTime = new Date(Date.now() - 5000);
      const job = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'MINIMAL_MSG_TEST',
          status: JobStatus.QUEUED,
          nextRunAt: jobTime,
          idempotencyKey: `idemp-${runId}-minimal`,
          payload: { customer: { pii: 'secret', name: 'Alice' }, token: 'secret-token' },
        },
      });

      const config = loadSchedulerConfig({
        redisUrl,
        jobStreamKey: testStreamKey,
        jobConsumerGroup: testGroup,
      });
      publisher = new RedisPublisher(config);
      scheduler = new SchedulerService(config, prisma, publisher);
      await publisher.connect();
      await publisher.ensureConsumerGroup();

      await scheduler.tick();

      // Check Redis message format
      const entries = await redis.xrange(testStreamKey, '-', '+');
      expect(entries.length).toBe(1);
      const [streamId, fields] = entries[0];
      expect(fields.length).toBe(2); // ['jobId', '<uuid>']
      expect(fields[0]).toBe('jobId');
      expect(fields[1]).toBe(job.id);

      // Ensure no PII, payload, or tokens are present in Redis entry
      const fieldString = JSON.stringify(fields);
      expect(fieldString).not.toContain('secret');
      expect(fieldString).not.toContain('Alice');
      expect(fieldString).not.toContain('payload');

      // Check database state: MUST NOT BE MUTATED
      const dbJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(dbJob.status).toBe(JobStatus.QUEUED);
      expect(dbJob.nextRunAt).toEqual(job.nextRunAt);
      expect(dbJob.updatedAt).toEqual(job.updatedAt);
    });
  });

  describe('4. Dispatch Deduplication & TTL Expiry', () => {
    it('suppresses duplicate dispatches within marker TTL and allows redispatch after TTL expires', async () => {
      const jobTime = new Date(Date.now() - 5000);
      const job = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'DEDUP_TEST',
          status: JobStatus.QUEUED,
          nextRunAt: jobTime,
          idempotencyKey: `idemp-${runId}-dedup`,
        },
      });

      // Configure short TTL of 500ms for testing
      const config = loadSchedulerConfig({
        redisUrl,
        jobStreamKey: testStreamKey,
        jobConsumerGroup: testGroup,
        dispatchMarkerTtlMs: 500,
      });
      publisher = new RedisPublisher(config);
      scheduler = new SchedulerService(config, prisma, publisher);
      await publisher.connect();
      await publisher.ensureConsumerGroup();

      // First tick: publishes job
      const tick1 = await scheduler.tick();
      expect(tick1.scanned).toBe(1);
      expect(tick1.published).toBe(1);
      expect(tick1.suppressed).toBe(0);

      // Verify dispatch marker exists in Redis with TTL <= 500ms
      const markerKey = `reloop:dispatch:${job.id}`;
      const markerExists = await redis.exists(markerKey);
      expect(markerExists).toBe(1);
      const pttl = await redis.pttl(markerKey);
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(500);

      // Second tick immediately: job is scanned again from DB (still QUEUED), but suppressed by Redis marker!
      const tick2 = await scheduler.tick();
      expect(tick2.scanned).toBe(1);
      expect(tick2.published).toBe(0);
      expect(tick2.suppressed).toBe(1);

      // Stream still has exactly 1 entry
      let entries = await redis.xrange(testStreamKey, '-', '+');
      expect(entries.length).toBe(1);

      // Wait for marker to expire (> 500ms)
      await new Promise((resolve) => setTimeout(resolve, 600));
      const markerAfterWait = await redis.exists(markerKey);
      expect(markerAfterWait).toBe(0);

      // Third tick after expiry: job is scanned and published again!
      const tick3 = await scheduler.tick();
      expect(tick3.scanned).toBe(1);
      expect(tick3.published).toBe(1);
      expect(tick3.suppressed).toBe(0);

      entries = await redis.xrange(testStreamKey, '-', '+');
      expect(entries.length).toBe(2);
    });
  });

  describe('5. Concurrent Scheduler Race Condition (Atomic Lua Script)', () => {
    it('ensures exactly one winner when multiple schedulers race to dispatch the same job', async () => {
      const jobId = '00000000-0000-0000-0000-000000000001';
      const markerKey = `reloop:dispatch:${jobId}`;
      const ttlMs = '10000';

      // Simulate 10 concurrent scheduler processes racing on the exact same job
      const attempts = await Promise.all(
        Array.from({ length: 10 }).map(() =>
          redis.eval(DISPATCH_LUA_SCRIPT, 2, markerKey, testStreamKey, ttlMs, jobId),
        ),
      );

      // Exactly one process must succeed (return 1), all other 9 must be 0
      const winners = attempts.filter((res) => res === 1);
      const losers = attempts.filter((res) => res === 0);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(9);

      // Exactly one message in the stream
      const entries = await redis.xrange(testStreamKey, '-', '+');
      expect(entries.length).toBe(1);
      expect(entries[0][1][1]).toBe(jobId);
    });
  });

  describe('6. Ordering & Priority Discipline', () => {
    it('orders jobs by priority DESC, then nextRunAt ASC, then createdAt ASC', async () => {
      const t0 = new Date(Date.now() - 30000);
      const t1 = new Date(Date.now() - 20000);
      const t2 = new Date(Date.now() - 10000);

      // Job 1: normal priority 100, due earlier (t0)
      const job1 = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'ORDERING_TEST',
          priority: 100,
          nextRunAt: t0,
          createdAt: t0,
          idempotencyKey: `idemp-${runId}-order-1`,
        },
      });

      // Job 2: high priority 200, due later (t2) -> should come first due to priority!
      const job2 = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'ORDERING_TEST',
          priority: 200,
          nextRunAt: t2,
          createdAt: t2,
          idempotencyKey: `idemp-${runId}-order-2`,
        },
      });

      // Job 3: normal priority 100, due later (t1) -> should come after Job 1
      const job3 = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'ORDERING_TEST',
          priority: 100,
          nextRunAt: t1,
          createdAt: t1,
          idempotencyKey: `idemp-${runId}-order-3`,
        },
      });

      const config = loadSchedulerConfig({
        redisUrl,
        jobStreamKey: testStreamKey,
        jobConsumerGroup: testGroup,
      });
      const scanner = new JobScanner(prisma, config);
      const scanned = await scanner.scanEligibleJobs();

      expect(scanned.map((j) => j.id)).toEqual([job2.id, job1.id, job3.id]);
    });
  });

  describe('7. Resilience: Redis Outage Leaves PostgreSQL Intact', () => {
    it('records error metrics and leaves Job unchanged in PostgreSQL if Redis is unreachable', async () => {
      const jobTime = new Date(Date.now() - 5000);
      const job = await prisma.job.create({
        data: {
          organizationId: testOrgId,
          type: 'OUTAGE_TEST',
          status: JobStatus.QUEUED,
          nextRunAt: jobTime,
          idempotencyKey: `idemp-${runId}-outage`,
        },
      });

      // Point publisher to an unreachable port (e.g. 59999)
      const badConfig = loadSchedulerConfig({
        redisUrl: 'redis://127.0.0.1:59999',
        jobStreamKey: testStreamKey,
        jobConsumerGroup: testGroup,
      });
      const badPublisher = new RedisPublisher(badConfig);
      const failingScheduler = new SchedulerService(badConfig, prisma, badPublisher);

      const result = await failingScheduler.tick();
      expect(result.scanned).toBe(1);
      expect(result.published).toBe(0);
      expect(result.errors).toBeGreaterThanOrEqual(1);

      // Database record remains untouched and valid
      const dbJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(dbJob.status).toBe(JobStatus.QUEUED);
      expect(dbJob.nextRunAt).toEqual(job.nextRunAt);

      await badPublisher.close();
    });
  });
});