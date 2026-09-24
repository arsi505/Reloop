import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { encryptCredentials as encryptShopifyCredentials } from '@reloop/connector-shopify';
import { encryptCredentials as encryptShipStationCredentials } from '@reloop/connector-shipstation';
import { ShopifySyncJobExecutor } from '../src/shopify-sync-executor';
import { ShipStationSyncJobExecutor } from '../src/shipstation-sync-executor';
import { withCurrentSyncRunTransaction } from '../src/sync-run-state';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:reloop_app_dev_password@localhost:5433/reloop_test?schema=public';
const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('RA-02 provider sync-run projection fencing', () => {
  let prisma: PrismaClient;
  let organizationId: string;
  let suffix: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });

  beforeEach(async () => {
    suffix = Math.random().toString(36).slice(2, 10);
    const organization = await prisma.organization.create({
      data: { name: `RA-02 ${suffix}`, slug: `ra02-${suffix}` },
    });
    organizationId = organization.id;
  });

  afterEach(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
  });

  it('prevents a superseded Shopify run from projecting after the newer run activates', async () => {
    const runA = randomUUID();
    const runB = randomUUID();
    const orderNumber = `RA02-SHOP-${suffix}`;
    const integration = await prisma.integration.create({
      data: {
        organizationId,
        provider: 'SHOPIFY',
        name: `RA-02 Shopify ${suffix}`,
        status: 'CONNECTED',
        shopDomain: `ra02-${suffix}.myshopify.com`,
        encryptedCredentials: encryptShopifyCredentials(
          { accessToken: 'shpat_ra02', scopes: ['read_orders'] },
          encryptionKey,
        ) as unknown as object,
        configuration: { activeSyncRunId: runA, initialSyncStatus: 'SYNCING' },
      },
    });
    const fetchStarted = deferred<void>();
    const resumeFetch = deferred<void>();
    const staleFetch = jest.fn(async () => {
      fetchStarted.resolve();
      await resumeFetch.promise;
      return shopifyResponse(orderNumber, '10.00', 'UNFULFILLED', true);
    });
    const staleExecution = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: staleFetch as unknown as typeof fetch,
    }).execute({
      jobId: runA,
      organizationId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id, syncRunId: runA },
      attemptNumber: 1,
      workerId: 'ra02-shopify-a',
    });

    await fetchStarted.promise;
    await activateRunWithRowLock(integration.id, runB);
    resumeFetch.resolve();
    const staleResult = await staleExecution;

    expect(staleResult.currentRun).toBe(false);
    expect(
      await prisma.externalOrder.count({ where: { organizationId, externalOrderNumber: orderNumber } }),
    ).toBe(0);
    expect(await prisma.job.count({ where: { organizationId } })).toBe(0);
    const afterStale = await prisma.integration.findUniqueOrThrow({
      where: { id: integration.id },
    });
    expect((afterStale.configuration as Record<string, unknown>).activeSyncRunId).toBe(runB);
    expect((afterStale.configuration as Record<string, unknown>).initialSyncStatus).toBe('SYNCING');

    const currentResult = await new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: jest.fn(async () =>
        shopifyResponse(orderNumber, '99.00', 'FULFILLED'),
      ) as unknown as typeof fetch,
    }).execute({
      jobId: runB,
      organizationId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id, syncRunId: runB },
      attemptNumber: 1,
      workerId: 'ra02-shopify-b',
    });
    const finalOrder = await prisma.externalOrder.findUniqueOrThrow({
      where: {
        organizationId_externalOrderNumber: { organizationId, externalOrderNumber: orderNumber },
      },
    });
    expect(currentResult.currentRun).toBe(true);
    expect(Number(finalOrder.totalAmount)).toBe(99);
    expect(finalOrder.status).toBe('SHIPPED');
  });

  it('prevents a superseded ShipStation run from projecting after the newer run activates', async () => {
    const runA = randomUUID();
    const runB = randomUUID();
    const orderNumber = `RA02-SS-${suffix}`;
    const integration = await prisma.integration.create({
      data: {
        organizationId,
        provider: 'SHIPSTATION',
        name: `RA-02 ShipStation ${suffix}`,
        status: 'CONNECTED',
        encryptedCredentials: encryptShipStationCredentials(
          { apiKey: 'ra02_shipstation_key' },
          encryptionKey,
        ) as unknown as object,
        configuration: { activeSyncRunId: runA, initialSyncStatus: 'SYNCING' },
      },
    });
    const fetchStarted = deferred<void>();
    const resumeFetch = deferred<void>();
    const staleFetch = shipStationFetch(orderNumber, 'A', fetchStarted, resumeFetch, 2);
    const staleExecution = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: staleFetch,
    }).execute({
      jobId: runA,
      organizationId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id, syncRunId: runA },
      attemptNumber: 1,
      workerId: 'ra02-shipstation-a',
    });

    await fetchStarted.promise;
    await activateRunWithRowLock(integration.id, runB);
    resumeFetch.resolve();
    const staleResult = await staleExecution;

    expect(staleResult.currentRun).toBe(false);
    expect(
      await prisma.externalOrder.count({ where: { organizationId, externalOrderNumber: orderNumber } }),
    ).toBe(0);
    expect(await prisma.externalReference.count({ where: { integrationId: integration.id } })).toBe(
      0,
    );
    expect(await prisma.job.count({ where: { organizationId } })).toBe(0);
    const afterStale = await prisma.integration.findUniqueOrThrow({
      where: { id: integration.id },
    });
    expect((afterStale.configuration as Record<string, unknown>).activeSyncRunId).toBe(runB);
    expect((afterStale.configuration as Record<string, unknown>).initialSyncStatus).toBe('SYNCING');

    const currentResult = await new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: shipStationFetch(orderNumber, 'B'),
    }).execute({
      jobId: runB,
      organizationId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id, syncRunId: runB },
      attemptNumber: 1,
      workerId: 'ra02-shipstation-b',
    });
    const finalReference = await prisma.externalReference.findFirstOrThrow({
      where: { integrationId: integration.id, resourceType: 'SHIPMENT' },
    });
    expect(currentResult.currentRun).toBe(true);
    expect(finalReference.externalReference).toBe('SHIP-B');
  });

  it('serializes newer activation behind a legitimate projection and rejects later stale writes', async () => {
    const runA = randomUUID();
    const runB = randomUUID();
    const integration = await prisma.integration.create({
      data: {
        organizationId,
        provider: 'SHOPIFY',
        name: `RA-02 lock ordering ${suffix}`,
        status: 'CONNECTED',
        shopDomain: `ra02-lock-${suffix}.myshopify.com`,
        configuration: { activeSyncRunId: runA, initialSyncStatus: 'SYNCING' },
      },
    });
    const projectionEntered = deferred<void>();
    const releaseProjection = deferred<void>();
    const ordering: string[] = [];
    const projection = withCurrentSyncRunTransaction(
      prisma,
      integration.id,
      runA,
      async (tx) => {
        await tx.externalOrder.create({
          data: {
            organizationId,
            primaryIntegrationId: integration.id,
            externalOrderNumber: `RA02-LOCK-${suffix}`,
            status: 'PENDING',
          },
        });
        projectionEntered.resolve();
        await releaseProjection.promise;
      },
    ).then((result) => {
      ordering.push('run-a-committed');
      return result;
    });

    await projectionEntered.promise;
    const activation = activateRunWithRowLock(integration.id, runB).then(() => {
      ordering.push('run-b-active');
    });
    releaseProjection.resolve();
    const [projectionResult] = await Promise.all([projection, activation]);

    expect(projectionResult.current).toBe(true);
    expect(ordering).toEqual(['run-a-committed', 'run-b-active']);
    let staleWorkInvoked = false;
    const staleAttempt = await withCurrentSyncRunTransaction(
      prisma,
      integration.id,
      runA,
      async () => {
        staleWorkInvoked = true;
      },
    );
    expect(staleAttempt.current).toBe(false);
    expect(staleWorkInvoked).toBe(false);
  });

  async function activateRunWithRowLock(integrationId: string, syncRunId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM integrations WHERE id = ${integrationId}::uuid FOR UPDATE`,
      );
      const integration = await tx.integration.findUniqueOrThrow({ where: { id: integrationId } });
      await tx.integration.update({
        where: { id: integrationId },
        data: {
          configuration: {
            ...((integration.configuration as Record<string, unknown>) || {}),
            activeSyncRunId: syncRunId,
            initialSyncStatus: 'SYNCING',
          },
        },
      });
    });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function shopifyResponse(
  orderNumber: string,
  amount: string,
  status: string,
  hasNextPage = false,
): Response {
  return new Response(
    JSON.stringify({
      data: {
        orders: {
          edges: [
            {
              cursor: `cursor-${orderNumber}`,
              node: {
                id: `gid://shopify/Order/${orderNumber}`,
                name: `#${orderNumber}`,
                createdAt: '2026-09-20T00:00:00Z',
                displayFinancialStatus: 'PAID',
                displayFulfillmentStatus: status,
                totalPriceSet: { shopMoney: { amount, currencyCode: 'USD' } },
                fulfillments: [],
              },
            },
          ],
          pageInfo: {
            hasNextPage,
            endCursor: hasNextPage ? `cursor-${orderNumber}` : null,
          },
        },
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function shipStationFetch(
  orderNumber: string,
  version: string,
  fetchStarted?: ReturnType<typeof deferred<void>>,
  resumeFetch?: ReturnType<typeof deferred<void>>,
  pages = 1,
): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/v2/labels')) {
      return new Response(JSON.stringify({ labels: [], total: 0, page: 1, pages: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    fetchStarted?.resolve();
    if (resumeFetch) await resumeFetch.promise;
    return new Response(
      JSON.stringify({
        shipments: [
          {
            shipment_id: `shipment-${version}`,
            shipment_number: `SHIP-${version}`,
            order_number: orderNumber,
            shipment_status: 'label_purchased',
            created_at: '2026-09-20T00:00:00Z',
            modified_at: '2026-09-20T00:05:00Z',
          },
        ],
        total: 1,
        page: 1,
        pages,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
}
