import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  PrismaClient,
  JobStatus,
  JobAttemptStatus,
  JobErrorCategory,
} from '@prisma/client';
import {
  encryptCredentials,
  ShopifyClient,
  ShopifyClientError,
  ShopifyRateLimitError,
} from '@reloop/connector-shopify';
import { StoredShopifyCredential } from '@reloop/integration-sdk';
import { JobExecutorRegistry, JobContext } from '../src/executor';
import { ShopifySyncJobExecutor } from '../src/shopify-sync-executor';
import { JobExecutionError } from '../src/errors';
import { JobClaimService } from '../src/job-claim';
import { StaleMessageRecoveryService } from '../src/stale-message-recovery';
import { loadWorkerConfig } from '../src/config';
import Redis from 'ioredis';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:reloop_app_dev_password@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Day 15: Worker Durable ShopifySyncJobExecutor & Durability Guarantees', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let testOrgId: string;
  let runId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
    redis = new Redis(redisUrl);
  });

  afterAll(async () => {
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(async () => {
    runId = Math.random().toString(36).substring(2, 9);
    const org = await prisma.organization.create({
      data: {
        name: `Shopify Worker Org ${runId}`,
        slug: `shopify-worker-org-${runId}`,
      },
    });
    testOrgId = org.id;
  });

  function createMockShopifyFetch(options?: {
    orders?: any[];
    failCount?: number;
    failStatus?: number;
  }) {
    let callCount = 0;
    const orders = options?.orders || [
      {
        id: 'gid://shopify/Order/1001',
        name: '#1001',
        createdAt: '2026-09-20T00:00:00Z',
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'UNFULFILLED',
        totalPriceSet: {
          shopMoney: {
            amount: '120.00',
            currencyCode: 'USD',
          },
        },
        fulfillments: [],
      },
      {
        id: 'gid://shopify/Order/1002',
        name: '#1002',
        createdAt: '2026-09-20T00:05:00Z',
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'FULFILLED',
        totalPriceSet: {
          shopMoney: {
            amount: '75.50',
            currencyCode: 'USD',
          },
        },
        fulfillments: [
          {
            id: 'gid://shopify/Fulfillment/2001',
            status: 'SUCCESS',
            trackingInfo: [{ number: 'TRACK-WORKER-99' }],
          },
        ],
      },
    ];

    return jest.fn(async (url: any, init?: any) => {
      callCount++;
      if (options?.failCount && callCount <= options.failCount) {
        return new Response(JSON.stringify({ error: 'Shopify upstream failure' }), {
          status: options.failStatus || 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const bodyStr = init?.body ? String(init.body) : '';

      // Refresh token call
      if (url.includes('/admin/oauth/access_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'shpat_refreshed_worker_token',
            expires_in: 86400,
            refresh_token: 'shprt_new_worker_refresh',
            refresh_token_expires_in: 7776000,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Read-only GraphQL call
      return new Response(
        JSON.stringify({
          data: {
            orders: {
              edges: orders.map((o) => ({ node: o, cursor: `cursor_${o.id}` })),
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
  }

  async function createTestIntegration(shopDomain = `worker-${runId}.myshopify.com`) {
    const creds: StoredShopifyCredential = {
      accessToken: 'shpat_worker_test_token',
      refreshToken: 'shprt_worker_test_refresh',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      accessTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 7776000000).toISOString(),
      scope: 'read_orders',
    };

    const encrypted = encryptCredentials(creds, encryptionKey);

    return await prisma.integration.create({
      data: {
        organizationId: testOrgId,
        provider: 'SHOPIFY',
        name: `Shopify Worker Test ${runId}`,
        status: 'CONNECTED',
        mode: 'OBSERVE',
        shopDomain,
        encryptedCredentials: encrypted as unknown as object,
        configuration: {
          initialSyncStatus: 'PENDING',
        },
      },
    });
  }

  it('1. Executes SHOPIFY_SYNC_ORDERS durably and projects ExternalOrders idempotently', async () => {
    const integration = await createTestIntegration();
    const mockFetch = createMockShopifyFetch();

    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      clientId: 'mock_client_id',
      clientSecret: 'mock_client_secret',
      fetchFn: mockFetch as any,
    });

    const context: JobContext = {
      jobId: crypto.randomUUID(),
      attemptNumber: 1,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id },
      workerId: 'worker-unit-1',
      organizationId: testOrgId,
    };

    const result = await executor.execute(context);

    expect(result.integrationId).toBe(integration.id);
    expect(result.totalOrdersSynced).toBe(2);
    expect(result.complete).toBe(true);

    // Verify database projection
    const orders = await prisma.externalOrder.findMany({
      where: { organizationId: testOrgId },
      orderBy: { externalOrderNumber: 'asc' },
    });
    expect(orders.length).toBe(2);
    expect(orders[0].externalOrderNumber).toBe('1001');
    expect(Number(orders[0].totalAmount)).toBe(120.0);
    expect(orders[1].externalOrderNumber).toBe('1002');
    expect(Number(orders[1].totalAmount)).toBe(75.5);

    // Verify external references
    const orderRefs = await prisma.externalReference.findMany({
      where: { organizationId: testOrgId, resourceType: 'ORDER' },
    });
    expect(orderRefs.length).toBe(2);

    const fulfillmentRefs = await prisma.externalReference.findMany({
      where: { organizationId: testOrgId, resourceType: 'FULFILLMENT' },
    });
    expect(fulfillmentRefs.length).toBe(1);
    expect(fulfillmentRefs[0].externalReference).toBe('TRACK-WORKER-99');

    // Verify integration configuration updated
    const updatedInt = await prisma.integration.findUnique({
      where: { id: integration.id },
    });
    const config = updatedInt?.configuration as Record<string, any>;
    expect(config.initialSyncStatus).toBe('COMPLETED');
    expect(config.lastSyncOrdersCount).toBe(2);

    // Idempotency: Run exact same sync a second time
    const result2 = await executor.execute(context);
    expect(result2.totalOrdersSynced).toBe(2);

    const ordersAfter = await prisma.externalOrder.findMany({
      where: { organizationId: testOrgId },
    });
    expect(ordersAfter.length).toBe(2); // Exactly 2 orders, zero duplicates
  });

  it('2. Read-only capability fence: only issues queries, zero mutations, cannot access Day 13 simulator mutations', async () => {
    const integration = await createTestIntegration();
    let queryBody = '';

    const mockFetch = jest.fn(async (_url: any, init?: any) => {
      const body = init?.body ? String(init.body) : '';
      if (body) queryBody = body;
      return new Response(
        JSON.stringify({
          data: {
            orders: {
              edges: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      clientId: 'mock_client_id',
      clientSecret: 'mock_client_secret',
      fetchFn: mockFetch as any,
    });

    await executor.execute({
      jobId: crypto.randomUUID(),
      attemptNumber: 1,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id },
      workerId: 'worker-unit-2',
      organizationId: testOrgId,
    });

    // Verification: The GraphQL body contains "query" and strictly zero "mutation"
    expect(queryBody).toContain('query');
    expect(queryBody.toLowerCase()).not.toContain('mutation');
    expect(queryBody).not.toContain('fulfillmentCreate');
    expect(queryBody).not.toContain('inventoryAdjust');

    // Verify that ShopifySyncJobExecutor has NO access to Day 13 SimulatorRecoveryActionAdapter
    expect((executor as any).recoveryActionExecutor).toBeUndefined();
    expect((executor as any).simulatorAdapter).toBeUndefined();
  });

  it('3. Section 6: Shopify sync retry on transient error (attempt 1 fails, attempt 2 succeeds)', async () => {
    const integration = await createTestIntegration();

    // 1 failure then success
    const mockFetch = createMockShopifyFetch({ failCount: 1, failStatus: 503 });

    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      clientId: 'mock_client_id',
      clientSecret: 'mock_client_secret',
      fetchFn: mockFetch as any,
    });

    const context: JobContext = {
      jobId: crypto.randomUUID(),
      attemptNumber: 1,
      type: 'SHOPIFY_SYNC_ORDERS',
      payload: { integrationId: integration.id },
      workerId: 'worker-unit-retry',
      organizationId: testOrgId,
    };

    // Attempt 1: Throws transient retryable JobExecutionError
    let thrownError: any = null;
    try {
      await executor.execute(context);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(JobExecutionError);
    expect(thrownError.retryable).toBe(true);
    expect(thrownError.category).toBe(JobErrorCategory.TRANSIENT);

    // Attempt 2: Executes successfully on retry
    const retryContext: JobContext = {
      ...context,
      attemptNumber: 2,
    };

    const result = await executor.execute(retryContext);
    expect(result.totalOrdersSynced).toBe(2);
    expect(result.complete).toBe(true);

    // Verify clean single set of records
    const orderCount = await prisma.externalOrder.count({
      where: { organizationId: testOrgId },
    });
    expect(orderCount).toBe(2);
  });

  it('4. Section 7: Worker crash while CLAIMED before execution -> safe recovery after lease expiry', async () => {
    const integration = await createTestIntegration();
    const mockFetch = createMockShopifyFetch();

    const crashedWorker = await prisma.worker.create({
      data: {
        workerKey: `crashed-worker-${runId}`,
        status: 'OFFLINE',
        lastHeartbeatAt: new Date(Date.now() - 60000),
      },
    });

    const recoveryWorker = await prisma.worker.create({
      data: {
        workerKey: `recovery-worker-${runId}`,
        status: 'ONLINE',
        lastHeartbeatAt: new Date(),
      },
    });

    // Setup real Job in PostgreSQL
    const job = await prisma.job.create({
      data: {
        organizationId: testOrgId,
        type: 'SHOPIFY_SYNC_ORDERS',
        status: JobStatus.CLAIMED,
        payload: { integrationId: integration.id },
        idempotencyKey: `crash_claimed_test_${runId}`,
        attemptCount: 1,
        maxAttempts: 3,
        claimedByWorkerId: crashedWorker.id,
        leaseExpiresAt: new Date(Date.now() - 5000), // Expired lease (crashed worker)
      },
    });

    // Create JobAttempt 1 for the crashed worker
    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        attemptNumber: 1,
        workerId: crashedWorker.id,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 6000),
      },
    });

    const claimService = new JobClaimService(prisma);

    // Simulate recovery worker executing recoverExpiredClaimedJob
    const recoverResult = await claimService.recoverExpiredClaimedJob(
      job.id,
      recoveryWorker.id,
      30000,
    );

    expect(recoverResult.recovered).toBe(true);
    expect(recoverResult.execute).toBe(true);
    expect(recoverResult.attemptNumber).toBe(2);

    // Transition to RUNNING before execution (per WorkerService execution pipeline)
    await claimService.transitionToRunning(job.id, recoveryWorker.id);

    // Execute sync using ShopifySyncJobExecutor on recovered job
    const executor = new ShopifySyncJobExecutor(prisma, {
      encryptionKey,
      clientId: 'mock_client_id',
      clientSecret: 'mock_client_secret',
      fetchFn: mockFetch as any,
    });

    const execResult = await executor.execute({
      jobId: job.id,
      attemptNumber: recoverResult.attemptNumber!,
      type: job.type,
      payload: job.payload,
      workerId: recoveryWorker.id,
      organizationId: testOrgId,
    });

    expect(execResult.totalOrdersSynced).toBe(2);

    // Mark succeeded
    await claimService.markJobSucceeded(
      job.id,
      recoverResult.attemptId!,
      recoveryWorker.id,
      150,
      execResult,
    );

    const finalJob = await prisma.job.findUnique({ where: { id: job.id } });
    expect(finalJob?.status).toBe(JobStatus.SUCCEEDED);

    const orders = await prisma.externalOrder.findMany({ where: { organizationId: testOrgId } });
    expect(orders.length).toBe(2); // No duplicate orders
  });

  it('5. Section 8: Worker crash while RUNNING boundary -> Day 9 generic safety blocks running job', async () => {
    const integration = await createTestIntegration();

    const crashedRunningWorker = await prisma.worker.create({
      data: {
        workerKey: `running-worker-${runId}`,
        status: 'OFFLINE',
        lastHeartbeatAt: new Date(Date.now() - 60000),
      },
    });

    // Create job stuck in RUNNING with expired lease
    const job = await prisma.job.create({
      data: {
        organizationId: testOrgId,
        type: 'SHOPIFY_SYNC_ORDERS',
        status: JobStatus.RUNNING,
        payload: { integrationId: integration.id },
        idempotencyKey: `crash_running_test_${runId}`,
        attemptCount: 1,
        maxAttempts: 3,
        claimedByWorkerId: crashedRunningWorker.id,
        leaseExpiresAt: new Date(Date.now() - 5000), // Expired lease
      },
    });

    await prisma.jobAttempt.create({
      data: {
        jobId: job.id,
        attemptNumber: 1,
        workerId: crashedRunningWorker.id,
        status: JobAttemptStatus.STARTED,
        startedAt: new Date(Date.now() - 6000),
      },
    });

    const claimService = new JobClaimService(prisma);

    // Day 9 generic safety rule: An expired RUNNING job is marked BLOCKED and attempt ABANDONED
    const recovered = await claimService.recoverExpiredRunningJob(job.id);
    expect(recovered).toBe(true);

    const updatedJob = await prisma.job.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe(JobStatus.BLOCKED);

    const attempt = await prisma.jobAttempt.findFirst({
      where: { jobId: job.id, attemptNumber: 1 },
    });
    expect(attempt?.status).toBe(JobAttemptStatus.ABANDONED);
  });
});
