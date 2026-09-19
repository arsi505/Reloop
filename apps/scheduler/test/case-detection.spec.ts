import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  PrismaClient,
  RecoveryCaseStatus,
  RecoveryCaseType,
  RecoveryLevel,
} from '@prisma/client';
import {
  reconcileOrder,
  NormalizedOrderSnapshot,
} from '@reloop/reconciliation-core';
import { CaseDetectionService } from '../src/case-detection/case-detection.service';
import { ReconciliationScanner } from '../src/reconciliation-scanner';
import { loadSchedulerConfig } from '../src/config';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';

describe('Day 12: RecoveryCase Detection & Deduplication Integration', () => {
  let prisma: PrismaClient;
  let detectionService: CaseDetectionService;
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
    detectionService = new CaseDetectionService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(async () => {
    const runId = Math.random().toString(36).substring(2, 8);

    const orgA = await prisma.organization.create({
      data: { name: `Case Det Org A ${runId}`, slug: `case-org-a-${runId}` },
    });
    orgAId = orgA.id;

    const orgB = await prisma.organization.create({
      data: { name: `Case Det Org B ${runId}`, slug: `case-org-b-${runId}` },
    });
    orgBId = orgB.id;
  });

  it('creates a new RecoveryCase from reconciliation findings and persists structured evidence', async () => {
    const snapshot: NormalizedOrderSnapshot = {
      organizationId: orgAId,
      orderNumber: 'ORD-901',
      shopify: {
        id: 'shp-901',
        orderNumber: 'ORD-901',
        fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:00:00.000Z',
        updatedAt: '2026-09-19T08:00:00.000Z',
      },
      warehouse: {
        id: 'wh-901',
        orderNumber: 'ORD-901',
        status: 'SHIPPED',
        trackingNumber: 'TRK-901',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:30:00.000Z',
        updatedAt: '2026-09-19T09:00:00.000Z',
      },
    };

    const findings = reconcileOrder(snapshot);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY');

    const cases = await detectionService.persistFindings(orgAId, findings);
    expect(cases).toHaveLength(1);

    const created = cases[0];
    expect(created.organizationId).toBe(orgAId);
    expect(created.type).toBe(RecoveryCaseType.SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY);
    expect(created.recoveryLevel).toBe(RecoveryLevel.REQUIRE_APPROVAL);
    expect(created.status).toBe(RecoveryCaseStatus.OPEN);
    expect(created.dedupeKey).toBe('ORD-901:SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY');

    const evidence = created.evidence as any;
    expect(evidence.invariantFailed).toBe('FULFILLMENT_STATE_CONSISTENCY');
    expect(evidence.disagreements.fulfillmentStatus.observed).toContain('Shopify=UNFULFILLED, 3PL=SHIPPED');
  });

  it('same issue deduplication: second scan reuses active case without creating duplicates', async () => {
    const snapshot: NormalizedOrderSnapshot = {
      organizationId: orgAId,
      orderNumber: 'ORD-902',
      shopify: {
        id: 'shp-902',
        orderNumber: 'ORD-902',
        fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:00:00.000Z',
        updatedAt: '2026-09-19T08:00:00.000Z',
      },
      warehouse: {
        id: 'wh-902',
        orderNumber: 'ORD-902',
        status: 'SHIPPED',
        trackingNumber: 'TRK-902',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:30:00.000Z',
        updatedAt: '2026-09-19T09:00:00.000Z',
      },
    };

    const findings = reconcileOrder(snapshot);

    // Pass 1: Case created
    const pass1 = await detectionService.persistFindings(orgAId, findings);
    expect(pass1).toHaveLength(1);
    const caseId1 = pass1[0].id;

    // Pass 2: Same issue scanned again
    const pass2 = await detectionService.persistFindings(orgAId, findings);
    expect(pass2).toHaveLength(1);
    expect(pass2[0].id).toBe(caseId1); // Exactly the same row ID

    // Verify in database: exactly 1 RecoveryCase exists for this order
    const allCases = await prisma.recoveryCase.findMany({
      where: { organizationId: orgAId, dedupeKey: 'ORD-902:SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY' },
    });
    expect(allCases).toHaveLength(1);
  });

  it('multi-detector race: 3 concurrent detector instances on same issue resolve to exactly 1 RecoveryCase', async () => {
    const snapshot: NormalizedOrderSnapshot = {
      organizationId: orgAId,
      orderNumber: 'ORD-903-RACE',
      shopify: {
        id: 'shp-903',
        orderNumber: 'ORD-903-RACE',
        fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:00:00.000Z',
        updatedAt: '2026-09-19T08:00:00.000Z',
      },
      warehouse: {
        id: 'wh-903',
        orderNumber: 'ORD-903-RACE',
        status: 'SHIPPED',
        trackingNumber: 'TRK-903',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:30:00.000Z',
        updatedAt: '2026-09-19T09:00:00.000Z',
      },
    };

    const findings = reconcileOrder(snapshot);

    const detector1 = new CaseDetectionService(prisma);
    const detector2 = new CaseDetectionService(prisma);
    const detector3 = new CaseDetectionService(prisma);

    // Run all 3 concurrently in parallel
    const [res1, res2, res3] = await Promise.all([
      detector1.persistFindings(orgAId, findings),
      detector2.persistFindings(orgAId, findings),
      detector3.persistFindings(orgAId, findings),
    ]);

    // All 3 returned the same logical case ID
    expect(res1[0].id).toBe(res2[0].id);
    expect(res2[0].id).toBe(res3[0].id);

    // Exactly 1 row in DB
    const dbCases = await prisma.recoveryCase.findMany({
      where: { organizationId: orgAId, dedupeKey: 'ORD-903-RACE:SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY' },
    });
    expect(dbCases).toHaveLength(1);
  });

  it('scanner restart deduplication: stopping and restarting scanner reuses active case', async () => {
    const snapshot: NormalizedOrderSnapshot = {
      organizationId: orgAId,
      orderNumber: 'ORD-904-RESTART',
      shopify: {
        id: 'shp-904',
        orderNumber: 'ORD-904-RESTART',
        fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:00:00.000Z',
        updatedAt: '2026-09-19T08:00:00.000Z',
      },
      warehouse: {
        id: 'wh-904',
        orderNumber: 'ORD-904-RESTART',
        status: 'SHIPPED',
        trackingNumber: 'TRK-904',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:30:00.000Z',
        updatedAt: '2026-09-19T09:00:00.000Z',
      },
    };

    const config = loadSchedulerConfig({ reconciliationScanIntervalMs: 500 });

    const scanner1 = new ReconciliationScanner(prisma, detectionService, config);
    const cases1 = await scanner1.processSnapshot(snapshot);
    expect(cases1).toHaveLength(1);
    const initialId = cases1[0].id;

    await scanner1.stop();

    // Start scanner 2
    const scanner2 = new ReconciliationScanner(prisma, detectionService, config);
    const cases2 = await scanner2.processSnapshot(snapshot);
    expect(cases2).toHaveLength(1);
    expect(cases2[0].id).toBe(initialId);

    await scanner2.stop();

    const count = await prisma.recoveryCase.count({
      where: { organizationId: orgAId, dedupeKey: 'ORD-904-RESTART:SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY' },
    });
    expect(count).toBe(1);
  });

  it('tenant isolation: identical orders in Org A and Org B produce distinct isolated RecoveryCases', async () => {
    const snapshotA: NormalizedOrderSnapshot = {
      organizationId: orgAId,
      orderNumber: 'ORD-SAME-NUMBER',
      shopify: {
        id: 'shp-A',
        orderNumber: 'ORD-SAME-NUMBER',
        fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:00:00.000Z',
        updatedAt: '2026-09-19T08:00:00.000Z',
      },
      warehouse: {
        id: 'wh-A',
        orderNumber: 'ORD-SAME-NUMBER',
        status: 'SHIPPED',
        trackingNumber: 'TRK-A',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:30:00.000Z',
        updatedAt: '2026-09-19T09:00:00.000Z',
      },
    };

    const snapshotB: NormalizedOrderSnapshot = {
      ...snapshotA,
      organizationId: orgBId,
    };

    const [casesA, casesB] = await Promise.all([
      detectionService.persistFindings(orgAId, reconcileOrder(snapshotA)),
      detectionService.persistFindings(orgBId, reconcileOrder(snapshotB)),
    ]);

    expect(casesA[0].id).not.toBe(casesB[0].id);
    expect(casesA[0].organizationId).toBe(orgAId);
    expect(casesB[0].organizationId).toBe(orgBId);

    // Cross-tenant queries return nothing
    const orgACaseForOrgB = await prisma.recoveryCase.findFirst({
      where: { id: casesB[0].id, organizationId: orgAId },
    });
    expect(orgACaseForOrgB).toBeNull();
  });

  it('different categories on same order remain separate distinct RecoveryCases', async () => {
    const findings = [
      {
        ruleKey: 'RULE_SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY',
        category: 'SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY' as const,
        recoveryLevel: 'REQUIRE_APPROVAL' as const,
        orderIdentity: { orderNumber: 'ORD-MULTI-CAT' },
        summary: 'Shipment shipped at 3PL but unfulfilled in Shopify',
        evidence: {
          evaluatedAt: new Date().toISOString(),
          systemsCompared: ['Shopify', 'Generic3PL'],
          invariantFailed: 'FULFILLMENT_STATE_CONSISTENCY',
          disagreements: {},
          matchedIdentifiers: [],
          conflictingIdentifiers: [],
        },
      },
      {
        ruleKey: 'RULE_INVENTORY_MISMATCH',
        category: 'INVENTORY_MISMATCH' as const,
        recoveryLevel: 'REQUIRE_APPROVAL' as const,
        orderIdentity: { orderNumber: 'ORD-MULTI-CAT' },
        summary: 'Inventory quantity mismatch detected',
        evidence: {
          evaluatedAt: new Date().toISOString(),
          systemsCompared: ['Shopify', 'Generic3PL'],
          invariantFailed: 'INVENTORY_PARITY',
          disagreements: {},
          matchedIdentifiers: [],
          conflictingIdentifiers: [],
        },
      },
    ];

    const persisted = await detectionService.persistFindings(orgAId, findings);
    expect(persisted).toHaveLength(2);

    expect(persisted[0].type).toBe(RecoveryCaseType.SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY);
    expect(persisted[1].type).toBe(RecoveryCaseType.INVENTORY_MISMATCH);
    expect(persisted[0].id).not.toBe(persisted[1].id);
  });

  it('recurrence of resolved case creates a new incident case without mutating resolved history', async () => {
    const snapshot: NormalizedOrderSnapshot = {
      organizationId: orgAId,
      orderNumber: 'ORD-RECURRENCE',
      shopify: {
        id: 'shp-rec',
        orderNumber: 'ORD-RECURRENCE',
        fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:00:00.000Z',
        updatedAt: '2026-09-19T08:00:00.000Z',
      },
      warehouse: {
        id: 'wh-rec',
        orderNumber: 'ORD-RECURRENCE',
        status: 'SHIPPED',
        trackingNumber: 'TRK-REC',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:30:00.000Z',
        updatedAt: '2026-09-19T09:00:00.000Z',
      },
    };

    const findings = reconcileOrder(snapshot);

    // Initial case
    const initialCases = await detectionService.persistFindings(orgAId, findings);
    const case1Id = initialCases[0].id;

    // Simulate that case 1 was verified and RESOLVED
    await prisma.recoveryCase.update({
      where: { id: case1Id },
      data: { status: RecoveryCaseStatus.RESOLVED, resolvedAt: new Date() },
    });

    // The issue recurs on a subsequent scan pass
    const recurrentCases = await detectionService.persistFindings(orgAId, findings);
    expect(recurrentCases).toHaveLength(1);

    const case2Id = recurrentCases[0].id;
    // Must be a NEW distinct case row!
    expect(case2Id).not.toBe(case1Id);

    // Check that case 1 was NOT mutated
    const historicalCase1 = await prisma.recoveryCase.findUnique({ where: { id: case1Id } });
    expect(historicalCase1?.status).toBe(RecoveryCaseStatus.RESOLVED);
    expect(historicalCase1?.resolvedAt).toBeDefined();

    // Check that case 2 is OPEN
    const newCase2 = await prisma.recoveryCase.findUnique({ where: { id: case2Id } });
    expect(newCase2?.status).toBe(RecoveryCaseStatus.OPEN);
  });

  it('invariants: detection creates ZERO Jobs, ZERO Approvals, and ZERO Workflows', async () => {
    const snapshot: NormalizedOrderSnapshot = {
      organizationId: orgAId,
      orderNumber: 'ORD-INVARIANT-TEST',
      shopify: {
        id: 'shp-inv',
        orderNumber: 'ORD-INVARIANT-TEST',
        fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:00:00.000Z',
        updatedAt: '2026-09-19T08:00:00.000Z',
      },
      warehouse: {
        id: 'wh-inv',
        orderNumber: 'ORD-INVARIANT-TEST',
        status: 'SHIPPED',
        trackingNumber: 'TRK-INV',
        lineItems: [{ sku: 'SKU-1', quantity: 1 }],
        createdAt: '2026-09-19T08:30:00.000Z',
        updatedAt: '2026-09-19T09:00:00.000Z',
      },
    };

    const findings = reconcileOrder(snapshot);
    const createdCases = await detectionService.persistFindings(orgAId, findings);
    expect(createdCases).toHaveLength(1);

    const caseId = createdCases[0].id;

    // 1. Zero Jobs created
    const jobs = await prisma.job.findMany({ where: { organizationId: orgAId } });
    expect(jobs).toHaveLength(0);

    // 2. Zero Approvals created
    const approvals = await prisma.approval.findMany({ where: { recoveryCaseId: caseId } });
    expect(approvals).toHaveLength(0);

    // 3. Zero Workflows created
    const workflows = await prisma.workflow.findMany({ where: { recoveryCaseId: caseId } });
    expect(workflows).toHaveLength(0);
  });
});
