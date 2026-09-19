import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { PrismaClient, IntegrationProvider, IntegrationStatus, IntegrationEventStatus, RecoveryCaseType, RecoveryLevel } from '@prisma/client';
import { SimulatorWebhookAdapter } from '@reloop/connector-simulator';
import { WebhookEventProcessorService } from '../apps/api/src/webhooks/webhook-event-processor.service';
import { WebhooksService } from '../apps/api/src/webhooks/webhooks.service';
import { TargetedReconciliationService } from '../apps/api/src/webhooks/targeted-reconciliation.service';
import { ConfigService } from '@nestjs/config';

async function runDemo() {
  console.log('================================================================');
  console.log('  RELOOP DAY 14: SECURE WEBHOOK INGESTION & EVENT DEDUPLICATION  ');
  console.log('================================================================\n');

  const prisma = new PrismaClient();
  await prisma.$connect();

  const adapter = new SimulatorWebhookAdapter();
  const testSecret = 'demo_webhook_secret_key_999';

  const configService = {
    get: (key: string) => {
      if (key === 'webhookMaxPayloadBytes') return 1048576;
      if (key === 'simulatorWebhookSecret') return testSecret;
      return null;
    },
  } as any as ConfigService;

  const targetedRecon = new TargetedReconciliationService(prisma as any);
  const processor = new WebhookEventProcessorService(prisma as any, targetedRecon);
  const webhooksService = new WebhooksService(prisma as any, configService, processor);

  const runId = Math.random().toString(36).substring(2, 8);
  const org = await prisma.organization.create({
    data: { name: `Webhook Demo Org ${runId}`, slug: `webhook-demo-org-${runId}` },
  });
  console.log(`[Setup] Created Demo Organization: ${org.name} (${org.id})`);

  const shopifyInt = await prisma.integration.create({
    data: {
      organizationId: org.id,
      provider: IntegrationProvider.SIMULATOR,
      name: 'Shopify Simulator',
      status: IntegrationStatus.CONNECTED,
      configuration: { webhookSecret: testSecret },
    },
  });

  const warehouseInt = await prisma.integration.create({
    data: {
      organizationId: org.id,
      provider: IntegrationProvider.GENERIC_3PL,
      name: '3PL Warehouse Simulator',
      status: IntegrationStatus.CONNECTED,
      configuration: { webhookSecret: testSecret },
    },
  });

  // --------------------------------------------------------------------------
  // SCENARIO A: HEALTHY WEBHOOK (0 CASES)
  // --------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------');
  console.log('SCENARIO A: VALID HEALTHY WEBHOOK');
  console.log('  Consistent state across Shopify and 3PL -> 0 RecoveryCases');
  console.log('----------------------------------------------------------------');

  const orderA = `ORD-DEMO-A-${runId}`;
  const payloadA1 = {
    orderNumber: orderA,
    status: 'FULFILLED',
    fulfillmentStatus: 'FULFILLED',
    trackingNumber: `TRK-A-${runId}`,
    carrier: 'USPS',
    lineItems: [{ sku: 'SKU-A', quantity: 1, name: 'Item A' }],
  };
  const bodyA1 = Buffer.from(JSON.stringify(payloadA1), 'utf8');
  const sigA1 = adapter.signPayload(bodyA1, testSecret);
  const resA1 = await webhooksService.ingestWebhook(
    'simulator',
    shopifyInt.id,
    bodyA1,
    { 'x-reloop-signature': sigA1, 'x-reloop-event-id': `evt_a1_${runId}`, 'x-reloop-event-type': 'FULFILLMENT_UPDATED' },
    payloadA1,
  );
  await processor.processEvent(resA1.eventId);

  const payloadA2 = {
    orderNumber: orderA,
    shipmentStatus: 'SHIPPED',
    trackingNumber: `TRK-A-${runId}`,
    carrier: 'USPS',
    lineItems: [{ sku: 'SKU-A', quantity: 1 }],
  };
  const bodyA2 = Buffer.from(JSON.stringify(payloadA2), 'utf8');
  const sigA2 = adapter.signPayload(bodyA2, testSecret);
  const resA2 = await webhooksService.ingestWebhook(
    'simulator',
    warehouseInt.id,
    bodyA2,
    { 'x-reloop-signature': sigA2, 'x-reloop-event-id': `evt_a2_${runId}`, 'x-reloop-event-type': 'SHIPMENT_UPDATED' },
    payloadA2,
  );
  await processor.processEvent(resA2.eventId);

  const casesA = await prisma.recoveryCase.findMany({
    where: { organizationId: org.id, dedupeKey: { startsWith: orderA } },
  });
  console.log(`[Scenario A] IntegrationEvents ingested: 2`);
  console.log(`[Scenario A] RecoveryCases created (Must be 0): ${casesA.length}`);
  if (casesA.length === 0) {
    console.log('[Scenario A] PASSED: Healthy consistent webhooks produced zero RecoveryCases.');
  } else {
    throw new Error('[Scenario A] FAILED: Unexpected RecoveryCase created.');
  }

  // --------------------------------------------------------------------------
  // SCENARIO B: DUPLICATE DELIVERY (IDEMPOTENT DEDUPE)
  // --------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------');
  console.log('SCENARIO B: DUPLICATE DELIVERY DEDUPLICATION');
  console.log('  Same provider event ID sent 5 times concurrently -> exactly 1 event');
  console.log('----------------------------------------------------------------');

  const orderB = `ORD-DEMO-B-${runId}`;
  const providerEventIdB = `evt_dedupe_${runId}_99`;
  const payloadB = {
    orderNumber: orderB,
    status: 'PAID',
    providerEventId: providerEventIdB,
    lineItems: [{ sku: 'SKU-B', quantity: 2 }],
  };
  const bodyB = Buffer.from(JSON.stringify(payloadB), 'utf8');
  const sigB = adapter.signPayload(bodyB, testSecret);

  const duplicateDeliveries = await Promise.all(
    Array.from({ length: 5 }, () =>
      webhooksService.ingestWebhook(
        'simulator',
        shopifyInt.id,
        bodyB,
        { 'x-reloop-signature': sigB, 'x-reloop-event-id': providerEventIdB },
        payloadB,
      ),
    ),
  );

  const acceptedCount = duplicateDeliveries.filter((d) => d.status === 'accepted').length;
  const duplicateCount = duplicateDeliveries.filter((d) => d.status === 'ignored_duplicate').length;
  const eventsBInDb = await prisma.integrationEvent.count({
    where: { integrationId: shopifyInt.id, providerEventId: providerEventIdB },
  });

  console.log(`[Scenario B] Deliveries accepted: ${acceptedCount}`);
  console.log(`[Scenario B] Deliveries deduped as ignored_duplicate: ${duplicateCount}`);
  console.log(`[Scenario B] Database IntegrationEvent rows (Must be 1): ${eventsBInDb}`);
  if (acceptedCount === 1 && duplicateCount === 4 && eventsBInDb === 1) {
    console.log('[Scenario B] PASSED: Duplicate delivery successfully converged to exactly 1 event.');
  } else {
    throw new Error('[Scenario B] FAILED: Concurrency deduplication violated.');
  }

  // --------------------------------------------------------------------------
  // SCENARIO C: 3PL SHIPPED DISCREPANCY WEBHOOK -> 1 REQUIRE_APPROVAL CASE
  // --------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------');
  console.log('SCENARIO C: 3PL SHIPPED / SHOPIFY UNFULFILLED');
  console.log('  3PL reports SHIPPED but Shopify UNFULFILLED -> 1 REQUIRE_APPROVAL case');
  console.log('----------------------------------------------------------------');

  const orderC = `ORD-DEMO-C-${runId}`;
  const payloadC1 = {
    orderNumber: orderC,
    status: 'UNFULFILLED',
    fulfillmentStatus: 'UNFULFILLED',
    lineItems: [{ sku: 'SKU-C', quantity: 1 }],
  };
  const bodyC1 = Buffer.from(JSON.stringify(payloadC1), 'utf8');
  const sigC1 = adapter.signPayload(bodyC1, testSecret);
  const resC1 = await webhooksService.ingestWebhook(
    'simulator',
    shopifyInt.id,
    bodyC1,
    { 'x-reloop-signature': sigC1, 'x-reloop-event-id': `evt_c1_${runId}`, 'x-reloop-event-type': 'ORDER_CREATED' },
    payloadC1,
  );
  await processor.processEvent(resC1.eventId);

  const payloadC2 = {
    orderNumber: orderC,
    shipmentStatus: 'SHIPPED',
    trackingNumber: `TRK-3PL-${runId}`,
    carrier: 'FedEx',
    lineItems: [{ sku: 'SKU-C', quantity: 1 }],
  };
  const bodyC2 = Buffer.from(JSON.stringify(payloadC2), 'utf8');
  const sigC2 = adapter.signPayload(bodyC2, testSecret);
  const resC2 = await webhooksService.ingestWebhook(
    'simulator',
    warehouseInt.id,
    bodyC2,
    { 'x-reloop-signature': sigC2, 'x-reloop-event-id': `evt_c2_${runId}`, 'x-reloop-event-type': 'SHIPMENT_UPDATED' },
    payloadC2,
  );
  await processor.processEvent(resC2.eventId);

  const casesC = await prisma.recoveryCase.findMany({
    where: { organizationId: org.id, dedupeKey: { startsWith: orderC } },
  });
  console.log(`[Scenario C] Detected RecoveryCase count (Must be 1): ${casesC.length}`);
  if (casesC.length === 1) {
    const c = casesC[0];
    console.log(`[Scenario C] RecoveryCase Type: ${c.type}`);
    console.log(`[Scenario C] RecoveryCase Level: ${c.recoveryLevel}`);
    console.log(`[Scenario C] RecoveryCase Status: ${c.status}`);

    const directApprovals = await prisma.approval.count({ where: { recoveryCaseId: c.id } });
    const directWorkflows = await prisma.workflow.count({ where: { recoveryCaseId: c.id } });
    console.log(`[Scenario C] Direct Approvals created by webhook (Must be 0): ${directApprovals}`);
    console.log(`[Scenario C] Direct Workflows created by webhook (Must be 0): ${directWorkflows}`);

    if (
      c.type === RecoveryCaseType.SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY &&
      c.recoveryLevel === RecoveryLevel.REQUIRE_APPROVAL &&
      directApprovals === 0 &&
      directWorkflows === 0
    ) {
      console.log('[Scenario C] PASSED: Discrepancy triggered RecoveryCase with ZERO direct recovery side effects.');
    } else {
      throw new Error('[Scenario C] FAILED: Case attributes or boundary violated.');
    }
  } else {
    throw new Error('[Scenario C] FAILED: Expected 1 RecoveryCase.');
  }

  // --------------------------------------------------------------------------
  // SCENARIO D: INVALID SIGNATURE REJECTION
  // --------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------');
  console.log('SCENARIO D: INVALID SIGNATURE REJECTION');
  console.log('  Tampered/forged signature rejected -> 0 IntegrationEvents');
  console.log('----------------------------------------------------------------');

  const orderD = `ORD-DEMO-D-${runId}`;
  const payloadD = { orderNumber: orderD };
  const bodyD = Buffer.from(JSON.stringify(payloadD), 'utf8');
  const badSig = '0000000000000000000000000000000000000000000000000000000000000000';

  let caughtError: any = null;
  try {
    await webhooksService.ingestWebhook(
      'simulator',
      shopifyInt.id,
      bodyD,
      { 'x-reloop-signature': badSig, 'x-reloop-event-id': `evt_bad_${runId}` },
      payloadD,
    );
  } catch (err: any) {
    caughtError = err;
  }

  console.log(`[Scenario D] Caught security exception: ${caughtError?.message || caughtError}`);
  const eventDCount = await prisma.integrationEvent.count({
    where: { integrationId: shopifyInt.id, providerEventId: `evt_bad_${runId}` },
  });
  console.log(`[Scenario D] Events stored in database (Must be 0): ${eventDCount}`);

  if (caughtError && eventDCount === 0) {
    console.log('[Scenario D] PASSED: Invalid signature securely rejected with zero side effects.');
  } else {
    throw new Error('[Scenario D] FAILED: Invalid signature was not properly rejected.');
  }

  // --------------------------------------------------------------------------
  // SCENARIO E: OUT-OF-ORDER EVENT DELIVERY
  // --------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------');
  console.log('SCENARIO E: OUT-OF-ORDER EVENT FENCING');
  console.log('  Newer event processed first; older delayed event arrives later');
  console.log('----------------------------------------------------------------');

  const orderE = `ORD-DEMO-E-${runId}`;
  const tNewer = new Date('2026-09-19T15:00:00Z');
  const tOlder = new Date('2026-09-19T14:00:00Z');

  // Process newer event first
  const evNewer = await prisma.integrationEvent.create({
    data: {
      organizationId: org.id,
      integrationId: shopifyInt.id,
      providerEventId: `evt_newer_${runId}`,
      eventType: 'ORDER_UPDATED',
      payload: { orderNumber: orderE, status: 'SHIPPED', occurredAt: tNewer.toISOString(), lineItems: [{ sku: 'SKU-E', quantity: 1 }] },
      status: IntegrationEventStatus.RECEIVED,
    },
  });
  await processor.processEvent(evNewer.id);

  const orderAfterNewer = await prisma.externalOrder.findUnique({
    where: { organizationId_externalOrderNumber: { organizationId: org.id, externalOrderNumber: orderE } },
  });
  console.log(`[Scenario E] Order status after newer event: ${orderAfterNewer?.status}`);

  // Process older delayed event
  const evOlder = await prisma.integrationEvent.create({
    data: {
      organizationId: org.id,
      integrationId: shopifyInt.id,
      providerEventId: `evt_older_${runId}`,
      eventType: 'ORDER_UPDATED',
      payload: { orderNumber: orderE, status: 'PENDING', occurredAt: tOlder.toISOString(), lineItems: [{ sku: 'SKU-E', quantity: 1 }] },
      status: IntegrationEventStatus.RECEIVED,
    },
  });
  await processor.processEvent(evOlder.id);

  const orderAfterOlder = await prisma.externalOrder.findUnique({
    where: { organizationId_externalOrderNumber: { organizationId: org.id, externalOrderNumber: orderE } },
  });
  console.log(`[Scenario E] Order status after delayed older event: ${orderAfterOlder?.status}`);

  const olderEventRecord = await prisma.integrationEvent.findUnique({ where: { id: evOlder.id } });
  console.log(`[Scenario E] Older event note: ${olderEventRecord?.errorMessage}`);

  if (
    orderAfterOlder?.status === 'SHIPPED' &&
    olderEventRecord?.errorMessage === 'SUPERSEDED_BY_NEWER_STATE'
  ) {
    console.log('[Scenario E] PASSED: Older event did not regress newer business state.');
  } else {
    throw new Error('[Scenario E] FAILED: State regressed due to out-of-order event.');
  }

  console.log('\n================================================================');
  console.log('  ALL DAY 14 WEBHOOK DEMO SCENARIOS PASSED WITH FULL INTEGRITY!  ');
  console.log('================================================================\n');

  await prisma.$disconnect();
}

runDemo().catch((err) => {
  console.error('[Demo Failed]', err);
  process.exit(1);
});
