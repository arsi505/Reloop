import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { activateSyncRunWithInitialJob } from './sync-run-start';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:reloop_app_dev_password@localhost:5433/reloop_test?schema=public';

describe('RA-02 atomic initial sync-run start', () => {
  let prisma: PrismaClient;
  let organizationId: string;
  let integrationId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });

  beforeEach(async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const organization = await prisma.organization.create({
      data: { name: `RA-02 Start ${suffix}`, slug: `ra02-start-${suffix}` },
    });
    organizationId = organization.id;
    const integration = await prisma.integration.create({
      data: {
        organizationId,
        provider: 'SHOPIFY',
        name: `RA-02 Start Shopify ${suffix}`,
        status: 'CONNECTED',
        shopDomain: `ra02-start-${suffix}.myshopify.com`,
        configuration: {
          activeSyncRunId: 'previous-run',
          initialSyncStatus: 'COMPLETED',
        },
      },
    });
    integrationId = integration.id;
  });

  afterEach(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
  });

  it('commits activation and a scheduler-discoverable initial Job together', async () => {
    const syncRunId = randomUUID();
    await start(syncRunId);

    const [integration, durableJob] = await Promise.all([
      prisma.integration.findUniqueOrThrow({ where: { id: integrationId } }),
      prisma.job.findFirstOrThrow({
        where: {
          id: syncRunId,
          organizationId,
          status: 'QUEUED',
          nextRunAt: { lte: new Date() },
        },
      }),
    ]);
    expect((integration.configuration as Record<string, unknown>).activeSyncRunId).toBe(
      syncRunId,
    );
    expect((durableJob.payload as Record<string, unknown>).syncRunId).toBe(syncRunId);
  });

  it('rolls activation back when initial Job creation fails, then permits a normal start', async () => {
    const failedRunId = randomUUID();
    const collisionKey = `ra02-collision-${randomUUID()}`;
    await prisma.job.create({
      data: {
        organizationId,
        type: 'UNRELATED_TEST_JOB',
        status: 'QUEUED',
        payload: {},
        idempotencyKey: collisionKey,
        nextRunAt: new Date(),
      },
    });

    await expect(start(failedRunId, collisionKey)).rejects.toMatchObject({ code: 'P2002' });
    const rolledBack = await prisma.integration.findUniqueOrThrow({
      where: { id: integrationId },
    });
    expect((rolledBack.configuration as Record<string, unknown>).activeSyncRunId).toBe(
      'previous-run',
    );
    expect(await prisma.job.count({ where: { id: failedRunId } })).toBe(0);

    const successfulRunId = randomUUID();
    await start(successfulRunId);
    const recovered = await prisma.integration.findUniqueOrThrow({
      where: { id: integrationId },
    });
    expect((recovered.configuration as Record<string, unknown>).activeSyncRunId).toBe(
      successfulRunId,
    );
    expect(await prisma.job.count({ where: { id: successfulRunId } })).toBe(1);
  });

  it('serializes concurrent starts and leaves the active owner with durable work', async () => {
    const runA = randomUUID();
    const runB = randomUUID();
    await Promise.all([start(runA), start(runB)]);

    const integration = await prisma.integration.findUniqueOrThrow({
      where: { id: integrationId },
    });
    const activeRunId = (integration.configuration as Record<string, unknown>)
      .activeSyncRunId as string;
    expect([runA, runB]).toContain(activeRunId);
    expect(await prisma.job.count({ where: { id: { in: [runA, runB] } } })).toBe(2);
    expect(await prisma.job.count({ where: { id: activeRunId, status: 'QUEUED' } })).toBe(1);
  });

  async function start(syncRunId: string, idempotencyKey?: string): Promise<void> {
    await activateSyncRunWithInitialJob(prisma, {
      integrationId,
      organizationId,
      syncRunId,
      jobType: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId, syncRunId },
      idempotencyKey:
        idempotencyKey || `shopify_sync_run_${integrationId}_${syncRunId}`,
    });
  }
});
