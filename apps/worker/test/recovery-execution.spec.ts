import * as path from 'path';
import * as dotenv from 'dotenv';
import {
  PrismaClient,
  RecoveryCaseStatus,
  RecoveryCaseType,
  RecoveryLevel,
  WorkflowStatus,
  WorkflowStepStatus,
} from '@prisma/client';
import {
  WorkflowTemplateRegistry,
  registerSystemTemplates,
  registerRecoveryTemplates,
} from '@reloop/workflow-core';
import {
  SimulatorRecoveryActionAdapter,
  ShopifyOrder,
  WarehouseOrder,
  buildLogicalOperationKey,
} from '@reloop/connector-simulator';
import {
  WorkflowStepHandlerRegistry,
  registerRecoveryStepHandlers,
} from '../src';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:reloop_app_dev_password@localhost:5433/reloop_test?schema=public';

describe('Day 13: Verified Recovery Execution & Safety Fences', () => {
  let prisma: PrismaClient;
  let registry: WorkflowTemplateRegistry;
  let stepRegistry: WorkflowStepHandlerRegistry;
  let actionAdapter: SimulatorRecoveryActionAdapter;

  let orgId: string;
  const runId = Math.random().toString(36).substring(2, 7);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();

    registry = new WorkflowTemplateRegistry();
    registerSystemTemplates(registry);
    registerRecoveryTemplates(registry);

    stepRegistry = new WorkflowStepHandlerRegistry();
    actionAdapter = new SimulatorRecoveryActionAdapter();

    registerRecoveryStepHandlers(stepRegistry, {
      actionExecutor: actionAdapter,
      resolveCaseCallback: async ({ caseId, organizationId, workflowId, verifyStepKey, verificationOutput }) => {
        // Direct mock of case resolution
        if (verificationOutput.verified) {
          await prisma.recoveryCase.update({
            where: { id: caseId },
            data: {
              status: RecoveryCaseStatus.RESOLVED,
              resolvedAt: new Date(),
              evidence: {
                resolution: {
                  resolvedByWorkflowId: workflowId,
                  invariantPassed: verificationOutput.invariantPassed,
                  verifiedAt: new Date().toISOString(),
                },
              },
            },
          });
        }
      },
    });

    const org = await prisma.organization.create({
      data: { name: `Org Recovery ${runId}`, slug: `org-rec-${runId}` },
    });
    orgId = org.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    actionAdapter.clearAuditLog();
    actionAdapter.simulateCommitThenTimeoutForOperations.clear();
  });

  describe('1. Missing Shopify Tracking (Auto Recovery)', () => {
    it('executes full pipeline: CHECK -> EXECUTE -> VERIFY -> RESOLVED with mutation count = 1', async () => {
      const orderNumber = `ORD-TRK-SAFE-${runId}`;
      const trackingNumber = `TRK-SAFE-${runId}`;

      // Seed simulator state
      actionAdapter.seedShopifyOrder({
        id: `shp-${orderNumber}`,
        orderNumber,
        fulfillmentStatus: 'UNFULFILLED',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      actionAdapter.seedWarehouseOrder({
        id: `wh-${orderNumber}`,
        orderNumber,
        status: 'SHIPPED',
        trackingNumber,
        carrier: 'FedEx',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          status: RecoveryCaseStatus.AUTO_RECOVERING,
          summary: 'Missing tracking',
          dedupeKey: `${orderNumber}:TRACKING_MISSING_IN_SHOPIFY`,
        },
      });

      // 1. CHECK step
      const checkRes = await stepRegistry.execute('RECOVERY_CHECK_TRACKING', {
        workflowId: 'wf-1',
        workflowStepId: 'step-1',
        stepKey: 'CHECK',
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId: rCase.id },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(checkRes.output?.safeToExecute).toBe(true);
      expect(checkRes.output?.trackingNumber).toBe(trackingNumber);

      // Invariant: CHECK does NOT resolve case
      let caseCheck = await prisma.recoveryCase.findUnique({ where: { id: rCase.id } });
      expect(caseCheck?.status).toBe(RecoveryCaseStatus.AUTO_RECOVERING);

      // 2. EXECUTE step
      const execRes = await stepRegistry.execute('RECOVERY_EXECUTE_TRACKING', {
        workflowId: 'wf-1',
        workflowStepId: 'step-2',
        stepKey: 'EXECUTE',
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId: rCase.id, trackingNumber },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(execRes.output?.executed).toBe(true);

      // Invariant: EXECUTE does NOT resolve case
      caseCheck = await prisma.recoveryCase.findUnique({ where: { id: rCase.id } });
      expect(caseCheck?.status).toBe(RecoveryCaseStatus.AUTO_RECOVERING);

      // 3. VERIFY step
      const verifyRes = await stepRegistry.execute('RECOVERY_VERIFY_TRACKING', {
        workflowId: 'wf-1',
        workflowStepId: 'step-3',
        stepKey: 'VERIFY',
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId: rCase.id },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(verifyRes.output?.verified).toBe(true);
      expect(verifyRes.output?.invariantPassed).toBe('TRACKING_CONSISTENCY');

      // Final Invariant: VERIFY marks case RESOLVED
      const finalCase = await prisma.recoveryCase.findUnique({ where: { id: rCase.id } });
      expect(finalCase?.status).toBe(RecoveryCaseStatus.RESOLVED);
      expect(finalCase?.resolvedAt).toBeDefined();

      // Mutation count = 1
      const opKey = buildLogicalOperationKey(orgId, 'shopify', 'UPDATE_TRACKING', rCase.id);
      expect(actionAdapter.getMutationCount(opKey)).toBe(1);
    });

    it('CHECK cancellation: when order is already healthy, mutation is skipped and no redundant write occurs', async () => {
      const orderNumber = `ORD-ALREADY-HEALTHY-${runId}`;
      const trackingNumber = `TRK-HEALTHY-${runId}`;

      // Seed already healthy order
      actionAdapter.seedShopifyOrder({
        id: `shp-${orderNumber}`,
        orderNumber,
        fulfillmentStatus: 'FULFILLED',
        trackingNumber,
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      actionAdapter.seedWarehouseOrder({
        id: `wh-${orderNumber}`,
        orderNumber,
        status: 'SHIPPED',
        trackingNumber,
        carrier: 'FedEx',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const checkRes = await stepRegistry.execute('RECOVERY_CHECK_TRACKING', {
        workflowId: 'wf-2',
        workflowStepId: 'step-1',
        stepKey: 'CHECK',
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId: 'case-healthy' },
        organizationId: orgId,
        workerId: 'worker-1',
      });

      expect(checkRes.output?.noActionNeeded).toBe(true);
      expect(checkRes.output?.resolvedClean).toBe(true);

      // EXECUTE should skip mutation
      const execRes = await stepRegistry.execute('RECOVERY_EXECUTE_TRACKING', {
        workflowId: 'wf-2',
        workflowStepId: 'step-2',
        stepKey: 'EXECUTE',
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId: 'case-healthy' },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(execRes.output?.skippedMutation).toBe(true);

      const opKey = buildLogicalOperationKey(orgId, 'shopify', 'UPDATE_TRACKING', 'case-healthy');
      expect(actionAdapter.getMutationCount(opKey)).toBe(0);
    });

    it('CHECK escalation: injected conflict throws error and halts workflow before mutation', async () => {
      const orderNumber = `ORD-CONFLICT-${runId}`;

      actionAdapter.seedShopifyOrder({
        id: `shp-${orderNumber}`,
        orderNumber,
        fulfillmentStatus: 'UNFULFILLED',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      actionAdapter.seedWarehouseOrder({
        id: `wh-${orderNumber}`,
        orderNumber,
        status: 'SHIPPED',
        trackingNumber: 'TRK-CONFLICT-999',
        carrier: 'CONFLICT_CARRIER',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await expect(
        stepRegistry.execute('RECOVERY_CHECK_TRACKING', {
          workflowId: 'wf-conflict',
          workflowStepId: 'step-1',
          stepKey: 'CHECK',
          templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
          templateVersion: 1,
          attemptNumber: 1,
          payload: { orderNumber, caseId: 'case-conflict' },
          organizationId: orgId,
          workerId: 'worker-1',
        }),
      ).rejects.toThrow(/Conflicting shipment identity/);
    });

    it('commit-then-timeout ambiguity: verifies applied external state and does not duplicate mutation', async () => {
      const orderNumber = `ORD-TIMEOUT-${runId}`;
      const trackingNumber = `TRK-TIMEOUT-${runId}`;
      const caseId = `case-timeout-${runId}`;

      actionAdapter.seedShopifyOrder({
        id: `shp-${orderNumber}`,
        orderNumber,
        fulfillmentStatus: 'UNFULFILLED',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      actionAdapter.seedWarehouseOrder({
        id: `wh-${orderNumber}`,
        orderNumber,
        status: 'SHIPPED',
        trackingNumber,
        carrier: 'FedEx',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const opKey = buildLogicalOperationKey(orgId, 'shopify', 'UPDATE_TRACKING', caseId);
      actionAdapter.simulateCommitThenTimeoutForOperations.add(opKey);

      // Attempt 1: receives timeout, but recovers because state was committed
      const execRes = await stepRegistry.execute('RECOVERY_EXECUTE_TRACKING', {
        workflowId: 'wf-timeout',
        workflowStepId: 'step-2',
        stepKey: 'EXECUTE',
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId, trackingNumber },
        organizationId: orgId,
        workerId: 'worker-1',
      });

      expect(execRes.output?.executed).toBe(true);
      expect(execRes.output?.recoveredFromAmbiguity).toBe(true);
      expect(actionAdapter.getMutationCount(opKey)).toBe(1);
    });
  });

  describe('2. Order Missing at 3PL & Shipped Unfulfilled Approval Workflows', () => {
    it('order missing at 3PL: creates warehouse order and verifies receipt', async () => {
      const orderNumber = `ORD-3PL-${runId}`;
      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgId,
          type: RecoveryCaseType.ORDER_MISSING_AT_3PL,
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
          status: RecoveryCaseStatus.WAITING_APPROVAL,
          summary: 'Missing 3PL order',
        },
      });
      const caseId = rCase.id;

      actionAdapter.seedShopifyOrder({
        id: `shp-${orderNumber}`,
        orderNumber,
        fulfillmentStatus: 'UNFULFILLED',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // CHECK
      const checkRes = await stepRegistry.execute('RECOVERY_CHECK_ORDER_3PL', {
        workflowId: 'wf-3pl',
        workflowStepId: 'step-1',
        stepKey: 'CHECK',
        templateKey: 'RECOVERY_ORDER_MISSING_3PL',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(checkRes.output?.safeToExecute).toBe(true);

      // EXECUTE (after approval)
      const execRes = await stepRegistry.execute('RECOVERY_EXECUTE_ORDER_3PL', {
        workflowId: 'wf-3pl',
        workflowStepId: 'step-3',
        stepKey: 'EXECUTE',
        templateKey: 'RECOVERY_ORDER_MISSING_3PL',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(execRes.output?.executed).toBe(true);

      // VERIFY
      const verifyRes = await stepRegistry.execute('RECOVERY_VERIFY_ORDER_3PL', {
        workflowId: 'wf-3pl',
        workflowStepId: 'step-4',
        stepKey: 'VERIFY',
        templateKey: 'RECOVERY_ORDER_MISSING_3PL',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(verifyRes.output?.verified).toBe(true);
      expect(verifyRes.output?.invariantPassed).toBe('WAREHOUSE_ORDER_EXISTS');

      const opKey = buildLogicalOperationKey(orgId, 'generic-3pl', 'CREATE_ORDER', caseId);
      expect(actionAdapter.getMutationCount(opKey)).toBe(1);
    });

    it('shipped at 3PL / unfulfilled in Shopify: marks fulfilled and verifies state convergence', async () => {
      const orderNumber = `ORD-SHP-UNF-${runId}`;
      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgId,
          type: RecoveryCaseType.SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY,
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
          status: RecoveryCaseStatus.WAITING_APPROVAL,
          summary: 'Shipped unfulfilled order',
        },
      });
      const caseId = rCase.id;

      actionAdapter.seedShopifyOrder({
        id: `shp-${orderNumber}`,
        orderNumber,
        fulfillmentStatus: 'UNFULFILLED',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      actionAdapter.seedWarehouseOrder({
        id: `wh-${orderNumber}`,
        orderNumber,
        status: 'SHIPPED',
        trackingNumber: 'TRK-SHP-123',
        carrier: 'FedEx',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // CHECK
      const checkRes = await stepRegistry.execute('RECOVERY_CHECK_SHIPPED_UNFULFILLED', {
        workflowId: 'wf-shpunf',
        workflowStepId: 'step-1',
        stepKey: 'CHECK',
        templateKey: 'RECOVERY_SHIPPED_UNFULFILLED',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(checkRes.output?.safeToExecute).toBe(true);

      // EXECUTE
      const execRes = await stepRegistry.execute('RECOVERY_EXECUTE_SHIPPED_UNFULFILLED', {
        workflowId: 'wf-shpunf',
        workflowStepId: 'step-3',
        stepKey: 'EXECUTE',
        templateKey: 'RECOVERY_SHIPPED_UNFULFILLED',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId, trackingNumber: 'TRK-SHP-123' },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(execRes.output?.executed).toBe(true);

      // VERIFY
      const verifyRes = await stepRegistry.execute('RECOVERY_VERIFY_SHIPPED_UNFULFILLED', {
        workflowId: 'wf-shpunf',
        workflowStepId: 'step-4',
        stepKey: 'VERIFY',
        templateKey: 'RECOVERY_SHIPPED_UNFULFILLED',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(verifyRes.output?.verified).toBe(true);
      expect(verifyRes.output?.invariantPassed).toBe('FULFILLMENT_STATE_CONSISTENCY');
    });
  });

  describe('3. Read-Only Stuck Order Investigation', () => {
    it('stuck order investigation performs strictly ZERO mutations and does NOT resolve case', async () => {
      const orderNumber = `ORD-STUCK-${runId}`;

      actionAdapter.seedShopifyOrder({
        id: `shp-${orderNumber}`,
        orderNumber,
        fulfillmentStatus: 'UNFULFILLED',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgId,
          type: RecoveryCaseType.STUCK_ORDER,
          recoveryLevel: RecoveryLevel.AUTO_INVESTIGATE,
          status: RecoveryCaseStatus.INVESTIGATING,
          summary: 'Stuck order investigation',
          dedupeKey: `${orderNumber}:STUCK_ORDER`,
        },
      });

      // CHECK
      await stepRegistry.execute('RECOVERY_CHECK_STUCK_ORDER', {
        workflowId: 'wf-stuck',
        workflowStepId: 'step-1',
        stepKey: 'CHECK',
        templateKey: 'RECOVERY_STUCK_INVESTIGATION',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId: rCase.id },
        organizationId: orgId,
        workerId: 'worker-1',
      });

      // INVESTIGATE
      const invRes = await stepRegistry.execute('RECOVERY_INVESTIGATE_STUCK_ORDER', {
        workflowId: 'wf-stuck',
        workflowStepId: 'step-2',
        stepKey: 'INVESTIGATE',
        templateKey: 'RECOVERY_STUCK_INVESTIGATION',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId: rCase.id },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(invRes.output?.investigated).toBe(true);
      expect(invRes.output?.mutationsPerformed).toBe(0);

      // VERIFY
      const verRes = await stepRegistry.execute('RECOVERY_VERIFY_STUCK_ORDER', {
        workflowId: 'wf-stuck',
        workflowStepId: 'step-3',
        stepKey: 'VERIFY',
        templateKey: 'RECOVERY_STUCK_INVESTIGATION',
        templateVersion: 1,
        attemptNumber: 1,
        payload: { orderNumber, caseId: rCase.id },
        organizationId: orgId,
        workerId: 'worker-1',
      });
      expect(verRes.output?.verified).toBe(false);
      expect(verRes.output?.requiresHumanReview).toBe(true);

      // Invariant: Case is NOT resolved
      const finalCase = await prisma.recoveryCase.findUnique({ where: { id: rCase.id } });
      expect(finalCase?.status).toBe(RecoveryCaseStatus.INVESTIGATING);
      expect(finalCase?.resolvedAt).toBeNull();
    });
  });

  describe('4. VERIFY Failure & Invariant Enforcement', () => {
    it('HTTP 200 / handler success does NOT resolve case when VERIFY fails', async () => {
      const orderNumber = `ORD-WRONG-VERIFY-${runId}`;
      const caseId = `case-wrong-${runId}`;

      // Seed Shopify with DIFFERENT tracking than warehouse
      actionAdapter.seedShopifyOrder({
        id: `shp-${orderNumber}`,
        orderNumber,
        fulfillmentStatus: 'FULFILLED',
        trackingNumber: 'TRK-SHOPIFY-WRONG',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      actionAdapter.seedWarehouseOrder({
        id: `wh-${orderNumber}`,
        orderNumber,
        status: 'SHIPPED',
        trackingNumber: 'TRK-WAREHOUSE-ACTUAL',
        carrier: 'FedEx',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '123 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          status: RecoveryCaseStatus.AUTO_RECOVERING,
          summary: 'Wrong state test',
          dedupeKey: `${orderNumber}:TRACKING_MISSING_IN_SHOPIFY`,
        },
      });

      // VERIFY must fail
      await expect(
        stepRegistry.execute('RECOVERY_VERIFY_TRACKING', {
          workflowId: 'wf-wrong',
          workflowStepId: 'step-3',
          stepKey: 'VERIFY',
          templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
          templateVersion: 1,
          attemptNumber: 1,
          payload: { orderNumber, caseId: rCase.id },
          organizationId: orgId,
          workerId: 'worker-1',
        }),
      ).rejects.toThrow(/Verification failed/);

      // Case remains unresolved
      const finalCase = await prisma.recoveryCase.findUnique({ where: { id: rCase.id } });
      expect(finalCase?.status).toBe(RecoveryCaseStatus.AUTO_RECOVERING);
      expect(finalCase?.resolvedAt).toBeNull();
    });
  });
});
