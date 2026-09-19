import * as dotenv from 'dotenv';
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
import { CaseDetectionService } from '../apps/scheduler/src/case-detection/case-detection.service';

dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';

async function runReconciliationDemo() {
  console.log('================================================================');
  console.log('  RELOOP DAY 12: CROSS-SYSTEM RECONCILIATION & CASE DETECTION   ');
  console.log('================================================================\n');

  const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
  await prisma.$connect();

  const runId = Math.random().toString(36).substring(2, 8);
  const detectionService = new CaseDetectionService(prisma);

  try {
    const org = await prisma.organization.create({
      data: {
        name: `Reconciliation Demo Org ${runId}`,
        slug: `recon-demo-${runId}`,
      },
    });

    console.log(`[Setup] Created Demo Organization: ${org.name} (${org.id})\n`);

    // =========================================================================
    // SCENARIO A: HEALTHY ORDER (CONSISTENT STATE -> ZERO RECOVERY CASES)
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('SCENARIO A: HEALTHY ORDER (CONSISTENT STATE)');
    console.log('  Shopify: FULFILLED | 3PL: SHIPPED | ShipStation: IN_TRANSIT');
    console.log('----------------------------------------------------------------');

    const healthySnapshot: NormalizedOrderSnapshot = {
      organizationId: org.id,
      orderNumber: `ORD-HEALTHY-${runId}`,
      shopify: {
        id: `shp-healthy-${runId}`,
        orderNumber: `ORD-HEALTHY-${runId}`,
        fulfillmentStatus: 'FULFILLED',
        trackingNumber: `TRK-HEALTHY-${runId}`,
        carrier: 'FedEx',
        lineItems: [{ sku: 'SKU-HEALTHY', quantity: 1 }],
        addressValid: true,
        createdAt: '2026-09-19T08:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
      warehouse: {
        id: `wh-healthy-${runId}`,
        orderNumber: `ORD-HEALTHY-${runId}`,
        externalReference: `shp-healthy-${runId}`,
        status: 'SHIPPED',
        trackingNumber: `TRK-HEALTHY-${runId}`,
        carrier: 'FedEx',
        lineItems: [{ sku: 'SKU-HEALTHY', quantity: 1 }],
        createdAt: '2026-09-19T08:30:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
      shipstation: {
        id: `ss-healthy-${runId}`,
        orderNumber: `ORD-HEALTHY-${runId}`,
        carrier: 'FedEx',
        trackingNumber: `TRK-HEALTHY-${runId}`,
        status: 'IN_TRANSIT',
        createdAt: '2026-09-19T09:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
      inventory: [
        { sku: 'SKU-HEALTHY', shopifyQuantity: 100, warehouseQuantity: 100 },
      ],
    };

    const findingsA = reconcileOrder(healthySnapshot);
    console.log(`[Scenario A] Evaluated findings count: ${findingsA.length}`);
    const casesA = await detectionService.persistFindings(org.id, findingsA);
    console.log(`[Scenario A] RecoveryCases created: ${casesA.length}`);
    if (casesA.length !== 0) {
      throw new Error('Healthy order produced false positive RecoveryCase!');
    }
    console.log('[Scenario A] PASSED: Consistent order produced 0 cases.\n');

    // =========================================================================
    // SCENARIO B: 3PL SHIPPED BUT SHOPIFY UNFULFILLED
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('SCENARIO B: 3PL SHIPPED / SHOPIFY UNFULFILLED');
    console.log('  Shopify: UNFULFILLED (no tracking) | 3PL: SHIPPED (tracking present)');
    console.log('----------------------------------------------------------------');

    const shippedUnfulfilledSnapshot: NormalizedOrderSnapshot = {
      organizationId: org.id,
      orderNumber: `ORD-SHIPPED-${runId}`,
      shopify: {
        id: `shp-shipped-${runId}`,
        orderNumber: `ORD-SHIPPED-${runId}`,
        fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ sku: 'SKU-B', quantity: 2 }],
        addressValid: true,
        createdAt: '2026-09-19T07:00:00.000Z',
        updatedAt: '2026-09-19T07:00:00.000Z',
      },
      warehouse: {
        id: `wh-shipped-${runId}`,
        orderNumber: `ORD-SHIPPED-${runId}`,
        externalReference: `shp-shipped-${runId}`,
        status: 'SHIPPED',
        trackingNumber: `TRK-3PL-${runId}`,
        carrier: 'UPS',
        lineItems: [{ sku: 'SKU-B', quantity: 2 }],
        createdAt: '2026-09-19T07:30:00.000Z',
        updatedAt: '2026-09-19T09:00:00.000Z',
      },
    };

    const findingsB = reconcileOrder(shippedUnfulfilledSnapshot);
    console.log(`[Scenario B] Findings detected: ${findingsB.length}`);
    console.log(`  - Category: ${findingsB[0].category}`);
    console.log(`  - RecoveryLevel: ${findingsB[0].recoveryLevel}`);
    console.log(`  - Summary: ${findingsB[0].summary}`);

    const casesB = await detectionService.persistFindings(org.id, findingsB);
    console.log(`[Scenario B] Persisted RecoveryCase ID: ${casesB[0].id}`);
    console.log(`  - Status: ${casesB[0].status}`);
    console.log(`  - DedupeKey: ${casesB[0].dedupeKey}`);
    console.log(`  - Evidence:`, JSON.stringify(casesB[0].evidence, null, 2));

    if (casesB[0].recoveryLevel !== RecoveryLevel.REQUIRE_APPROVAL) {
      throw new Error('Expected REQUIRE_APPROVAL level for shipped unfulfilled finding');
    }
    console.log('[Scenario B] PASSED: Case created with REQUIRE_APPROVAL and clear evidence.\n');

    // =========================================================================
    // SCENARIO C: DUPLICATE RISK (SAFETY BLOCK)
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('SCENARIO C: DUPLICATE RISK (SAFETY BLOCK)');
    console.log('  Multiple warehouse candidate orders detected for same Shopify order');
    console.log('----------------------------------------------------------------');

    const duplicateRiskSnapshot: NormalizedOrderSnapshot = {
      organizationId: org.id,
      orderNumber: `ORD-DUP-${runId}`,
      shopify: {
        id: `shp-dup-${runId}`,
        orderNumber: `ORD-DUP-${runId}`,
        fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ sku: 'SKU-C', quantity: 1 }],
        addressValid: true,
        createdAt: '2026-09-19T06:00:00.000Z',
        updatedAt: '2026-09-19T06:00:00.000Z',
      },
      warehouse: {
        id: `wh-dup-primary-${runId}`,
        orderNumber: `ORD-DUP-${runId}`,
        status: 'RECEIVED',
        lineItems: [{ sku: 'SKU-C', quantity: 1 }],
        candidateOrders: [
          { id: `cand-1-${runId}`, orderNumber: `ORD-DUP-${runId}`, status: 'RECEIVED' },
          { id: `cand-2-${runId}`, orderNumber: `ORD-DUP-${runId}`, status: 'PICKING' },
        ],
        createdAt: '2026-09-19T06:30:00.000Z',
        updatedAt: '2026-09-19T07:00:00.000Z',
      },
    };

    const findingsC = reconcileOrder(duplicateRiskSnapshot);
    console.log(`[Scenario C] Findings detected: ${findingsC.length}`);
    console.log(`  - Category: ${findingsC[0].category}`);
    console.log(`  - RecoveryLevel: ${findingsC[0].recoveryLevel}`);
    console.log(`  - Summary: ${findingsC[0].summary}`);

    const casesC = await detectionService.persistFindings(org.id, findingsC);
    console.log(`[Scenario C] Persisted RecoveryCase ID: ${casesC[0].id}`);
    console.log(`  - RecoveryLevel: ${casesC[0].recoveryLevel} (Must be BLOCK)`);
    if (casesC[0].recoveryLevel !== RecoveryLevel.BLOCK) {
      throw new Error('Expected BLOCK recovery level for duplicate risk condition');
    }
    console.log('[Scenario C] PASSED: Duplicate risk successfully halted with BLOCK.\n');

    // =========================================================================
    // SCENARIO D: TEMPORARY API FAILURE (AUTO_RECOVER)
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('SCENARIO D: TEMPORARY API FAILURE (AUTO_RECOVER)');
    console.log('  Shopify: 503 Service Unavailable | Transient provider error');
    console.log('----------------------------------------------------------------');

    const tempFailureSnapshot: NormalizedOrderSnapshot = {
      organizationId: org.id,
      orderNumber: `ORD-TEMP-${runId}`,
      shopify: {
        id: `shp-temp-${runId}`,
        orderNumber: `ORD-TEMP-${runId}`,
        fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ sku: 'SKU-D', quantity: 1 }],
        createdAt: '2026-09-19T09:00:00.000Z',
        updatedAt: '2026-09-19T09:00:00.000Z',
        error: {
          provider: 'Shopify',
          statusCode: 503,
          errorCode: 'SERVICE_UNAVAILABLE',
          message: 'Shopify API returned HTTP 503 temporary service unavailable',
          isTransient: true,
        },
      },
    };

    const findingsD = reconcileOrder(tempFailureSnapshot);
    console.log(`[Scenario D] Findings detected: ${findingsD.length}`);
    console.log(`  - Category: ${findingsD[0].category}`);
    console.log(`  - RecoveryLevel: ${findingsD[0].recoveryLevel}`);

    const casesD = await detectionService.persistFindings(org.id, findingsD);
    console.log(`[Scenario D] Persisted RecoveryCase ID: ${casesD[0].id}`);
    console.log(`  - RecoveryLevel: ${casesD[0].recoveryLevel} (Must be AUTO_RECOVER)`);
    if (casesD[0].recoveryLevel !== RecoveryLevel.AUTO_RECOVER) {
      throw new Error('Expected AUTO_RECOVER recovery level for temporary failure');
    }
    console.log('[Scenario D] PASSED: Transient failure classified as AUTO_RECOVER.\n');

    // =========================================================================
    // SCENARIO E: REPEATED SCAN DEDUPLICATION
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('SCENARIO E: REPEATED SCAN DEDUPLICATION');
    console.log('  Re-scanning Scenarios B, C, and D must reuse existing active cases');
    console.log('----------------------------------------------------------------');

    const initialTotalCount = await prisma.recoveryCase.count({ where: { organizationId: org.id } });
    console.log(`[Scenario E] Initial active cases count: ${initialTotalCount} (Expected: 3)`);

    // Run scans again
    const repeatB = await detectionService.persistFindings(org.id, reconcileOrder(shippedUnfulfilledSnapshot));
    const repeatC = await detectionService.persistFindings(org.id, reconcileOrder(duplicateRiskSnapshot));
    const repeatD = await detectionService.persistFindings(org.id, reconcileOrder(tempFailureSnapshot));

    console.log(`  - Scenario B re-persisted ID: ${repeatB[0].id} (matches ${casesB[0].id})`);
    console.log(`  - Scenario C re-persisted ID: ${repeatC[0].id} (matches ${casesC[0].id})`);
    console.log(`  - Scenario D re-persisted ID: ${repeatD[0].id} (matches ${casesD[0].id})`);

    const finalTotalCount = await prisma.recoveryCase.count({ where: { organizationId: org.id } });
    console.log(`[Scenario E] Final total cases in DB: ${finalTotalCount}`);

    if (finalTotalCount !== initialTotalCount) {
      throw new Error(`Deduplication failed! Initial count=${initialTotalCount}, final count=${finalTotalCount}`);
    }

    // Verify 0 Jobs, 0 Approvals, 0 Workflows
    const jobsCount = await prisma.job.count({ where: { organizationId: org.id } });
    const approvalsCount = await prisma.approval.count({ where: { organizationId: org.id } });
    const workflowsCount = await prisma.workflow.count({ where: { organizationId: org.id } });

    console.log(`\n[Invariants Check]`);
    console.log(`  - Jobs created: ${jobsCount} (MUST BE 0)`);
    console.log(`  - Approvals created: ${approvalsCount} (MUST BE 0)`);
    console.log(`  - Workflows created: ${workflowsCount} (MUST BE 0)`);

    if (jobsCount !== 0 || approvalsCount !== 0 || workflowsCount !== 0) {
      throw new Error('Invariant violation: detection created Job, Approval, or Workflow!');
    }

    console.log('\n================================================================');
    console.log('  ALL RECONCILIATION DEMO SCENARIOS PASSED WITH FULL INTEGRITY! ');
    console.log('================================================================\n');
  } finally {
    await prisma.$disconnect();
  }
}

runReconciliationDemo().catch((err) => {
  console.error('Reconciliation demo failed:', err);
  process.exit(1);
});
