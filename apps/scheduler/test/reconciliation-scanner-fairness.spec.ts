import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { NormalizedOrderSnapshot } from '@reloop/reconciliation-core';
import { CaseDetectionService } from '../src/case-detection/case-detection.service';
import { loadSchedulerConfig } from '../src/config';
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

describe('RA-01 reconciliation scanner tenant fairness', () => {
  let prisma: PrismaClient;
  let fixtureOrganizationIds: string[];

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
        name: `RA-01 Fairness ${runId} ${index}`,
        slug: `ra01-fairness-${runId}-${index}`,
      })),
    });
  });

  afterEach(async () => {
    await prisma.organization.deleteMany({
      where: { id: { in: fixtureOrganizationIds } },
    });
  });

  it('eventually scans all 45 eligible organizations in bounded pages of 20', async () => {
    const visited = new Set<string>();
    const scanner = createScanner(createProvider(visited));

    const tickResults = await scanUntil(
      scanner,
      () => fixtureOrganizationIds.every((id) => visited.has(id)),
    );

    expect(fixtureOrganizationIds.every((id) => visited.has(id))).toBe(true);
    expect(
      tickResults.every(
        (result) => result.scannedOrders <= RECONCILIATION_ORGANIZATION_BATCH_SIZE,
      ),
    ).toBe(true);
  });

  it('eventually creates a case for a discrepancy beyond the first 20 organizations', async () => {
    const targetOrganizationId = await organizationBeyondFirstPage();
    const visited = new Set<string>();
    const scanner = createScanner(createProvider(visited, targetOrganizationId));

    await scanUntil(scanner, () => visited.has(targetOrganizationId));

    const cases = await prisma.recoveryCase.findMany({
      where: { organizationId: targetOrganizationId },
    });
    expect(visited.has(targetOrganizationId)).toBe(true);
    expect(cases).toHaveLength(1);
  });

  it('allows later tenants to progress when earlier organizations have no snapshots', async () => {
    const targetOrganizationId = await organizationBeyondFirstPage();
    const visited = new Set<string>();
    const provider: OrderSnapshotProvider = {
      async fetchSnapshots(organizationId) {
        if (!fixtureOrganizationIds.includes(organizationId)) return [];
        visited.add(organizationId);
        return organizationId === targetOrganizationId
          ? [createSnapshot(organizationId, true)]
          : [];
      },
    };
    const scanner = createScanner(provider);

    await scanUntil(scanner, () => visited.has(targetOrganizationId));

    expect(visited.has(targetOrganizationId)).toBe(true);
    expect(
      await prisma.recoveryCase.count({ where: { organizationId: targetOrganizationId } }),
    ).toBe(1);
  });

  it('does not create duplicate logical cases when a later tenant is scanned again', async () => {
    const targetOrganizationId = await organizationBeyondFirstPage();
    const visitCounts = new Map<string, number>();
    const provider: OrderSnapshotProvider = {
      async fetchSnapshots(organizationId) {
        if (!fixtureOrganizationIds.includes(organizationId)) return [];
        visitCounts.set(organizationId, (visitCounts.get(organizationId) || 0) + 1);
        return organizationId === targetOrganizationId
          ? [createSnapshot(organizationId, true)]
          : [];
      },
    };
    const scanner = createScanner(provider);

    await scanUntil(scanner, () => (visitCounts.get(targetOrganizationId) || 0) >= 2, 2);

    expect(visitCounts.get(targetOrganizationId)).toBeGreaterThanOrEqual(2);
    expect(
      await prisma.recoveryCase.count({ where: { organizationId: targetOrganizationId } }),
    ).toBe(1);
  });

  it('eventually covers every organization after scanner recreation', async () => {
    const firstScannerVisits = new Set<string>();
    await createScanner(createProvider(firstScannerVisits)).tick();

    const restartedScannerVisits = new Set<string>();
    const restartedScanner = createScanner(createProvider(restartedScannerVisits));
    await scanUntil(
      restartedScanner,
      () => fixtureOrganizationIds.every((id) => restartedScannerVisits.has(id)),
    );

    expect(fixtureOrganizationIds.every((id) => restartedScannerVisits.has(id))).toBe(true);
  });

  function createScanner(provider: OrderSnapshotProvider): ReconciliationScanner {
    return new ReconciliationScanner(
      prisma,
      new CaseDetectionService(prisma),
      loadSchedulerConfig({ reconciliationScanBatchSize: 1 }),
      provider,
    );
  }

  function createProvider(
    visited: Set<string>,
    discrepancyOrganizationId?: string,
  ): OrderSnapshotProvider {
    return {
      async fetchSnapshots(organizationId) {
        if (!fixtureOrganizationIds.includes(organizationId)) return [];
        visited.add(organizationId);
        return [
          createSnapshot(
            organizationId,
            organizationId === discrepancyOrganizationId,
          ),
        ];
      },
    };
  }

  async function organizationBeyondFirstPage(): Promise<string> {
    const ordered = await prisma.organization.findMany({
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    const firstPageIds = new Set(
      ordered
        .slice(0, RECONCILIATION_ORGANIZATION_BATCH_SIZE)
        .map((organization) => organization.id),
    );
    const target = fixtureOrganizationIds.find((id) => !firstPageIds.has(id));
    if (!target) throw new Error('Expected a fixture organization beyond the first page');
    return target;
  }

  async function scanUntil(
    scanner: ReconciliationScanner,
    condition: () => boolean,
    cycles = 1,
  ): Promise<Array<Awaited<ReturnType<ReconciliationScanner['tick']>>>> {
    const organizationCount = await prisma.organization.count();
    const maxTicks =
      (Math.ceil(organizationCount / RECONCILIATION_ORGANIZATION_BATCH_SIZE) + 1) * cycles;
    const results: Array<Awaited<ReturnType<ReconciliationScanner['tick']>>> = [];
    for (let tick = 0; tick < maxTicks && !condition(); tick++) {
      results.push(await scanner.tick());
    }
    return results;
  }
});

function createSnapshot(
  organizationId: string,
  discrepancy: boolean,
): NormalizedOrderSnapshot {
  const orderNumber = `RA01-${organizationId}`;
  return {
    organizationId,
    orderNumber,
    shopify: {
      id: `shopify-${organizationId}`,
      orderNumber,
      fulfillmentStatus: discrepancy ? 'UNFULFILLED' : 'FULFILLED',
      trackingNumber: discrepancy ? undefined : `TRACK-${organizationId}`,
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
