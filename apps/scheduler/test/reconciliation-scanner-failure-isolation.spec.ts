import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  NormalizedOrderSnapshot,
  ReconciliationFinding,
} from '@reloop/reconciliation-core';
import { CaseDetectionService } from '../src/case-detection/case-detection.service';
import { SchedulerConfig, loadSchedulerConfig } from '../src/config';
import {
  OrderSnapshotProvider,
  RECONCILIATION_ORGANIZATION_BATCH_SIZE,
  ReconciliationScanner,
} from '../src/reconciliation-scanner';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const FIXTURE_ORGANIZATION_COUNT = 45;
const TEST_TENANT_TIMEOUT_MS = 1000;

describe('RA-01 reconciliation scanner tenant failure isolation', () => {
  let prisma: PrismaClient;
  let fixtureOrganizationIds: string[];
  let errorSpy: jest.SpyInstance;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });

  beforeEach(async () => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fixtureOrganizationIds = Array.from(
      { length: FIXTURE_ORGANIZATION_COUNT },
      () => randomUUID(),
    );
    await prisma.organization.createMany({
      data: fixtureOrganizationIds.map((id, index) => ({
        id,
        name: `RA-01 Isolation ${runId} ${index}`,
        slug: `ra01-isolation-${runId}-${index}`,
      })),
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.useRealTimers();
    errorSpy.mockRestore();
    await prisma.organization.deleteMany({
      where: { id: { in: fixtureOrganizationIds } },
    });
  });

  it('continues to a later tenant when an earlier tenant snapshot fetch throws', async () => {
    const [failingOrganizationId, targetOrganizationId] = await failureAndTargetIds();
    const visited = new Set<string>();
    const provider: OrderSnapshotProvider = {
      async fetchSnapshots(organizationId) {
        if (!fixtureOrganizationIds.includes(organizationId)) return [];
        visited.add(organizationId);
        if (organizationId === failingOrganizationId) {
          throw new Error('deterministic snapshot failure');
        }
        return organizationId === targetOrganizationId
          ? [createSnapshot(organizationId)]
          : [];
      },
    };
    const scanner = createScanner(provider);

    await scanUntil(scanner, () => visited.has(targetOrganizationId));

    expect(visited.has(failingOrganizationId)).toBe(true);
    expect(visited.has(targetOrganizationId)).toBe(true);
    expect(
      await prisma.recoveryCase.count({ where: { organizationId: targetOrganizationId } }),
    ).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`organization=${failingOrganizationId} category=snapshot_fetch`),
    );
  });

  it('times out one hanging tenant and continues to a later tenant', async () => {
    jest.useFakeTimers();
    const [hangingOrganizationId, targetOrganizationId] = await failureAndTargetIds();
    const visited = new Set<string>();
    let signalHangingFetch!: () => void;
    const hangingFetchStarted = new Promise<void>((resolve) => {
      signalHangingFetch = resolve;
    });
    const provider: OrderSnapshotProvider = {
      async fetchSnapshots(organizationId) {
        if (!fixtureOrganizationIds.includes(organizationId)) return [];
        visited.add(organizationId);
        if (organizationId === hangingOrganizationId) {
          signalHangingFetch();
          return new Promise<NormalizedOrderSnapshot[]>(() => undefined);
        }
        return organizationId === targetOrganizationId
          ? [createSnapshot(organizationId)]
          : [];
      },
    };
    const scanner = createScanner(provider);
    const ticksBeforeHangingTenant = await pageIndexOf(hangingOrganizationId);

    for (let index = 0; index < ticksBeforeHangingTenant; index++) {
      await scanner.tick();
    }
    const boundedTick = scanner.tick();
    await hangingFetchStarted;
    await jest.advanceTimersByTimeAsync(TEST_TENANT_TIMEOUT_MS);
    await boundedTick;
    jest.useRealTimers();
    await scanUntil(scanner, () => visited.has(targetOrganizationId));

    expect(visited.has(targetOrganizationId)).toBe(true);
    expect(
      await prisma.recoveryCase.count({ where: { organizationId: targetOrganizationId } }),
    ).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`organization=${hangingOrganizationId} category=timeout`),
    );
  });

  it('retries a failed tenant after the keyset traversal resets', async () => {
    const [failingOrganizationId] = await failureAndTargetIds();
    let attempts = 0;
    const provider: OrderSnapshotProvider = {
      async fetchSnapshots(organizationId) {
        if (organizationId !== failingOrganizationId) return [];
        attempts++;
        if (attempts === 1) {
          throw new Error('first-cycle snapshot failure');
        }
        return [];
      },
    };
    const scanner = createScanner(provider);

    await scanUntil(scanner, () => attempts >= 2, 2);

    expect(attempts).toBe(2);
  });

  it('isolates persistence failure and still processes a later tenant', async () => {
    const [failingOrganizationId, targetOrganizationId] = await failureAndTargetIds();
    const visited = new Set<string>();
    const provider: OrderSnapshotProvider = {
      async fetchSnapshots(organizationId) {
        if (!fixtureOrganizationIds.includes(organizationId)) return [];
        visited.add(organizationId);
        return organizationId === failingOrganizationId || organizationId === targetOrganizationId
          ? [createSnapshot(organizationId)]
          : [];
      },
    };
    const delegate = new CaseDetectionService(prisma);
    const caseDetection = {
      async persistFindings(
        organizationId: string,
        findings: ReconciliationFinding[],
        externalOrderId?: string,
      ) {
        if (organizationId === failingOrganizationId) {
          throw new Error('deterministic persistence failure');
        }
        return delegate.persistFindings(organizationId, findings, externalOrderId);
      },
    } as CaseDetectionService;
    const scanner = createScanner(provider, caseDetection);

    await scanUntil(scanner, () => visited.has(targetOrganizationId));

    expect(visited.has(targetOrganizationId)).toBe(true);
    expect(
      await prisma.recoveryCase.count({ where: { organizationId: failingOrganizationId } }),
    ).toBe(0);
    expect(
      await prisma.recoveryCase.count({ where: { organizationId: targetOrganizationId } }),
    ).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`organization=${failingOrganizationId} category=reconciliation`),
    );
  });

  function createScanner(
    provider: OrderSnapshotProvider,
    caseDetection = new CaseDetectionService(prisma),
  ): ReconciliationScanner {
    const overrides = {
      reconciliationScanBatchSize: 1,
      reconciliationTenantTimeoutMs: TEST_TENANT_TIMEOUT_MS,
    } as Partial<SchedulerConfig>;
    return new ReconciliationScanner(
      prisma,
      caseDetection,
      loadSchedulerConfig(overrides),
      provider,
    );
  }

  async function failureAndTargetIds(): Promise<[string, string]> {
    const orderedFixtures = await prisma.organization.findMany({
      where: { id: { in: fixtureOrganizationIds } },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return [orderedFixtures[0].id, orderedFixtures[orderedFixtures.length - 1].id];
  }

  async function pageIndexOf(organizationId: string): Promise<number> {
    const ordered = await prisma.organization.findMany({
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    const index = ordered.findIndex((organization) => organization.id === organizationId);
    if (index < 0) throw new Error(`Organization ${organizationId} not found`);
    return Math.floor(index / RECONCILIATION_ORGANIZATION_BATCH_SIZE);
  }

  async function scanUntil(
    scanner: ReconciliationScanner,
    condition: () => boolean,
    cycles = 1,
  ): Promise<void> {
    const organizationCount = await prisma.organization.count();
    const maxTicks =
      (Math.ceil(organizationCount / RECONCILIATION_ORGANIZATION_BATCH_SIZE) + 1) * cycles;
    for (let tick = 0; tick < maxTicks && !condition(); tick++) {
      await scanner.tick();
    }
  }
});

function createSnapshot(organizationId: string): NormalizedOrderSnapshot {
  const orderNumber = `RA01-ISOLATION-${organizationId}`;
  return {
    organizationId,
    orderNumber,
    shopify: {
      id: `shopify-${organizationId}`,
      orderNumber,
      fulfillmentStatus: 'UNFULFILLED',
      lineItems: [{ sku: 'SKU-RA01', quantity: 1 }],
      createdAt: '2026-09-19T08:00:00.000Z',
      updatedAt: '2026-09-19T09:00:00.000Z',
    },
    warehouse: {
      id: `warehouse-${organizationId}`,
      orderNumber,
      status: 'SHIPPED',
      trackingNumber: `TRACK-${organizationId}`,
      lineItems: [{ sku: 'SKU-RA01', quantity: 1 }],
      createdAt: '2026-09-19T08:30:00.000Z',
      updatedAt: '2026-09-19T09:00:00.000Z',
    },
  };
}
