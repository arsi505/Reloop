import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  PrismaClient,
  JobErrorCategory,
} from '@prisma/client';
import {
  encryptCredentials,
  ShipStationRawShipment,
  ShipStationRawLabel,
} from '@reloop/connector-shipstation';
import { StoredShipStationCredential } from '@reloop/integration-sdk';
import { JobContext } from '../src/executor';
import { ShipStationSyncJobExecutor } from '../src/shipstation-sync-executor';
import { JobExecutionError } from '../src/errors';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:reloop_app_dev_password@localhost:5433/reloop_test?schema=public';
const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Worker Durable ShipStationSyncJobExecutor', () => {
  let prisma: PrismaClient;
  let testOrgId: string;
  let runId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(async () => {
    runId = Math.random().toString(36).substring(2, 9);
    const org = await prisma.organization.create({
      data: {
        name: `ShipStation Worker Org ${runId}`,
        slug: `shipstation-worker-org-${runId}`,
      },
    });
    testOrgId = org.id;
  });

  function createMockShipStationFetch(options?: {
    shipments?: ShipStationRawShipment[];
    labels?: ShipStationRawLabel[];
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
  }) {
    const shipments = options?.shipments || [
      {
        shipment_id: 'ss-1001',
        shipment_number: 'SHIP-1001',
        external_order_id: '#1001',
        order_number: '1001',
        shipment_status: 'label_purchased',
        carrier_code: 'usps',
        service_code: 'usps_priority',
        ship_date: '2026-09-20T10:00:00Z',
        created_at: '2026-09-20T08:00:00Z',
        modified_at: '2026-09-20T09:30:00Z',
      },
    ];

    const labels = options?.labels || [
      {
        label_id: 'lbl-5001',
        shipment_id: 'ss-1001',
        tracking_number: '9400111899562537624123',
        carrier_code: 'usps',
        service_code: 'usps_priority',
        status: 'completed',
        voided: false,
        tracking_status: 'in_transit',
        created_at: '2026-09-20T09:00:00Z',
      },
    ];

    const mockFetch: typeof fetch = async (input: any) => {
      const urlStr = String(input);
      if (options?.status && options.status !== 200) {
        return new Response(JSON.stringify({ message: options.statusText || 'Error' }), {
          status: options.status,
          headers: options.headers || { 'Content-Type': 'application/json' },
        });
      }

      if (urlStr.includes('/v2/labels')) {
        return new Response(
          JSON.stringify({
            labels,
            total: labels.length,
            page: 1,
            pages: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/v2/shipments')) {
        return new Response(
          JSON.stringify({
            shipments,
            total: shipments.length,
            page: 1,
            pages: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not found', { status: 404 });
    };

    return mockFetch;
  }

  it('1. Executes SHIPSTATION_SYNC_SHIPMENTS durably and projects ExternalReferences idempotently', async () => {
    // 1. Setup Integration with encrypted credentials
    const creds: StoredShipStationCredential = {
      apiKey: 'valid_test_api_key',
      keyId: 'v1',
      validatedAt: new Date().toISOString(),
    };
    const encrypted = encryptCredentials(creds, encryptionKey);

    const integration = await prisma.integration.create({
      data: {
        organizationId: testOrgId,
        provider: 'SHIPSTATION',
        name: 'ShipStation Main',
        status: 'CONNECTED',
        mode: 'OBSERVE',
        encryptedCredentials: encrypted as unknown as object,
        configuration: { initialSyncStatus: 'PENDING' },
      },
    });

    const mockFetch = createMockShipStationFetch();
    const executor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: mockFetch,
    });

    const context: JobContext = {
      jobId: 'job-1',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id },
      attemptNumber: 1,
      workerId: 'test-worker-1',
    };

    // Execute first time
    const result1 = await executor.execute(context);
    expect(result1.totalShipmentsSynced).toBe(1);
    expect(result1.complete).toBe(true);
    expect(result1.watermarkAdvancedTo).toBeDefined();

    // Verify database state: ExternalReference created for SHIPMENT
    const shipmentRef = await prisma.externalReference.findFirst({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'SHIPMENT',
        externalId: 'ss-1001',
      },
      include: { externalOrder: true },
    });
    expect(shipmentRef).toBeDefined();
    expect(shipmentRef?.externalReference).toBe('SHIP-1001');
    expect(shipmentRef?.externalOrder.externalOrderNumber).toBe('1001');

    // CRITICAL: label_purchased is NOT SHIPPED
    expect(shipmentRef?.externalOrder.status).not.toBe('SHIPPED');
    expect(shipmentRef?.externalOrder.status).toBe('FULFILLING');

    // Verify LABEL reference created
    const labelRef = await prisma.externalReference.findFirst({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'LABEL',
        externalId: 'lbl-5001',
      },
    });
    expect(labelRef).toBeDefined();
    expect(labelRef?.externalReference).toContain('9400111899562537624123');

    // Tracking reference comes from authoritative Label
    const trackingRef = await prisma.externalReference.findFirst({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'TRACKING',
        externalId: '9400111899562537624123',
      },
    });
    expect(trackingRef).toBeDefined();
    expect(trackingRef?.externalReference).toBe('usps');

    // Execute second time (idempotency check)
    const result2 = await executor.execute(context);
    expect(result2.totalShipmentsSynced).toBe(1);

    // Ensure no duplicate references were created
    const refCount = await prisma.externalReference.count({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'SHIPMENT',
        externalId: 'ss-1001',
      },
    });
    expect(refCount).toBe(1);

    // Verify integration configuration updated with checkpoint watermark
    const updatedInt = await prisma.integration.findUnique({ where: { id: integration.id } });
    const config = updatedInt?.configuration as Record<string, any>;
    expect(config.initialSyncStatus).toBe('COMPLETED');
    expect(config.lastSyncShipmentsCount).toBe(1);
    expect(config.lastSuccessfulSyncWatermark).toBe('2026-09-20T09:30:00.000Z');
  });

  it('2. Voided label does NOT project a TRACKING ExternalReference', async () => {
    const creds: StoredShipStationCredential = { apiKey: 'valid_key_void', keyId: 'v1' };
    const integration = await prisma.integration.create({
      data: {
        organizationId: testOrgId,
        provider: 'SHIPSTATION',
        name: 'ShipStation Void Test',
        status: 'CONNECTED',
        encryptedCredentials: encryptCredentials(creds, encryptionKey) as unknown as object,
        configuration: {},
      },
    });

    const mockFetch = createMockShipStationFetch({
      labels: [
        {
          label_id: 'lbl-void-1',
          shipment_id: 'ss-1001',
          tracking_number: '9400000000000000000000',
          carrier_code: 'usps',
          status: 'voided',
          voided: true,
          created_at: '2026-09-20T09:00:00Z',
        },
      ],
    });

    const executor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: mockFetch,
    });

    await executor.execute({
      jobId: 'job-void',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id },
      attemptNumber: 1,
      workerId: 'test-worker-1',
    });

    // LABEL reference exists
    const labelRef = await prisma.externalReference.findFirst({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'LABEL',
        externalId: 'lbl-void-1',
      },
    });
    expect(labelRef).toBeDefined();

    // CRITICAL: TRACKING reference must NOT exist for a voided label!
    const trackingRef = await prisma.externalReference.findFirst({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'TRACKING',
        externalId: '9400000000000000000000',
      },
    });
    expect(trackingRef).toBeNull();
  });

  it('3. Checkpoint advances ONLY after successful window and survives restart', async () => {
    const creds: StoredShipStationCredential = { apiKey: 'valid_key_ckpt', keyId: 'v1' };
    const initialWatermark = '2026-09-20T07:00:00.000Z';

    const integration = await prisma.integration.create({
      data: {
        organizationId: testOrgId,
        provider: 'SHIPSTATION',
        name: 'ShipStation Checkpoint Test',
        status: 'CONNECTED',
        encryptedCredentials: encryptCredentials(creds, encryptionKey) as unknown as object,
        configuration: {
          lastSuccessfulSyncWatermark: initialWatermark,
        },
      },
    });

    // Failing fetch to simulate failure during sync window
    const failingFetch = createMockShipStationFetch({
      status: 500,
      statusText: 'Internal Error',
    });

    const failingExecutor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: failingFetch,
    });

    try {
      await failingExecutor.execute({
        jobId: 'job-fail-ckpt',
        organizationId: testOrgId,
        type: 'SHIPSTATION_SYNC_SHIPMENTS',
        payload: { integrationId: integration.id },
        attemptNumber: 1,
        workerId: 'test-worker-1',
      });
      fail('Should have failed');
    } catch (err) {
      // Expected failure
    }

    // Verify watermark did NOT advance past unprocessed data
    const afterFail = await prisma.integration.findUnique({ where: { id: integration.id } });
    const configAfterFail = afterFail?.configuration as Record<string, any>;
    expect(configAfterFail.lastSuccessfulSyncWatermark).toBe(initialWatermark);

    // Now execute with succeeding fetch (simulating worker restart after crash)
    const succeedingFetch = createMockShipStationFetch({
      shipments: [
        {
          shipment_id: 'ss-2001',
          shipment_number: 'SHIP-2001',
          order_number: '2001',
          shipment_status: 'label_purchased',
          created_at: '2026-09-20T08:00:00Z',
          modified_at: '2026-09-20T08:45:00Z',
        },
      ],
    });

    const restartedExecutor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: succeedingFetch,
    });

    await restartedExecutor.execute({
      jobId: 'job-success-restart',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id },
      attemptNumber: 1,
      workerId: 'test-worker-2',
    });

    // Watermark advances now that processing succeeded
    const afterSuccess = await prisma.integration.findUnique({ where: { id: integration.id } });
    const configAfterSuccess = afterSuccess?.configuration as Record<string, any>;
    expect(configAfterSuccess.lastSuccessfulSyncWatermark).toBe('2026-09-20T08:45:00.000Z');
  });

  it('4. Out-of-order shipment state fence prevents regressing newer state', async () => {
    const creds: StoredShipStationCredential = { apiKey: 'valid_key_fence', keyId: 'v1' };
    const integration = await prisma.integration.create({
      data: {
        organizationId: testOrgId,
        provider: 'SHIPSTATION',
        name: 'ShipStation Fence Test',
        status: 'CONNECTED',
        encryptedCredentials: encryptCredentials(creds, encryptionKey) as unknown as object,
        configuration: {},
      },
    });

    // Create an already-newer external order at T2
    const newerTime = new Date('2026-09-20T12:00:00Z');
    await prisma.externalOrder.create({
      data: {
        organizationId: testOrgId,
        primaryIntegrationId: integration.id,
        externalOrderNumber: '3001',
        status: 'DELIVERED', // Manually delivered or newer state
        lastObservedAt: newerTime,
      },
    });

    // Incoming shipment at older T1 (09:00:00Z)
    const olderFetch = createMockShipStationFetch({
      shipments: [
        {
          shipment_id: 'ss-3001',
          shipment_number: 'SHIP-3001',
          order_number: '3001',
          shipment_status: 'label_purchased',
          created_at: '2026-09-20T08:00:00Z',
          modified_at: '2026-09-20T09:00:00Z', // Older than 12:00:00Z!
        },
      ],
    });

    const executor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: olderFetch,
    });

    await executor.execute({
      jobId: 'job-fence',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id },
      attemptNumber: 1,
      workerId: 'test-worker-1',
    });

    // Verify order status did NOT regress to FULFILLING
    const order = await prisma.externalOrder.findFirst({
      where: { organizationId: testOrgId, externalOrderNumber: '3001' },
    });
    expect(order?.status).toBe('DELIVERED');
    expect(order?.lastObservedAt).toEqual(newerTime);
  });

  it('5. Correctly classifies ShipStation 429 rate limit as retryable with delay', async () => {
    const creds: StoredShipStationCredential = { apiKey: 'key_429', keyId: 'v1' };
    const integration = await prisma.integration.create({
      data: {
        organizationId: testOrgId,
        provider: 'SHIPSTATION',
        name: 'ShipStation 429',
        status: 'CONNECTED',
        encryptedCredentials: encryptCredentials(creds, encryptionKey) as unknown as object,
      },
    });

    const mockFetch = createMockShipStationFetch({
      status: 429,
      statusText: 'Rate Limit',
      headers: { 'retry-after': '8' },
    });

    const executor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: mockFetch,
    });

    const context: JobContext = {
      jobId: 'job-429',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id },
      attemptNumber: 1,
      workerId: 'test-worker-1',
    };

    try {
      await executor.execute(context);
      fail('Should have thrown JobExecutionError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(JobExecutionError);
      expect(err.category).toBe(JobErrorCategory.RATE_LIMITED);
      expect(err.code).toBe('SHIPSTATION_RATE_LIMIT');
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBe(8000);
    }
  });

  it('6. Rejects execution if organization does not match job context (Tenant Isolation)', async () => {
    const otherOrg = await prisma.organization.create({
      data: { name: 'Other Org SS', slug: `other-org-ss-${runId}` },
    });

    const creds: StoredShipStationCredential = { apiKey: 'key_other', keyId: 'v1' };
    const integration = await prisma.integration.create({
      data: {
        organizationId: otherOrg.id,
        provider: 'SHIPSTATION',
        name: 'ShipStation Other',
        status: 'CONNECTED',
        encryptedCredentials: encryptCredentials(creds, encryptionKey) as unknown as object,
      },
    });

    const executor = new ShipStationSyncJobExecutor(prisma, { encryptionKey });

    const context: JobContext = {
      jobId: 'job-mismatch',
      organizationId: testOrgId, // Mismatching org!
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id },
      attemptNumber: 1,
      workerId: 'test-worker-1',
    };

    try {
      await executor.execute(context);
      fail('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(JobExecutionError);
      expect(err.code).toBe('ORGANIZATION_MISMATCH');
      expect(err.retryable).toBe(false);
    }
  });

  it('7. Refuses execution if integration is DISCONNECTED', async () => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: testOrgId,
        provider: 'SHIPSTATION',
        name: 'ShipStation Disconnected',
        status: 'DISCONNECTED',
      },
    });

    const executor = new ShipStationSyncJobExecutor(prisma, { encryptionKey });
    const context: JobContext = {
      jobId: 'job-disconnected',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id },
      attemptNumber: 1,
      workerId: 'test-worker-1',
    };

    try {
      await executor.execute(context);
      fail('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(JobExecutionError);
      expect(err.code).toBe('INTEGRATION_DISCONNECTED');
      expect(err.retryable).toBe(false);
    }
  });

  it('8. Bounded label pagination: handles 0 labels, multi-page, active + voided, and excludes unrelated labels', async () => {
    const creds: StoredShipStationCredential = { apiKey: 'valid_key_pagination', keyId: 'v1' };
    const integration = await prisma.integration.create({
      data: {
        organizationId: testOrgId,
        provider: 'SHIPSTATION',
        name: 'ShipStation Pagination Test',
        status: 'CONNECTED',
        encryptedCredentials: encryptCredentials(creds, encryptionKey) as unknown as object,
        configuration: {},
      },
    });

    const mockShipments: ShipStationRawShipment[] = [
      {
        shipment_id: 'ss-p-1',
        shipment_number: 'SHIP-P-1',
        order_number: 'P1001',
        shipment_status: 'label_purchased',
        carrier_code: 'usps',
        created_at: '2026-09-20T08:00:00Z',
        modified_at: '2026-09-20T09:00:00Z',
      },
      {
        shipment_id: 'ss-p-2',
        shipment_number: 'SHIP-P-2',
        order_number: 'P1002',
        shipment_status: 'label_purchased',
        carrier_code: 'fedex',
        created_at: '2026-09-20T08:00:00Z',
        modified_at: '2026-09-20T09:10:00Z',
      },
      {
        shipment_id: 'ss-p-3',
        shipment_number: 'SHIP-P-3',
        order_number: 'P1003',
        shipment_status: 'pending',
        carrier_code: 'ups',
        created_at: '2026-09-20T08:00:00Z',
        modified_at: '2026-09-20T09:20:00Z',
      },
    ];

    // Page 1: active + voided for ss-p-1
    const labelsPage1: ShipStationRawLabel[] = [
      {
        label_id: 'lbl-p-1a-void',
        shipment_id: 'ss-p-1',
        tracking_number: 'TRK-P1A-VOID',
        carrier_code: 'usps',
        status: 'voided',
        voided: true,
        created_at: '2026-09-20T08:30:00Z',
      },
      {
        label_id: 'lbl-p-1b-active',
        shipment_id: 'ss-p-1',
        tracking_number: 'TRK-P1B-ACTIVE',
        carrier_code: 'usps',
        status: 'completed',
        voided: false,
        created_at: '2026-09-20T08:45:00Z',
      },
    ];

    // Page 2: active for ss-p-2, and unrelated label for ss-unrelated-999
    const labelsPage2: ShipStationRawLabel[] = [
      {
        label_id: 'lbl-p-2-active',
        shipment_id: 'ss-p-2',
        tracking_number: 'TRK-P2-ACTIVE',
        carrier_code: 'fedex',
        status: 'completed',
        voided: false,
        created_at: '2026-09-20T09:05:00Z',
      },
      {
        label_id: 'lbl-unrelated',
        shipment_id: 'ss-unrelated-999',
        tracking_number: 'TRK-UNRELATED',
        carrier_code: 'dhl',
        status: 'completed',
        voided: false,
        created_at: '2026-09-20T09:15:00Z',
      },
    ];

    const mockFetch: typeof fetch = async (input: any) => {
      const urlStr = String(input);
      if (urlStr.includes('/v2/shipments')) {
        return new Response(
          JSON.stringify({
            shipments: mockShipments,
            total: 3,
            page: 1,
            pages: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr.includes('/v2/labels')) {
        if (urlStr.includes('page=2')) {
          return new Response(
            JSON.stringify({
              labels: labelsPage2,
              total: 4,
              page: 2,
              pages: 2,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            labels: labelsPage1,
            total: 4,
            page: 1,
            pages: 2,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const executor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: mockFetch,
    });

    const result = await executor.execute({
      jobId: 'job-pagination-test',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id },
      attemptNumber: 1,
      workerId: 'test-worker-1',
    });

    expect(result.totalShipmentsSynced).toBe(3);

    // Verify ss-p-1: has both LABEL references
    const p1Labels = await prisma.externalReference.findMany({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'LABEL',
        externalId: { in: ['lbl-p-1a-void', 'lbl-p-1b-active'] },
      },
    });
    expect(p1Labels.length).toBe(2);

    // Verify ss-p-1: has TRACKING ONLY for non-voided label
    const p1ActiveTracking = await prisma.externalReference.findFirst({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'TRACKING',
        externalId: 'TRK-P1B-ACTIVE',
      },
    });
    expect(p1ActiveTracking).toBeDefined();

    const p1VoidedTracking = await prisma.externalReference.findFirst({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'TRACKING',
        externalId: 'TRK-P1A-VOID',
      },
    });
    expect(p1VoidedTracking).toBeNull();

    // Verify ss-p-2 from Page 2: has active tracking
    const p2Tracking = await prisma.externalReference.findFirst({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'TRACKING',
        externalId: 'TRK-P2-ACTIVE',
      },
    });
    expect(p2Tracking).toBeDefined();

    // Verify unrelated label was NOT projected for any order
    const unrelatedTracking = await prisma.externalReference.findFirst({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'TRACKING',
        externalId: 'TRK-UNRELATED',
      },
    });
    expect(unrelatedTracking).toBeNull();

    // Verify zero-label behavior: sync succeeds cleanly when 0 labels returned
    const zeroLabelFetch: typeof fetch = async (input: any) => {
      const urlStr = String(input);
      if (urlStr.includes('/v2/shipments')) {
        return new Response(
          JSON.stringify({ shipments: [mockShipments[2]], total: 1, page: 1, pages: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr.includes('/v2/labels')) {
        return new Response(
          JSON.stringify({ labels: [], total: 0, page: 1, pages: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const zeroExecutor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      fetchFn: zeroLabelFetch,
    });
    const zeroResult = await zeroExecutor.execute({
      jobId: 'job-zero-labels',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id },
      attemptNumber: 1,
      workerId: 'test-worker-1',
    });
    expect(zeroResult.totalShipmentsSynced).toBe(1);
  }, 30000);

  it('9 & 10. Large sync request-count & N+1 regression: 250 shipments sync with batched pagination instead of N+1 requests', async () => {
    const creds: StoredShipStationCredential = { apiKey: 'valid_key_large_sync', keyId: 'v1' };
    const integration = await prisma.integration.create({
      data: {
        organizationId: testOrgId,
        provider: 'SHIPSTATION',
        name: 'ShipStation Large Sync Test',
        status: 'CONNECTED',
        encryptedCredentials: encryptCredentials(creds, encryptionKey) as unknown as object,
        configuration: {},
      },
    });

    const TOTAL_SHIPMENTS = 250;
    const PAGE_SIZE = 50;
    const TOTAL_PAGES = TOTAL_SHIPMENTS / PAGE_SIZE; // 5 pages

    // Generate 250 mock shipments
    const allShipments: ShipStationRawShipment[] = [];
    for (let i = 1; i <= TOTAL_SHIPMENTS; i++) {
      allShipments.push({
        shipment_id: `ss-large-${i}`,
        shipment_number: `SHIP-LARGE-${i}`,
        order_number: `ORD-LARGE-${i}`,
        shipment_status: 'label_purchased',
        carrier_code: 'usps',
        created_at: '2026-09-20T08:00:00Z',
        modified_at: '2026-09-20T09:00:00Z',
      });
    }

    // Generate 250 corresponding mock labels
    const allLabels: ShipStationRawLabel[] = [];
    for (let i = 1; i <= TOTAL_SHIPMENTS; i++) {
      allLabels.push({
        label_id: `lbl-large-${i}`,
        shipment_id: `ss-large-${i}`,
        tracking_number: `TRK-LARGE-${i.toString().padStart(6, '0')}`,
        carrier_code: 'usps',
        status: 'completed',
        voided: false,
        created_at: '2026-09-20T08:30:00Z',
      });
    }

    let shipmentListCalls = 0;
    let labelBulkListCalls = 0;
    let perShipmentFallbackCalls = 0;
    let totalProviderCalls = 0;

    const mockFetch: typeof fetch = async (input: any) => {
      totalProviderCalls++;
      const urlStr = String(input);

      if (urlStr.includes('/v2/shipments')) {
        shipmentListCalls++;
        const url = new URL(urlStr);
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const pageSize = parseInt(url.searchParams.get('page_size') || '50', 10);
        const startIndex = (page - 1) * pageSize;
        const pageSlice = allShipments.slice(startIndex, startIndex + pageSize);

        return new Response(
          JSON.stringify({
            shipments: pageSlice,
            total: TOTAL_SHIPMENTS,
            page,
            pages: TOTAL_PAGES,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes('/v2/labels')) {
        const url = new URL(urlStr);
        const shipmentIdFilter = url.searchParams.get('shipment_id');

        if (shipmentIdFilter) {
          perShipmentFallbackCalls++;
          const matched = allLabels.filter((l) => String(l.shipment_id) === shipmentIdFilter);
          return new Response(
            JSON.stringify({
              labels: matched,
              total: matched.length,
              page: 1,
              pages: 1,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        labelBulkListCalls++;
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const pageSize = parseInt(url.searchParams.get('page_size') || '50', 10);
        const startIndex = (page - 1) * pageSize;
        const pageSlice = allLabels.slice(startIndex, startIndex + pageSize);

        return new Response(
          JSON.stringify({
            labels: pageSlice,
            total: TOTAL_SHIPMENTS,
            page,
            pages: TOTAL_PAGES,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not found', { status: 404 });
    };

    const executor = new ShipStationSyncJobExecutor(prisma, {
      encryptionKey,
      defaultMaxShipments: 250,
      fetchFn: mockFetch,
    });

    const result = await executor.execute({
      jobId: 'job-large-sync-250',
      organizationId: testOrgId,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      payload: { integrationId: integration.id, maxShipments: 250 },
      attemptNumber: 1,
      workerId: 'test-worker-1',
    });

    expect(result.totalShipmentsSynced).toBe(250);
    expect(result.complete).toBe(true);

    // Verify Call Counts:
    // Shipment calls: 5 pages (50 per page)
    expect(shipmentListCalls).toBe(5);
    // Label calls: 5 pages (50 per page)
    expect(labelBulkListCalls).toBe(5);
    // Unconditional N+1 fallback calls: MUST BE 0 on healthy batched path
    expect(perShipmentFallbackCalls).toBe(0);
    // Total provider calls: 5 + 5 = 10 calls!
    expect(totalProviderCalls).toBe(10);

    // CRITICAL N+1 REGRESSION INVARIANT:
    // A 250-shipment sync must NOT make 250+ calls. It must be bounded to paginated batch size.
    expect(totalProviderCalls).toBeLessThanOrEqual(15);
    expect(perShipmentFallbackCalls).not.toBeGreaterThan(0);

    // Verify all 250 shipments and tracking numbers projected in PostgreSQL
    const shipmentRefCount = await prisma.externalReference.count({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'SHIPMENT',
      },
    });
    expect(shipmentRefCount).toBe(250);

    const trackingRefCount = await prisma.externalReference.count({
      where: {
        organizationId: testOrgId,
        integrationId: integration.id,
        resourceType: 'TRACKING',
      },
    });
    expect(trackingRefCount).toBe(250);
  }, 30000);
});
