import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { encryptCredentials as encryptShopifyCredentials } from '@reloop/connector-shopify';
import { encryptCredentials as encryptShipStationCredentials } from '@reloop/connector-shipstation';
import { ShopifySyncJobExecutor } from '../src/shopify-sync-executor';
import { ShipStationSyncJobExecutor } from '../src/shipstation-sync-executor';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:reloop_app_dev_password@localhost:5433/reloop_test?schema=public';
const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('N-05: durable provider sync-run identity', () => {
  let prisma: PrismaClient;
  let organizationId: string;
  let suffix: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    suffix = Math.random().toString(36).slice(2, 10);
    const organization = await prisma.organization.create({
      data: { name: `N05 ${suffix}`, slug: `n05-${suffix}` },
    });
    organizationId = organization.id;
  });

  async function createShopify(activeSyncRunId: string) {
    const encryptedCredentials = encryptShopifyCredentials(
      {
        accessToken: 'shpat_n05_test',
        scopes: ['read_orders'],
        shopDomain: `n05-${suffix}.myshopify.com`,
      },
      encryptionKey,
    );
    return prisma.integration.create({
      data: {
        organizationId,
        provider: 'SHOPIFY',
        name: `N05 Shopify ${suffix}`,
        status: 'CONNECTED',
        shopDomain: `n05-${suffix}.myshopify.com`,
        encryptedCredentials: encryptedCredentials as unknown as object,
        configuration: { initialSyncStatus: 'SYNCING', activeSyncRunId },
      },
    });
  }

  async function createShipStation(activeSyncRunId: string) {
    const encryptedCredentials = encryptShipStationCredentials(
      { apiKey: 'n05_shipstation_key' },
      encryptionKey,
    );
    return prisma.integration.create({
      data: {
        organizationId,
        provider: 'SHIPSTATION',
        name: `N05 ShipStation ${suffix}`,
        status: 'CONNECTED',
        encryptedCredentials: encryptedCredentials as unknown as object,
        configuration: { initialSyncStatus: 'SYNCING', activeSyncRunId },
      },
    });
  }

  function shopifyOrder(id: string) {
    return {
      id: `gid://shopify/Order/${id}`,
      name: `#${id}`,
      createdAt: '2026-09-20T00:00:00Z',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'UNFULFILLED',
      totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
      fulfillments: [],
    };
  }

  function shopifyResponse(id: string, endCursor: string, hasNextPage: boolean) {
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            edges: [{ node: shopifyOrder(id), cursor: endCursor }],
            pageInfo: { hasNextPage, endCursor },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  function shipStationFetch(responsePage = 1) {
    return jest.fn(async (url: string) => {
      if (url.includes('/v2/labels')) {
        return new Response(JSON.stringify({ labels: [], total: 0, page: 1, pages: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          shipments: [
            {
              shipment_id: `${suffix}-${responsePage}`,
              shipment_number: `SHIP-${suffix}-${responsePage}`,
              order_number: `ORD-${suffix}-${responsePage}`,
              shipment_status: 'label_purchased',
              created_at: '2026-09-20T00:00:00Z',
              modified_at: '2026-09-20T00:05:00Z',
            },
          ],
          total: 3,
          page: responsePage,
          pages: 3,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
  }

  it('gives later Shopify runs an independent continuation at a repeated cursor', async () => {
    const integration = await createShopify('shopify-run-a');
    const fetchFn = jest.fn(async () => shopifyResponse('1001', 'cursor-B', true));
    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const runA = await executor.execute({
      jobId: 'n05-shopify-run-a',
      organizationId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id, syncRunId: 'shopify-run-a', maxOrders: 1 },
      attemptNumber: 1,
      workerId: 'n05-worker',
    });
    await prisma.job.update({ where: { id: runA.continuationJobId! }, data: { status: 'SUCCEEDED' } });

    const latest = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        configuration: {
          ...((latest.configuration as Record<string, unknown>) || {}),
          activeSyncRunId: 'shopify-run-b',
          initialSyncStatus: 'SYNCING',
        },
      },
    });

    const runB = await executor.execute({
      jobId: 'n05-shopify-run-b',
      organizationId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id, syncRunId: 'shopify-run-b', maxOrders: 1 },
      attemptNumber: 1,
      workerId: 'n05-worker',
    });
    const runBContinuation = await prisma.job.findUniqueOrThrow({
      where: { id: runB.continuationJobId! },
    });

    expect(runB.continuationJobId).not.toBe(runA.continuationJobId);
    expect(runBContinuation.status).toBe('QUEUED');
    expect(runBContinuation.idempotencyKey).toContain('shopify-run-b');
    expect((runBContinuation.payload as any).syncRunId).toBe('shopify-run-b');

    const staleFetch = jest.fn(async () => {
      throw new Error('stale run must not call the provider');
    });
    const staleResult = await new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: staleFetch as any,
    }).execute({
      jobId: runA.continuationJobId!,
      organizationId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: (await prisma.job.findUniqueOrThrow({ where: { id: runA.continuationJobId! } }))
        .payload as any,
      attemptNumber: 1,
      workerId: 'n05-stale-worker',
    });
    expect(staleResult.currentRun).toBe(false);
    expect(staleFetch).not.toHaveBeenCalled();
    const afterStale = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    expect((afterStale.configuration as any).activeSyncRunId).toBe('shopify-run-b');
  });

  it('preserves Shopify syncRunId across a persisted continuation and a fresh executor', async () => {
    const integration = await createShopify('shopify-restart-run');
    const firstExecutor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: jest.fn(async () => shopifyResponse('2001', 'restart-cursor', true)) as any,
    });
    const first = await firstExecutor.execute({
      jobId: 'n05-shopify-restart-parent',
      organizationId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id, syncRunId: 'shopify-restart-run', maxOrders: 1 },
      attemptNumber: 1,
      workerId: 'n05-worker-a',
    });
    const persisted = await prisma.job.findUniqueOrThrow({ where: { id: first.continuationJobId! } });
    expect(persisted.status).toBe('QUEUED');
    expect((persisted.payload as any).syncRunId).toBe('shopify-restart-run');

    const restartedExecutor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: jest.fn(async () => shopifyResponse('2002', 'done-cursor', false)) as any,
    });
    const completed = await restartedExecutor.execute({
      jobId: persisted.id,
      organizationId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: persisted.payload as any,
      attemptNumber: 1,
      workerId: 'n05-worker-b',
    });
    expect(completed.complete).toBe(true);
    expect((completed as any).syncRunId).toBe('shopify-restart-run');
    expect((completed as any).currentRun).toBe(true);
  });

  it('deduplicates replay within one Shopify run without reusing another run', async () => {
    const integration = await createShopify('shopify-replay-run');
    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: jest.fn(async () => shopifyResponse('3001', 'replay-cursor', true)) as any,
    });
    const context = {
      jobId: 'n05-shopify-replay-parent',
      organizationId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id, syncRunId: 'shopify-replay-run', maxOrders: 1 },
      attemptNumber: 1,
      workerId: 'n05-worker',
    } as any;
    const first = await executor.execute(context);
    const replay = await executor.execute(context);
    expect(replay.continuationJobId).toBe(first.continuationJobId);
    expect(
      await prisma.job.count({
        where: { organizationId, idempotencyKey: { contains: 'shopify-replay-run' } },
      }),
    ).toBe(1);
  });

  it('fails Shopify safely when the provider claims progress but repeats the input cursor', async () => {
    const integration = await createShopify('shopify-no-progress');
    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: jest.fn(async () => shopifyResponse('4001', 'cursor-B', true)) as any,
    });
    await expect(
      executor.execute({
        jobId: 'n05-shopify-no-progress',
        organizationId,
        type: 'SHOPIFY_SYNC_ORDERS',
        payload: {
          integrationId: integration.id,
          syncRunId: 'shopify-no-progress',
          cursor: 'cursor-B',
          maxOrders: 1,
        },
        attemptNumber: 1,
        workerId: 'n05-worker',
      }),
    ).rejects.toMatchObject({ code: 'SHOPIFY_SYNC_NO_PROGRESS' });

    expect(
      await prisma.job.count({ where: { organizationId, idempotencyKey: { contains: 'cursor-B' } } }),
    ).toBe(0);
    const failed = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    expect((failed.configuration as any).initialSyncStatus).toBe('FAILED');
  });

  it('gives later ShipStation runs an independent page-2 continuation', async () => {
    const integration = await createShipStation('shipstation-run-a');
    const executor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: shipStationFetch(1) as any,
    });
    const runA = await executor.execute({
      jobId: 'n05-shipstation-run-a',
      organizationId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id, syncRunId: 'shipstation-run-a', maxShipments: 1 },
      attemptNumber: 1,
      workerId: 'n05-worker',
    });
    await prisma.job.update({ where: { id: runA.continuationJobId! }, data: { status: 'SUCCEEDED' } });

    const latest = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        configuration: {
          ...((latest.configuration as Record<string, unknown>) || {}),
          activeSyncRunId: 'shipstation-run-b',
          initialSyncStatus: 'SYNCING',
        },
      },
    });
    const runB = await executor.execute({
      jobId: 'n05-shipstation-run-b',
      organizationId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id, syncRunId: 'shipstation-run-b', maxShipments: 1 },
      attemptNumber: 1,
      workerId: 'n05-worker',
    });
    const runBContinuation = await prisma.job.findUniqueOrThrow({
      where: { id: runB.continuationJobId! },
    });
    expect(runB.continuationJobId).not.toBe(runA.continuationJobId);
    expect(runBContinuation.status).toBe('QUEUED');
    expect(runBContinuation.idempotencyKey).toContain('shipstation-run-b');
    expect((runBContinuation.payload as any).syncRunId).toBe('shipstation-run-b');
  });

  it('fails ShipStation safely when provider pagination moves behind the requested page', async () => {
    const integration = await createShipStation('shipstation-no-progress');
    const executor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: shipStationFetch(1) as any,
    });
    await expect(
      executor.execute({
        jobId: 'n05-shipstation-no-progress',
        organizationId,
        type: 'SHIPSTATION_SYNC_SHIPMENTS',
        payload: {
          integrationId: integration.id,
          syncRunId: 'shipstation-no-progress',
          page: 2,
          maxShipments: 1,
        },
        attemptNumber: 1,
        workerId: 'n05-worker',
      }),
    ).rejects.toMatchObject({ code: 'SHIPSTATION_SYNC_NO_PROGRESS' });
    const failed = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    expect((failed.configuration as any).initialSyncStatus).toBe('FAILED');
  });
});
