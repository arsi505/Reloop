/**
 * ============================================================================
 * RELOOP SYNTHETIC DEMONSTRATION & SCREENSHOT FIXTURE SEED
 * ============================================================================
 * CLASSIFICATION: SYNTHETIC FIXTURE TOOLING ONLY (LOCAL DEVELOPMENT / DEMO ONLY)
 *
 * IMPORTANT SAFETY & USAGE NOTICE:
 * 1. SYNTHETIC ONLY: This script creates synthetic mock records to populate UI
 *    views (Dashboard, Exceptions, Orders, Integrations, Recoveries) for crisp
 *    documentation screenshots and initial frontend exploratory navigation.
 * 2. NOT PROOF OF CORRECTNESS: These pre-seeded records DO NOT constitute proof
 *    of detection or autonomous recovery correctness. Day 24 manual acceptance
 *    and automated reliability tests evaluate REAL live simulator/application flows.
 * 3. NO REAL SECRETS: Contains zero real third-party API keys, OAuth tokens,
 *    production database credentials, or real customer PII.
 * 4. SAFE & NON-DESTRUCTIVE: Operates strictly within the isolated demo tenant
 *    organization ("Acme Commerce Group"). Does not drop tables, wipe unrelated
 *    tenants, or execute destructive database operations.
 * ============================================================================
 */

import { PrismaClient, Role, IntegrationProvider, IntegrationStatus, ExternalOrderStatus, RecoveryCaseType, RecoveryLevel, RecoveryCaseStatus, WorkflowStatus, JobStatus, ApprovalStatus } from '@prisma/client';
import * as argon2 from 'argon2';

async function main() {
  const prisma = new PrismaClient();

  console.log('[LOCAL DEMO FIXTURE] Seeding synthetic demonstration data for UI screenshots and navigation...\n');

  // 1. Ensure Demo Organization and User exist (LOCAL DEMO ONLY)
  const email = 'operator@reloop.test';
  const password = 'Password123!';
  const orgSlug = 'acme-commerce-group';

  let org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
  });

  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'Acme Commerce Group',
        slug: orgSlug,
      },
    });
    console.log(`Created organization: ${org.name} (${org.id})`);
  } else {
    console.log(`Using existing organization: ${org.name} (${org.id})`);
  }

  let user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    const passwordHash = await argon2.hash(password);
    user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: 'Jordan Miller',
      },
    });
    console.log(`Created demo user: ${user.name} (${user.email})`);
  }

  // Ensure organization membership with OWNER role
  const membership = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: org.id,
        userId: user.id,
      },
    },
  });

  if (!membership) {
    await prisma.organizationMember.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        role: Role.OWNER,
      },
    });
    console.log(`Assigned OWNER role to ${user.email} in ${org.name}`);
  }

  // Also bind smoketest@reloop.test if present
  const smokeUser = await prisma.user.findUnique({ where: { email: 'smoketest@reloop.test' } });
  if (smokeUser) {
    const smokeMember = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: smokeUser.id } },
    });
    if (!smokeMember) {
      await prisma.organizationMember.create({
        data: { organizationId: org.id, userId: smokeUser.id, role: Role.OWNER },
      });
    }
  }

  // 2. Clear old demo data for clean state in this org
  await prisma.auditLog.deleteMany({ where: { organizationId: org.id } });
  await prisma.approval.deleteMany({ where: { organizationId: org.id } });
  await prisma.workflowStep.deleteMany({ where: { organizationId: org.id } });
  await prisma.workflow.deleteMany({ where: { organizationId: org.id } });
  await prisma.recoveryCase.deleteMany({ where: { organizationId: org.id } });
  await prisma.externalReference.deleteMany({ where: { organizationId: org.id } });
  await prisma.externalOrder.deleteMany({ where: { organizationId: org.id } });
  await prisma.jobAttempt.deleteMany({ where: { job: { organizationId: org.id } } });
  await prisma.job.deleteMany({ where: { organizationId: org.id } });
  await prisma.integrationEvent.deleteMany({ where: { organizationId: org.id } });
  await prisma.integration.deleteMany({ where: { organizationId: org.id } });

  console.log('Cleaned previous demo data in organization.');

  // 3. Integrations
  const shopifyInt = await prisma.integration.create({
    data: {
      organizationId: org.id,
      provider: IntegrationProvider.SHOPIFY,
      name: 'Acme Flagship Shopify Store',
      status: IntegrationStatus.CONNECTED,
      shopDomain: 'acme-flagship.myshopify.com',
      encryptedCredentials: { ciphertext: 'vault_enc_shopify_mock', iv: 'aXY=', tag: 'dGFn' },
      configuration: {
        scopes: 'read_orders,read_fulfillments,write_fulfillments',
        lastSuccessfulSyncWatermark: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      },
    },
  });

  const shipstationInt = await prisma.integration.create({
    data: {
      organizationId: org.id,
      provider: IntegrationProvider.SHIPSTATION,
      name: 'Salt Lake City 3PL ShipStation',
      status: IntegrationStatus.CONNECTED,
      encryptedCredentials: { ciphertext: 'vault_enc_shipstation_mock', iv: 'aXY=', tag: 'dGFn' },
      configuration: {
        syncIntervalMinutes: 15,
        lastSuccessfulSyncWatermark: new Date(Date.now() - 22 * 60 * 1000).toISOString(),
      },
    },
  });

  const simulatorInt = await prisma.integration.create({
    data: {
      organizationId: org.id,
      provider: IntegrationProvider.SIMULATOR,
      name: 'Reverse Logistics Webhook Ingestion',
      status: IntegrationStatus.CONNECTED,
      encryptedCredentials: { ciphertext: 'vault_enc_sim_mock', iv: 'aXY=', tag: 'dGFn' },
      configuration: {
        webhookPath: '/webhooks/simulator',
      },
    },
  });

  console.log('Seeded 3 Integrations.');

  // Succeeded sync job for Shopify -> Healthy
  await prisma.job.create({
    data: {
      organizationId: org.id,
      type: 'SHOPIFY_SYNC_ORDERS',
      status: JobStatus.SUCCEEDED,
      idempotencyKey: `seed-sync-shopify-${Date.now()}`,
      completedAt: new Date(Date.now() - 12 * 60 * 1000),
    },
  });

  // Active sync job for ShipStation
  await prisma.job.create({
    data: {
      organizationId: org.id,
      type: 'SHIPSTATION_SYNC_SHIPMENTS',
      status: JobStatus.SUCCEEDED,
      idempotencyKey: `seed-sync-ss-${Date.now()}`,
      completedAt: new Date(Date.now() - 22 * 60 * 1000),
    },
  });

  // 4. External Orders
  const order1055 = await prisma.externalOrder.create({
    data: {
      organizationId: org.id,
      primaryIntegrationId: shopifyInt.id,
      externalOrderNumber: '1055',
      customerReference: 'CUST-8841',
      status: ExternalOrderStatus.FULFILLING,
      currency: 'USD',
      totalAmount: 239.50,
      sourceCreatedAt: new Date(Date.now() - 5 * 3600 * 1000),
      lastObservedAt: new Date(Date.now() - 30 * 60 * 1000),
    },
  });

  await prisma.externalReference.create({
    data: {
      organizationId: org.id,
      externalOrderId: order1055.id,
      integrationId: shipstationInt.id,
      resourceType: 'TRACKING',
      externalId: '9400111899562537624999',
      externalReference: 'USPS Priority 2-Day',
    },
  });

  const order1089 = await prisma.externalOrder.create({
    data: {
      organizationId: org.id,
      primaryIntegrationId: shopifyInt.id,
      externalOrderNumber: '1089',
      customerReference: 'CUST-9122',
      status: ExternalOrderStatus.SHIPPED,
      currency: 'USD',
      totalAmount: 412.00,
      sourceCreatedAt: new Date(Date.now() - 24 * 3600 * 1000),
      lastObservedAt: new Date(Date.now() - 1 * 3600 * 1000),
    },
  });

  const order1102 = await prisma.externalOrder.create({
    data: {
      organizationId: org.id,
      primaryIntegrationId: shopifyInt.id,
      externalOrderNumber: '1102',
      customerReference: 'CUST-3310',
      status: ExternalOrderStatus.FULFILLING,
      currency: 'USD',
      totalAmount: 85.00,
      sourceCreatedAt: new Date(Date.now() - 48 * 3600 * 1000),
      lastObservedAt: new Date(Date.now() - 2 * 3600 * 1000),
    },
  });

  const order1115 = await prisma.externalOrder.create({
    data: {
      organizationId: org.id,
      primaryIntegrationId: shopifyInt.id,
      externalOrderNumber: '1115',
      customerReference: 'CUST-7749',
      status: ExternalOrderStatus.PENDING,
      currency: 'USD',
      totalAmount: 650.00,
      sourceCreatedAt: new Date(Date.now() - 8 * 3600 * 1000),
      lastObservedAt: new Date(Date.now() - 4 * 3600 * 1000),
    },
  });

  console.log('Seeded 4 External Orders with cross-system references.');

  // 5. Recovery Cases & Exceptions
  // Case 1: TRACKING_MISSING_IN_SHOPIFY (Pending Approval)
  const case1 = await prisma.recoveryCase.create({
    data: {
      organizationId: org.id,
      externalOrderId: order1055.id,
      sourceIntegrationId: shopifyInt.id,
      type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
      recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
      status: RecoveryCaseStatus.WAITING_APPROVAL,
      summary: 'Tracking 9400111899562537624999 generated in ShipStation but missing in Shopify Fulfillment',
      detectedAt: new Date(Date.now() - 4 * 3600 * 1000),
      evidence: {
        trackingNumber: '9400111899562537624999',
        carrier: 'USPS',
        service: 'Priority Mail',
        shipStationShipmentId: 'ship_ss_882910',
        discrepancyAgeHours: 4.5,
      },
    },
  });

  const wf1 = await prisma.workflow.create({
    data: {
      organizationId: org.id,
      recoveryCaseId: case1.id,
      templateKey: 'TRACKING_SYNC_RECOVERY',
      templateVersion: 1,
      status: WorkflowStatus.WAITING,
      startedAt: new Date(Date.now() - 4 * 3600 * 1000),
    },
  });

  const step1_1 = await prisma.workflowStep.create({
    data: {
      organizationId: org.id,
      workflowId: wf1.id,
      key: 'VERIFY_CARRIER_LABEL',
      name: 'Verify Carrier Tracking Validity',
      position: 1,
      status: 'SUCCEEDED',
      startedAt: new Date(Date.now() - 4 * 3600 * 1000),
      completedAt: new Date(Date.now() - 4 * 3600 * 1000 + 450),
      output: { valid: true, carrierStatus: 'ACCEPTED_BY_USPS' },
    },
  });

  const step1_2 = await prisma.workflowStep.create({
    data: {
      organizationId: org.id,
      workflowId: wf1.id,
      key: 'AWAIT_OPERATOR_APPROVAL',
      name: 'Operator Policy Review',
      position: 2,
      status: 'WAITING',
      startedAt: new Date(Date.now() - 4 * 3600 * 1000 + 500),
    },
  });

  const approval1 = await prisma.approval.create({
    data: {
      organizationId: org.id,
      recoveryCaseId: case1.id,
      workflowId: wf1.id,
      workflowStepId: step1_2.id,
      status: ApprovalStatus.PENDING,
      requestedAt: new Date(Date.now() - 4 * 3600 * 1000 + 520),
      previewSnapshot: {
        action: 'SHOPIFY_CREATE_FULFILLMENT',
        trackingNumber: '9400111899562537624999',
        carrier: 'USPS',
        notifyCustomer: true,
        projectedSavings: '$14.20 delayed penalty waiver',
      },
    },
  });

  // Flight Recorder Audit Logs for Case 1
  await prisma.auditLog.createMany({
    data: [
      {
        organizationId: org.id,
        action: 'EXCEPTION_DETECTED',
        entityType: 'RECOVERY_CASE',
        entityId: case1.id,
        metadata: { type: 'TRACKING_MISSING_IN_SHOPIFY', orderId: order1055.id },
        createdAt: new Date(Date.now() - 4 * 3600 * 1000),
      },
      {
        organizationId: org.id,
        action: 'POLICY_ROUTED',
        entityType: 'WORKFLOW',
        entityId: wf1.id,
        metadata: { policy: 'HIGH_VALUE_HUMAN_GATE', recoveryLevel: 'REQUIRE_APPROVAL' },
        createdAt: new Date(Date.now() - 4 * 3600 * 1000 + 100),
      },
      {
        organizationId: org.id,
        action: 'STEP_COMPLETED',
        entityType: 'WORKFLOW_STEP',
        entityId: step1_1.id,
        metadata: { stepKey: 'VERIFY_CARRIER_LABEL', status: 'SUCCEEDED' },
        createdAt: new Date(Date.now() - 4 * 3600 * 1000 + 450),
      },
      {
        organizationId: org.id,
        action: 'APPROVAL_REQUESTED',
        entityType: 'APPROVAL',
        entityId: approval1.id,
        actorUserId: user.id,
        metadata: { preview: approval1.previewSnapshot },
        createdAt: new Date(Date.now() - 4 * 3600 * 1000 + 520),
      },
    ],
  });

  // Case 2: ORDER_MISSING_AT_3PL (In Progress / Auto-Recover)
  const case2 = await prisma.recoveryCase.create({
    data: {
      organizationId: org.id,
      externalOrderId: order1102.id,
      sourceIntegrationId: simulatorInt.id,
      type: RecoveryCaseType.ORDER_MISSING_AT_3PL,
      recoveryLevel: RecoveryLevel.AUTO_RECOVER,
      status: RecoveryCaseStatus.AUTO_RECOVERING,
      summary: 'Order paid in Shopify but missing at 3PL fulfillment queue; auto-dispatching sync job',
      detectedAt: new Date(Date.now() - 2 * 3600 * 1000),
      evidence: {
        rmaNumber: 'RMA-9921',
        dispositionReason: 'SYNC_TIMEOUT',
        returnedCondition: 'UNOPENED',
      },
    },
  });

  // Case 3: TEMPORARY_API_FAILURE (Open Discrepancy)
  const case3 = await prisma.recoveryCase.create({
    data: {
      organizationId: org.id,
      externalOrderId: order1115.id,
      sourceIntegrationId: shopifyInt.id,
      type: RecoveryCaseType.TEMPORARY_API_FAILURE,
      recoveryLevel: RecoveryLevel.AUTO_RECOVER,
      status: RecoveryCaseStatus.OPEN,
      summary: 'Upstream carrier webhook timeout during address verification handshake',
      detectedAt: new Date(Date.now() - 45 * 60 * 1000),
      evidence: {
        httpStatus: 504,
        endpoint: '/api/v2/addresses/validate',
        nextScheduledRetry: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    },
  });

  console.log('Seeded 3 Recovery Cases with DAG Workflows, Approval Gate, and Flight Recorder Audit Logs.');
  console.log(`\n[LOCAL DEMO ONLY] Credentials for Local UI Navigation (Synthetic Dev Data):`);
  console.log(`  URL: http://localhost:3100/login`);
  console.log(`  Email: ${email}`);
  console.log(`  Password: ${password}`);
  console.log(`  Organization: ${org.name}`);
  console.log('Seed completed successfully!');
}

main().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});
