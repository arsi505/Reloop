import * as dotenv from 'dotenv';
import Redis from 'ioredis';
import { PrismaClient, JobStatus } from '@prisma/client';
import { loadSchedulerConfig } from '../apps/scheduler/src/config';
import { RedisPublisher } from '../apps/scheduler/src/redis-publisher';
import { SchedulerService } from '../apps/scheduler/src/scheduler-service';

dotenv.config();

async function runManualVerification() {
  console.log('=== Reloop Day 6: Live Manual Verification Script ===\n');

  const config = loadSchedulerConfig({
    jobStreamKey: 'reloop:live-verify:jobs:ready',
    jobConsumerGroup: 'live-verify-group',
    dispatchMarkerTtlMs: 30000,
  });

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.TEST_DATABASE_URL || 'postgresql://reloop_app:reloop_app_dev_password@localhost:5433/reloop_test?schema=public',
      },
    },
  });
  await prisma.$connect();

  const redis = new Redis(config.redisUrl);
  const publisher = new RedisPublisher(config, redis);
  const scheduler = new SchedulerService(config, prisma, publisher);

  try {
    // Purge any preexisting jobs on test database
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await redis.del(config.jobStreamKey);

    // 1. Setup test organization and job in PostgreSQL
    const org = await prisma.organization.create({
      data: {
        name: 'Manual Live Org ' + Date.now(),
        slug: 'manual-live-org-' + Date.now(),
      },
    });

    const testJob = await prisma.job.create({
      data: {
        organizationId: org.id,
        type: 'MANUAL_LIVE_TEST',
        status: JobStatus.QUEUED,
        priority: 150,
        nextRunAt: new Date(Date.now() - 10000),
        idempotencyKey: 'manual-live-key-' + Date.now(),
        payload: { customer: 'Sensitive Customer Info - Should NOT be in Redis' },
      },
    });
    console.log(`[1] Created Test Job in PostgreSQL: id=${testJob.id}, status=${testJob.status}`);

    // 2. Start scheduler components & run tick
    await publisher.connect();
    await publisher.ensureConsumerGroup();
    console.log(`[2] Consumer Group "${config.jobConsumerGroup}" created on stream "${config.jobStreamKey}"`);

    const tickResult = await scheduler.tick();
    console.log(`[3] Scheduler tick executed:`, tickResult);

    // 3. Inspect Redis Stream directly
    console.log('\n--- Redis Live Output ---');
    const streamInfo = (await redis.xinfo('STREAM', config.jobStreamKey)) as any[];
    console.log('XINFO STREAM length properties:');
    for (let i = 0; i < streamInfo.length; i += 2) {
      if (['length', 'radix-tree-keys', 'radix-tree-nodes', 'groups', 'last-generated-id'].includes(streamInfo[i])) {
        console.log(`  ${streamInfo[i]}: ${JSON.stringify(streamInfo[i + 1])}`);
      }
    }

    const groupsInfo = (await redis.xinfo('GROUPS', config.jobStreamKey)) as any[];
    console.log('\nXINFO GROUPS:');
    for (const g of groupsInfo) {
      console.log(`  name: ${g[1]}, consumers: ${g[3]}, pending: ${g[5]}`);
    }

    const entries = await redis.xrange(config.jobStreamKey, '-', '+');
    console.log('\nXRANGE entries:');
    for (const [id, fields] of entries) {
      console.log(`  entry id: ${id}`);
      console.log(`  fields: ${JSON.stringify(fields)}`);
    }

    // 4. Verify minimal payload invariant
    const matchingEntry = entries.find((e) => e[1][0] === 'jobId' && e[1][1] === testJob.id);
    const isMinimal = matchingEntry !== undefined && matchingEntry[1].length === 2;
    console.log(`\n[4] Redis message minimality check: ${isMinimal ? 'PASS (contains ONLY jobId)' : 'FAIL'}`);

    // 5. Verify DB non-mutation invariant
    const dbJobAfter = await prisma.job.findUniqueOrThrow({ where: { id: testJob.id } });
    const isUnchanged = dbJobAfter.status === JobStatus.QUEUED && dbJobAfter.nextRunAt.getTime() === testJob.nextRunAt.getTime();
    console.log(`[5] PostgreSQL Job non-mutation check: ${isUnchanged ? 'PASS (status and nextRunAt unchanged)' : 'FAIL'}`);

    // 6. Cleanup
    await redis.del(config.jobStreamKey, `reloop:dispatch:${testJob.id}`);
    await prisma.job.delete({ where: { id: testJob.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    console.log('\n[6] Cleanup complete: test records and stream purged.');
  } finally {
    await publisher.close();
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

runManualVerification().catch((err) => {
  console.error('Fatal error during manual verification:', err);
  process.exit(1);
});