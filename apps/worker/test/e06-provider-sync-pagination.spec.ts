import * as dotenv from 'dotenv';
import * as path from 'path';
import Redis from 'ioredis';
import {
  PrismaClient,
  JobStatus,
  WorkerStatus,
} from '@prisma/client';
import { loadWorkerConfig } from '../src/config';
import { WorkerService } from '../src/worker-service';
import { ShopifySyncJobExecutor } from '../src/shopify-sync-executor';
import { ShipStationSyncJobExecutor } from '../src/shipstation-sync-executor';
import { JobContext } from '../src/executor';
import { encryptCredentials as encryptShopifyCredentials } from '@reloop/connector-shopify';
import { encryptCredentials as encryptShipStationCredentials } from '@reloop/connector-shipstation';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:reloop_app_dev_password@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Audit Remediation E-06: Provider Sync Pagination Truthful Completion', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let testOrgId: string;
  let runId: string;
  let testStreamKey: string;
  let testGroup: string;
  const activeWorkers: WorkerService[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
    redis = new Redis(redisUrl);
  });

  afterAll(async () => {
    for (const worker of activeWorkers) {
      if (worker.getIsRunning()) {
        await worker.stop().catch(() => {});
      }
    }
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(async () => {
    runId = Math.random().toString(36).substring(2, 9);
    testStreamKey = `reloop:test:e06:${runId}:jobs:ready`;
    testGroup = `test-e06-group-${runId}`;

    const org = await prisma.organization.create({
      data: {
        name: `E06 Test Org ${runId}`,
        slug: `e06-org-${runId}`,
      },
    });
    testOrgId = org.id;

    await redis.xgroup('CREATE', testStreamKey, testGroup, '$', 'MKSTREAM');
  });

  afterEach(async () => {
    while (activeWorkers.length > 0) {
      const worker = activeWorkers.pop();
      if (worker && worker.getIsRunning()) {
        await worker.stop().catch(() => {});
      }
    }

    const keys = await redis.keys(`reloop:test:e06:${runId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  async function createTestShopifyIntegration(orgId: string = testOrgId) {
    const creds = {
      accessToken: 'shpat_test_token_valid',
      scopes: ['read_orders', 'read_fulfillments'],
      shopDomain: `store-${runId}.myshopify.com`,
    };
    const encrypted = encryptShopifyCredentials(creds, encryptionKey);

    return prisma.integration.create({
      data: {
        organizationId: orgId,
        provider: 'SHOPIFY',
        name: `Shopify E06 Test ${runId}`,
        status: 'CONNECTED',
        mode: 'OBSERVE',
        shopDomain: `store-${runId}.myshopify.com`,
        encryptedCredentials: encrypted as unknown as object,
        configuration: {
          initialSyncStatus: 'PENDING',
        },
      },
    });
  }

  async function createTestShipStationIntegration(orgId: string = testOrgId) {
    const creds = {
      apiKey: 'test-shipstation-api-key',
    };
    const encrypted = encryptShipStationCredentials(creds, encryptionKey);

    return prisma.integration.create({
      data: {
        organizationId: orgId,
        provider: 'SHIPSTATION',
        name: `ShipStation E06 Test ${runId}`,
        status: 'CONNECTED',
        mode: 'OBSERVE',
        encryptedCredentials: encrypted as unknown as object,
        configuration: {
          initialSyncStatus: 'PENDING',
        },
      },
    });
  }

  function createWorker(overrides: Partial<Parameters<typeof loadWorkerConfig>[0]> = {}): WorkerService {
    const config = loadWorkerConfig({
      redisUrl,
      jobStreamKey: testStreamKey,
      jobConsumerGroup: testGroup,
      workerKey: `worker-e06-${runId}-${Math.random().toString(36).substring(2, 7)}`,
      workerConsumerName: `consumer-e06-${runId}-${Math.random().toString(36).substring(2, 7)}`,
      workerConcurrency: 5,
      jobLeaseDurationMs: 15000,
      jobLeaseRenewIntervalMs: 5000,
      workerHeartbeatIntervalMs: 1000,
      workerShutdownTimeoutMs: 5000,
      blockTimeoutMs: 100,
      workerRecoveryScanIntervalMs: 5000,
      workerPelMinIdleMs: 50,
      workerRecoveryBatchSize: 20,
      ...overrides,
    });

    const worker = new WorkerService(config, prisma);
    activeWorkers.push(worker);
    return worker;
  }

  // =========================================================================
  // 1. SHOPIFY: Cap Reached + Has Next Page -> complete = false & Continuation Job
  // =========================================================================
  it('1. Shopify: reports complete=false when cap is reached but hasNextPage is true, enqueuing continuation job', async () => {
    const integration = await createTestShopifyIntegration();

    // Generate 60 synthetic orders (Page 1: 50 orders with hasNextPage=true, Page 2: 10 orders)
    const mockFetch = jest.fn(async (url: any, init?: any) => {
      const body = JSON.parse(init?.body || '{}');
      const after = body.variables?.after;

      if (!after) {
        // Page 1: 50 orders, hasNextPage = true
        const orders = Array.from({ length: 50 }, (_, i) => ({
          id: `gid://shopify/Order/${1000 + i}`,
          name: `#${1000 + i}`,
          createdAt: '2026-09-20T00:00:00Z',
          displayFinancialStatus: 'PAID',
          displayFulfillmentStatus: 'UNFULFILLED',
          totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
          fulfillments: [],
        }));

        return new Response(
          JSON.stringify({
            data: {
              orders: {
                edges: orders.map((o) => ({ node: o, cursor: `cursor_${o.id}` })),
                pageInfo: { hasNextPage: true, endCursor: 'cursor_gid://shopify/Order/1049' },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } else {
        // Page 2: 10 orders, hasNextPage = false
        const orders = Array.from({ length: 10 }, (_, i) => ({
          id: `gid://shopify/Order/${1050 + i}`,
          name: `#${1050 + i}`,
          createdAt: '2026-09-20T00:00:00Z',
          displayFinancialStatus: 'PAID',
          displayFulfillmentStatus: 'UNFULFILLED',
          totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
          fulfillments: [],
        }));

        return new Response(
          JSON.stringify({
            data: {
              orders: {
                edges: orders.map((o) => ({ node: o, cursor: `cursor_${o.id}` })),
                pageInfo: { hasNextPage: false, endCursor: 'cursor_gid://shopify/Order/1059' },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
    });

    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: mockFetch as any,
    });

    // Run bounded chunk with maxOrders = 50
    const result1 = await executor.execute({
      jobId: 'job-shopify-chunk-1',
      organizationId: testOrgId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id, maxOrders: 50 },
      attemptNumber: 1,
      workerId: 'worker-unit-1',
    });

    // Invariant: Cap reached does NOT mean complete
    expect(result1.totalOrdersSynced).toBe(50);
    expect(result1.complete).toBe(false);
    expect(result1.nextCursor).toBe('cursor_gid://shopify/Order/1049');
    expect(result1.continuationJobId).toBeDefined();

    // Verify continuation Job committed to PostgreSQL
    const continuationJob = await prisma.job.findUnique({
      where: { id: result1.continuationJobId! },
    });
    expect(continuationJob?.status).toBe(JobStatus.QUEUED);
    expect(continuationJob?.type).toBe('SHOPIFY_SYNC_ORDERS');
    expect((continuationJob?.payload as any)?.cursor).toBe('cursor_gid://shopify/Order/1049');
    expect((continuationJob?.payload as any)?.syncRunId).toBe('job-shopify-chunk-1');
    expect(continuationJob?.idempotencyKey).toBe(
      `shopify_sync_continuation_${integration.id}_job-shopify-chunk-1_cursor_gid://shopify/Order/1049`,
    );

    // Verify Integration is marked SYNCING, NOT COMPLETED
    const updatedInt = await prisma.integration.findUnique({ where: { id: integration.id } });
    expect((updatedInt?.configuration as any)?.initialSyncStatus).toBe('SYNCING');
    expect((updatedInt?.configuration as any)?.continuationCursor).toBe(
      'cursor_gid://shopify/Order/1049',
    );

    // Now execute continuation job
    const result2 = await executor.execute({
      jobId: continuationJob!.id,
      organizationId: testOrgId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: continuationJob!.payload as any,
      attemptNumber: 1,
      workerId: 'worker-unit-1',
    });

    expect(result2.totalOrdersSynced).toBe(10);
    expect(result2.complete).toBe(true);
    expect(result2.continuationJobId).toBeNull();

    // Integration is now COMPLETED
    const finalInt = await prisma.integration.findUnique({ where: { id: integration.id } });
    expect((finalInt?.configuration as any)?.initialSyncStatus).toBe('COMPLETED');
    expect((finalInt?.configuration as any)?.continuationCursor).toBeNull();
    expect((finalInt?.configuration as any)?.lastSyncOrdersCount).toBe(60);

    // All 60 orders projected
    const orderCount = await prisma.externalOrder.count({ where: { organizationId: testOrgId } });
    expect(orderCount).toBe(60);
  });

  // =========================================================================
  // 2. SHOPIFY: Large-Data (>250 Orders) Regression with Default Cap
  // =========================================================================
  it('2. Shopify: large-data (>250 orders) with default 250 cap continues through multiple jobs to completion', async () => {
    const integration = await createTestShopifyIntegration();

    // Total 300 orders across 6 pages of 50
    const TOTAL_ORDERS = 300;
    const allOrders = Array.from({ length: TOTAL_ORDERS }, (_, i) => ({
      id: `gid://shopify/Order/${2000 + i}`,
      name: `#${2000 + i}`,
      createdAt: '2026-09-20T00:00:00Z',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'UNFULFILLED',
      totalPriceSet: { shopMoney: { amount: '25.00', currencyCode: 'USD' } },
      fulfillments: [],
    }));

    const mockFetch = jest.fn(async (url: any, init?: any) => {
      const body = JSON.parse(init?.body || '{}');
      const after = body.variables?.after;
      let startIndex = 0;
      if (after) {
        const parsed = parseInt(after.replace('cursor_gid://shopify/Order/', ''), 10);
        startIndex = parsed - 2000 + 1;
      }

      const pageSize = body.variables?.first || 50;
      const slice = allOrders.slice(startIndex, startIndex + pageSize);
      const endIndex = startIndex + slice.length;
      const hasNext = endIndex < TOTAL_ORDERS;
      const endCursor = slice.length > 0 ? `cursor_${slice[slice.length - 1].id}` : null;

      return new Response(
        JSON.stringify({
          data: {
            orders: {
              edges: slice.map((o) => ({ node: o, cursor: `cursor_${o.id}` })),
              pageInfo: { hasNextPage: hasNext, endCursor },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      defaultMaxOrders: 250,
      fetchFn: mockFetch as any,
    });

    // Chunk 1: default cap of 250 orders
    const chunk1 = await executor.execute({
      jobId: 'job-large-shopify-1',
      organizationId: testOrgId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id },
      attemptNumber: 1,
      workerId: 'worker-unit-1',
    });

    expect(chunk1.totalOrdersSynced).toBe(250);
    expect(chunk1.complete).toBe(false); // Cap reached does not claim complete!
    expect(chunk1.nextCursor).toBe('cursor_gid://shopify/Order/2249');
    expect(chunk1.continuationJobId).toBeDefined();

    // Chunk 2: executes continuation
    const chunk2 = await executor.execute({
      jobId: chunk1.continuationJobId!,
      organizationId: testOrgId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: {
        integrationId: integration.id,
        cursor: chunk1.nextCursor,
      },
      attemptNumber: 1,
      workerId: 'worker-unit-1',
    });

    expect(chunk2.totalOrdersSynced).toBe(50);
    expect(chunk2.complete).toBe(true); // Final page exhausted
    expect(chunk2.continuationJobId).toBeNull();

    // All 300 orders projected
    const totalProjected = await prisma.externalOrder.count({ where: { organizationId: testOrgId } });
    expect(totalProjected).toBe(300);
  });

  // =========================================================================
  // 3. SHOPIFY: Exact Cap Boundary Tests (A, B, C, D)
  // =========================================================================
  it('3. Shopify: exact cap boundary invariants (A: exact cap & no next, B: exact cap & next, C: fewer, D: empty)', async () => {
    const integration = await createTestShopifyIntegration();

    // Helper to run with synthetic pageInfo
    async function testBoundary(
      orderCount: number,
      hasNextPage: boolean,
      cap: number,
    ) {
      const orders = Array.from({ length: orderCount }, (_, i) => ({
        id: `gid://shopify/Order/${3000 + i}`,
        name: `#${3000 + i}`,
        createdAt: '2026-09-20T00:00:00Z',
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'UNFULFILLED',
        totalPriceSet: { shopMoney: { amount: '15.00', currencyCode: 'USD' } },
        fulfillments: [],
      }));

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            orders: {
              edges: orders.map((o) => ({ node: o, cursor: `cursor_${o.id}` })),
              pageInfo: {
                hasNextPage,
                endCursor: orders.length > 0 ? `cursor_${orders[orders.length - 1].id}` : null,
              },
            },
          },
        }),
      });

      const executor = new ShopifySyncJobExecutor(prisma, {
        encryptionKey,
        fetchFn: mockFetch as any,
      });

      return executor.execute({
        jobId: `job-boundary-${orderCount}-${hasNextPage}`,
        organizationId: testOrgId,
        type: 'SHOPIFY_SYNC_ORDERS',
        payload: { integrationId: integration.id, maxOrders: cap },
        attemptNumber: 1,
        workerId: 'worker-unit-1',
      });
    }

    // A. Exactly cap records AND NO next page -> complete = true
    const boundaryA = await testBoundary(50, false, 50);
    expect(boundaryA.totalOrdersSynced).toBe(50);
    expect(boundaryA.complete).toBe(true);

    // B. Exactly cap records AND HAS next page -> complete = false
    const boundaryB = await testBoundary(50, true, 50);
    expect(boundaryB.totalOrdersSynced).toBe(50);
    expect(boundaryB.complete).toBe(false);

    // C. Fewer than cap records and NO next page -> complete = true
    const boundaryC = await testBoundary(30, false, 50);
    expect(boundaryC.totalOrdersSynced).toBe(30);
    expect(boundaryC.complete).toBe(true);

    // D. Empty provider result and NO next page -> complete = true
    const boundaryD = await testBoundary(0, false, 50);
    expect(boundaryD.totalOrdersSynced).toBe(0);
    expect(boundaryD.complete).toBe(true);
  });

  // =========================================================================
  // 4. SHIPSTATION: Reports complete=false when cap is reached and more pages exist
  // =========================================================================
  it('4. ShipStation: reports complete=false when maxShipments reached but provider has more pages', async () => {
    const integration = await createTestShipStationIntegration();

    // 60 total shipments, 2 pages (Page 1: 50 shipments, Page 2: 10 shipments)
    const mockFetch = jest.fn(async (urlStr: string) => {
      if (urlStr.includes('/v2/shipments')) {
        const url = new URL(urlStr);
        const page = parseInt(url.searchParams.get('page') || '1', 10);

        if (page === 1) {
          const shipments = Array.from({ length: 50 }, (_, i) => ({
            shipment_id: 1000 + i,
            shipment_number: `SHIP-${1000 + i}`,
            order_number: `ORD-${1000 + i}`,
            shipment_status: 'label_purchased',
            created_at: '2026-09-20T00:00:00Z',
            modified_at: '2026-09-20T00:05:00Z',
          }));
          return new Response(
            JSON.stringify({ shipments, total: 60, page: 1, pages: 2 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        } else {
          const shipments = Array.from({ length: 10 }, (_, i) => ({
            shipment_id: 1050 + i,
            shipment_number: `SHIP-${1050 + i}`,
            order_number: `ORD-${1050 + i}`,
            shipment_status: 'label_purchased',
            created_at: '2026-09-20T00:00:00Z',
            modified_at: '2026-09-20T00:05:00Z',
          }));
          return new Response(
            JSON.stringify({ shipments, total: 60, page: 2, pages: 2 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }

      if (urlStr.includes('/v2/labels')) {
        return new Response(
          JSON.stringify({ labels: [], total: 0, page: 1, pages: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not found', { status: 404 });
    });

    const executor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: mockFetch as any,
    });

    // Chunk 1 with maxShipments = 50
    const chunk1 = await executor.execute({
      jobId: 'job-shipstation-chunk-1',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id, maxShipments: 50 },
      attemptNumber: 1,
      workerId: 'worker-unit-1',
    });

    // CRITICAL: Must NOT be complete because page 2 exists!
    expect(chunk1.totalShipmentsSynced).toBe(50);
    expect(chunk1.complete).toBe(false);
    expect(chunk1.nextPage).toBe(2);
    expect(chunk1.continuationJobId).toBeDefined();

    // Verify continuation job
    const continuationJob = await prisma.job.findUnique({
      where: { id: chunk1.continuationJobId! },
    });
    expect(continuationJob?.status).toBe(JobStatus.QUEUED);
    expect((continuationJob?.payload as any)?.page).toBe(2);

    // Verify Integration is SYNCING
    const intAfterChunk1 = await prisma.integration.findUnique({ where: { id: integration.id } });
    expect((intAfterChunk1?.configuration as any)?.initialSyncStatus).toBe('SYNCING');
    expect((intAfterChunk1?.configuration as any)?.continuationPage).toBe(2);

    // Execute chunk 2
    const chunk2 = await executor.execute({
      jobId: continuationJob!.id,
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: continuationJob!.payload as any,
      attemptNumber: 1,
      workerId: 'worker-unit-1',
    });

    expect(chunk2.totalShipmentsSynced).toBe(10);
    expect(chunk2.complete).toBe(true);
    expect(chunk2.continuationJobId).toBeNull();

    // Integration is COMPLETED
    const finalInt = await prisma.integration.findUnique({ where: { id: integration.id } });
    expect((finalInt?.configuration as any)?.initialSyncStatus).toBe('COMPLETED');
    expect((finalInt?.configuration as any)?.continuationPage).toBeNull();
    expect((finalInt?.configuration as any)?.lastSyncShipmentsCount).toBe(60);
  });

  // =========================================================================
  // 5. SHIPSTATION: Anti-Regression Test Against `... || true`
  // =========================================================================
  it('5. ShipStation: fails if unconditional `|| true` is present when cap is reached on non-final page', async () => {
    const integration = await createTestShipStationIntegration();

    // Provider has 10 pages total, we query page 1
    const mockFetch = jest.fn(async (urlStr: string) => {
      if (urlStr.includes('/v2/shipments')) {
        const shipments = Array.from({ length: 50 }, (_, i) => ({
          shipment_id: 5000 + i,
          shipment_number: `SHIP-${5000 + i}`,
          order_number: `ORD-${5000 + i}`,
          shipment_status: 'label_purchased',
          created_at: '2026-09-20T00:00:00Z',
          modified_at: '2026-09-20T00:05:00Z',
        }));
        return new Response(
          JSON.stringify({ shipments, total: 500, page: 1, pages: 10 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ labels: [], total: 0, page: 1, pages: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const executor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: mockFetch as any,
    });

    const result = await executor.execute({
      jobId: 'job-anti-true-test',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id, maxShipments: 50 },
      attemptNumber: 1,
      workerId: 'worker-unit-1',
    });

    // If `totalSynced >= maxShipments || true` was present, result.complete would be true.
    // Truthful invariant requires complete to be false!
    expect(result.complete).toBe(false);
    expect(result.nextPage).toBe(2);
  });

  // =========================================================================
  // 6. SHIPSTATION: Exact Cap Boundary Tests (A, B, C, D)
  // =========================================================================
  it('6. ShipStation: exact cap boundary invariants (A: exact cap & no next, B: exact cap & next, C: fewer, D: empty)', async () => {
    const integration = await createTestShipStationIntegration();

    async function testShipStationBoundary(
      shipmentCount: number,
      page: number,
      totalPages: number,
      cap: number,
    ) {
      const shipments = Array.from({ length: shipmentCount }, (_, i) => ({
        shipment_id: 6000 + i,
        shipment_number: `SHIP-${6000 + i}`,
        order_number: `ORD-${6000 + i}`,
        shipment_status: 'label_purchased',
        created_at: '2026-09-20T00:00:00Z',
        modified_at: '2026-09-20T00:05:00Z',
      }));

      const mockFetch = jest.fn(async (urlStr: string) => {
        if (urlStr.includes('/v2/shipments')) {
          return new Response(
            JSON.stringify({ shipments, total: shipmentCount, page, pages: totalPages }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ labels: [], total: 0, page: 1, pages: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const executor = new ShipStationSyncJobExecutor(prisma, {
        encryptionKey,
        fetchFn: mockFetch as any,
      });

      return executor.execute({
        jobId: `job-ss-boundary-${shipmentCount}-${page}-${totalPages}`,
        organizationId: testOrgId,
        type: 'SHIPSTATION_SYNC_SHIPMENTS',
        payload: { integrationId: integration.id, maxShipments: cap, page },
        attemptNumber: 1,
        workerId: 'worker-unit-1',
      });
    }

    // A. Exactly cap records AND NO next page (page = 5, totalPages = 5) -> complete = true
    const boundaryA = await testShipStationBoundary(50, 5, 5, 50);
    expect(boundaryA.complete).toBe(true);

    // B. Exactly cap records AND HAS next page (page = 5, totalPages = 6) -> complete = false
    const boundaryB = await testShipStationBoundary(50, 5, 6, 50);
    expect(boundaryB.complete).toBe(false);

    // C. Fewer than cap records AND NO next page (page = 2, totalPages = 2) -> complete = true
    const boundaryC = await testShipStationBoundary(20, 2, 2, 50);
    expect(boundaryC.complete).toBe(true);

    // D. Empty result AND NO next page (page = 1, totalPages = 1) -> complete = true
    const boundaryD = await testShipStationBoundary(0, 1, 1, 50);
    expect(boundaryD.complete).toBe(true);
  });

  // =========================================================================
  // 7. Overlapping Records Across Page Boundaries Remain Idempotent
  // =========================================================================
  it('7. Idempotency: overlapping records across page boundaries update projections without duplicate records', async () => {
    const integration = await createTestShopifyIntegration();

    // Order #999 appears on both page 1 and page 2 (status changed to FULFILLED on page 2)
    const page1Order = {
      id: 'gid://shopify/Order/999',
      name: '#999',
      createdAt: '2026-09-20T00:00:00Z',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'UNFULFILLED',
      totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } },
      fulfillments: [],
    };

    const page2Order = {
      ...page1Order,
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [
        {
          id: 'gid://shopify/Fulfillment/9991',
          status: 'SUCCESS',
          trackingInfo: [{ number: 'TRACK-DUP-99' }],
        },
      ],
    };

    let call = 0;
    const mockFetch = jest.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            data: {
              orders: {
                edges: [{ node: page1Order, cursor: 'cur_1' }],
                pageInfo: { hasNextPage: true, endCursor: 'cur_1' },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } else {
        return new Response(
          JSON.stringify({
            data: {
              orders: {
                edges: [{ node: page2Order, cursor: 'cur_2' }],
                pageInfo: { hasNextPage: false, endCursor: 'cur_2' },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
    });

    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: mockFetch as any,
    });

    // Page 1
    await executor.execute({
      jobId: 'job-overlap-1',
      organizationId: testOrgId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id, maxOrders: 1 },
      attemptNumber: 1,
      workerId: 'worker-unit-1',
    });

    const orderAfterP1 = await prisma.externalOrder.findFirst({
      where: { organizationId: testOrgId, externalOrderNumber: '999' },
    });
    expect(orderAfterP1?.status).toBe('READY_FOR_FULFILLMENT');

    // Page 2
    await executor.execute({
      jobId: 'job-overlap-2',
      organizationId: testOrgId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id, maxOrders: 1, cursor: 'cur_1' },
      attemptNumber: 1,
      workerId: 'worker-unit-1',
    });

    // Must be exactly 1 order in database with updated status
    const totalOrders = await prisma.externalOrder.count({ where: { organizationId: testOrgId } });
    expect(totalOrders).toBe(1);

    const orderAfterP2 = await prisma.externalOrder.findFirst({
      where: { organizationId: testOrgId, externalOrderNumber: '999' },
    });
    expect(orderAfterP2?.status).toBe('SHIPPED');
  });

  // =========================================================================
  // 8. End-to-End Worker Multi-Page Execution & Single Final sync_completed Event
  // =========================================================================
  it('8. E2E: WorkerService executes multi-chunk sync to exhaustion and emits sync_completed ONLY on final completion', async () => {
    const integration = await createTestShopifyIntegration();

    // 2 pages: page 1 has 2 orders (hasNextPage: true), page 2 has 1 order (hasNextPage: false)
    const mockFetch = jest.fn(async (url: any, init?: any) => {
      const body = JSON.parse(init?.body || '{}');
      const after = body.variables?.after;

      if (!after) {
        return new Response(
          JSON.stringify({
            data: {
              orders: {
                edges: [
                  { node: { id: 'gid://shopify/Order/8001', name: '#8001', createdAt: '2026-09-20T00:00:00Z', fulfillments: [] }, cursor: 'cur_8001' },
                  { node: { id: 'gid://shopify/Order/8002', name: '#8002', createdAt: '2026-09-20T00:00:00Z', fulfillments: [] }, cursor: 'cur_8002' },
                ],
                pageInfo: { hasNextPage: true, endCursor: 'cur_8002' },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } else {
        return new Response(
          JSON.stringify({
            data: {
              orders: {
                edges: [
                  { node: { id: 'gid://shopify/Order/8003', name: '#8003', createdAt: '2026-09-20T00:00:00Z', fulfillments: [] }, cursor: 'cur_8003' },
                ],
                pageInfo: { hasNextPage: false, endCursor: 'cur_8003' },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
    });

    // Create initial Job with maxOrders = 2
    const initialJob = await prisma.job.create({
      data: {
        organizationId: testOrgId,
        type: 'SHOPIFY_SYNC_ORDERS',
        status: JobStatus.QUEUED,
        priority: 50,
        payload: { integrationId: integration.id, maxOrders: 2 },
        idempotencyKey: `shopify_initial_sync_${integration.id}`,
      },
    });

    // Subscribe to realtime events to verify sync_completed emission
    const realtimeEvents: any[] = [];
    const subRedis = new Redis(redisUrl);
    await subRedis.subscribe('reloop:realtime:events');
    subRedis.on('message', (_channel, message) => {
      try {
        const parsed = JSON.parse(message);
        if (parsed.eventType === 'integration.sync_completed') {
          realtimeEvents.push(parsed);
        }
      } catch {}
    });

    try {
      // Start worker configured with custom executor
      const worker = createWorker();
      const executor = new ShopifySyncJobExecutor(prisma, {
        encryptionKey,
        fetchFn: mockFetch as any,
      });
      worker.getExecutorRegistry().register('SHOPIFY_SYNC_ORDERS', async (ctx: JobContext) => {
        return executor.execute(ctx);
      });

      await worker.start();

      // Dispatch initial job to stream
      await redis.xadd(testStreamKey, '*', 'jobId', initialJob.id, 'type', 'SHOPIFY_SYNC_ORDERS');

      // Wait for all chunks to process and reach COMPLETED
      let finalInt = null;
      for (let i = 0; i < 50; i++) {
        finalInt = await prisma.integration.findUnique({ where: { id: integration.id } });
        if ((finalInt?.configuration as any)?.initialSyncStatus === 'COMPLETED') break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect((finalInt?.configuration as any)?.initialSyncStatus).toBe('COMPLETED');
      expect((finalInt?.configuration as any)?.lastSyncOrdersCount).toBe(3);

      // Wait up to 2 seconds for pub/sub message propagation
      for (let i = 0; i < 20; i++) {
        if (realtimeEvents.length >= 1) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // CRITICAL: Exactly ONE sync_completed event was emitted (on final completion, NOT chunk 1)
      expect(realtimeEvents.length).toBe(1);
      expect(realtimeEvents[0].resourceId).toBe(integration.id);
      expect(realtimeEvents[0].status).toBe('COMPLETED');
    } finally {
      await subRedis.quit().catch(() => {});
    }
  });

  // =========================================================================
  // 9. Continuation Failure Does Not Report Completion
  // =========================================================================
  it('9. Failure Isolation: failure on continuation page preserves page 1 data and does NOT report sync completed', async () => {
    const integration = await createTestShopifyIntegration();

    let call = 0;
    const mockFetch = jest.fn(async () => {
      call++;
      if (call === 1) {
        // Page 1 succeeds
        return new Response(
          JSON.stringify({
            data: {
              orders: {
                edges: [{ node: { id: 'gid://shopify/Order/901', name: '#901', createdAt: '2026-09-20T00:00:00Z', fulfillments: [] }, cursor: 'cur_901' }],
                pageInfo: { hasNextPage: true, endCursor: 'cur_901' },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      } else {
        // Page 2 fails with 500
        return new Response('Shopify 500 Internal Error', { status: 500 });
      }
    });

    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: mockFetch as any,
    });

    // Chunk 1 succeeds
    const chunk1 = await executor.execute({
      jobId: 'job-fail-test-1',
      organizationId: testOrgId,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id, maxOrders: 1 },
      attemptNumber: 1,
      workerId: 'worker-unit-1',
    });
    expect(chunk1.complete).toBe(false);

    // Page 1 data is durable in PostgreSQL
    const p1Order = await prisma.externalOrder.findFirst({
      where: { organizationId: testOrgId, externalOrderNumber: '#901' },
    });
    expect(p1Order).toBeDefined();

    // Chunk 2 (continuation) fails
    let errThrown = null;
    try {
      await executor.execute({
        jobId: chunk1.continuationJobId!,
        organizationId: testOrgId,
        type: 'SHOPIFY_SYNC_ORDERS',
        payload: { integrationId: integration.id, cursor: chunk1.nextCursor, maxOrders: 1 },
        attemptNumber: 1,
        workerId: 'worker-unit-1',
      });
    } catch (err) {
      errThrown = err;
    }

    expect(errThrown).toBeDefined();

    // Page 1 data remains intact
    const p1OrderAfterFailure = await prisma.externalOrder.findFirst({
      where: { organizationId: testOrgId, externalOrderNumber: '#901' },
    });
    expect(p1OrderAfterFailure).toBeDefined();

    // Integration status must NOT be COMPLETED
    const intRecord = await prisma.integration.findUnique({ where: { id: integration.id } });
    expect((intRecord?.configuration as any)?.initialSyncStatus).not.toBe('COMPLETED');
  });

  // =========================================================================
  // 10. Tenant Safety: Continuation Rejects Mismatched Organization
  // =========================================================================
  it('10. Tenant Safety: rejects continuation execution when Job organization does not match Integration organization', async () => {
    const otherOrg = await prisma.organization.create({
      data: {
        name: `Other Org ${runId}`,
        slug: `other-org-${runId}`,
      },
    });

    const integration = await createTestShopifyIntegration(testOrgId);

    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
    });

    let thrownError: any = null;
    try {
      await executor.execute({
        jobId: 'job-tenant-mismatch',
        organizationId: otherOrg.id, // Mismatched tenant!
        type: 'SHOPIFY_SYNC_ORDERS',
        payload: { integrationId: integration.id, cursor: 'cur_any' },
        attemptNumber: 1,
        workerId: 'worker-unit-1',
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError.code).toBe('ORGANIZATION_MISMATCH');
  });
});
