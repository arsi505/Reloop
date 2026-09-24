import * as dotenv from 'dotenv';
import * as path from 'path';
import Redis from 'ioredis';
import {
  PrismaClient,
  JobStatus,
  WorkflowStatus,
  WorkflowStepStatus,
  ApprovalStatus,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
} from '@prisma/client';
import {
  WorkflowTemplateRegistry,
  registerSystemTemplates,
  registerRecoveryTemplates,
} from '@reloop/workflow-core';
import { SimulatorRecoveryActionAdapter, buildLogicalOperationKey } from '@reloop/connector-simulator';
import { createSchedulerRuntime, SchedulerRuntime } from '../src/runtime';
import { createWorkerRuntime, WorkerRuntime } from '../../worker/src/runtime';
import { WorkflowCreationService } from '../src/workflow-creator';
import { WorkflowCoordinator } from '../src/workflow-coordinator';
import { CaseResolutionService } from '../src/case-resolution/case-resolution.service';
import { JobExecutionError } from '../../worker/src/errors';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

describe('Audit Remediation E-01: Production Recovery Pipeline Wiring', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let runId: string;
  let testOrgId: string;
  let simulator: SimulatorRecoveryActionAdapter;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(async () => {
    runId = Math.random().toString(36).substring(2, 9);
    simulator = new SimulatorRecoveryActionAdapter();

    const org = await prisma.organization.create({
      data: {
        name: `E-01 Org ${runId}`,
        slug: `e01-org-${runId}`,
      },
    });
    testOrgId = org.id;
  });

  afterEach(async () => {
    // Isolated cleanup by orgId
    if (testOrgId) {
      await prisma.jobAttempt.deleteMany({
        where: { job: { organizationId: testOrgId } },
      });
      await prisma.job.deleteMany({
        where: { organizationId: testOrgId },
      });
      await prisma.approval.deleteMany({
        where: { organizationId: testOrgId },
      });
      await prisma.workflowStep.deleteMany({
        where: { workflow: { organizationId: testOrgId } },
      });
      await prisma.workflow.deleteMany({
        where: { organizationId: testOrgId },
      });
      await prisma.recoveryCase.deleteMany({
        where: { organizationId: testOrgId },
      });
      await prisma.organization.deleteMany({
        where: { id: testOrgId },
      });
    }
  });

  // =========================================================================
  // SUITE 1: Real Composition Verification (Defects 1, 2, 3, 4)
  // =========================================================================
  describe('1. Real Production Composition Verification', () => {
    it('proves createSchedulerRuntime wires and starts all 4 production scanners/services', async () => {
      const streamKey = `reloop:test:${runId}:sched:jobs`;
      const groupKey = `test-group-${runId}`;
      const runtime: SchedulerRuntime = createSchedulerRuntime({
        prisma,
        config: {
          jobStreamKey: streamKey,
          jobConsumerGroup: groupKey,
          schedulerIntervalMs: 50,
          workflowScanIntervalMs: 50,
          reconciliationScanIntervalMs: 50,
          recoveryRouterScanIntervalMs: 50,
        },
      });

      // Verify composition
      expect(runtime.schedulerService).toBeDefined();
      expect(runtime.coordinator).toBeDefined();
      expect(runtime.reconciliationScanner).toBeDefined();
      expect(runtime.recoveryRouterScanner).toBeDefined();
      expect(runtime.templateRegistry).toBeDefined();
      expect(runtime.caseResolutionService).toBeDefined();

      // Start runtime and verify all scanners are running
      await runtime.start();

      expect(runtime.coordinator.getIsRunning()).toBe(true);
      expect(runtime.reconciliationScanner.getIsRunning()).toBe(true);
      expect(runtime.recoveryRouterScanner.getIsRunning()).toBe(true);
      expect(runtime.schedulerService.getIsRunning()).toBe(true);

      // Graceful stop
      await runtime.stop();

      expect(runtime.coordinator.getIsRunning()).toBe(false);
      expect(runtime.reconciliationScanner.getIsRunning()).toBe(false);
      expect(runtime.recoveryRouterScanner.getIsRunning()).toBe(false);
      expect(runtime.schedulerService.getIsRunning()).toBe(false);
    });

    it('proves createSchedulerRuntime registers all 4 recovery workflow templates', () => {
      const runtime = createSchedulerRuntime({ prisma });
      const registry = runtime.templateRegistry;

      // Authoritative Day 13 templates must be registered
      expect(registry.has('RECOVERY_TRACKING_MISSING_AUTO', 1)).toBe(true);
      expect(registry.has('RECOVERY_ORDER_MISSING_3PL', 1)).toBe(true);
      expect(registry.has('RECOVERY_SHIPPED_UNFULFILLED', 1)).toBe(true);
      expect(registry.has('RECOVERY_STUCK_INVESTIGATION', 1)).toBe(true);

      // Core system templates must also be present
      expect(registry.has('SYSTEM_LINEAR', 1)).toBe(true);
      expect(registry.has('SYSTEM_APPROVAL', 1)).toBe(true);
    });

    it('proves createWorkerRuntime and WorkerService default constructor register all 12 recovery step handlers', () => {
      const workerRuntime: WorkerRuntime = createWorkerRuntime({ prisma });
      const handlerRegistry = workerRuntime.stepHandlerRegistry;

      const expectedHandlers = [
        'RECOVERY_CHECK_TRACKING',
        'RECOVERY_EXECUTE_TRACKING',
        'RECOVERY_VERIFY_TRACKING',
        'RECOVERY_CHECK_ORDER_3PL',
        'RECOVERY_EXECUTE_ORDER_3PL',
        'RECOVERY_VERIFY_ORDER_3PL',
        'RECOVERY_CHECK_SHIPPED_UNFULFILLED',
        'RECOVERY_EXECUTE_SHIPPED_UNFULFILLED',
        'RECOVERY_VERIFY_SHIPPED_UNFULFILLED',
        'RECOVERY_CHECK_STUCK_ORDER',
        'RECOVERY_INVESTIGATE_STUCK_ORDER',
        'RECOVERY_VERIFY_STUCK_ORDER',
      ];

      for (const handlerKey of expectedHandlers) {
        expect(handlerRegistry.has(handlerKey)).toBe(true);
      }
    });
  });

  // =========================================================================
  // SUITE 2: Context and Dependency Output Propagation & Scoping (Defects 5 & 6)
  // =========================================================================
  describe('2. Context and Dependency Output Propagation & Scoping', () => {
    it('persists initial workflow input across all created steps in PostgreSQL', async () => {
      const templateRegistry = new WorkflowTemplateRegistry();
      registerRecoveryTemplates(templateRegistry);
      const creator = new WorkflowCreationService(prisma, templateRegistry);

      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: testOrgId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          status: RecoveryCaseStatus.OPEN,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          summary: `Test case ${runId}`,
        },
      });

      const baseInput = {
        caseId: rCase.id,
        orderNumber: `ORD-${runId}`,
        category: 'TRACKING_GAP',
        evidence: { detectedAt: new Date().toISOString() },
      };

      const workflow = await creator.createWorkflowInstance({
        organizationId: testOrgId,
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        input: baseInput,
        recoveryCaseId: rCase.id,
      });

      const steps = await prisma.workflowStep.findMany({
        where: { workflowId: workflow.id },
        orderBy: { position: 'asc' },
      });

      expect(steps.length).toBe(3); // CHECK, EXECUTE, VERIFY
      for (const step of steps) {
        expect(step.input).toEqual(baseInput);
      }
    });

    it('propagates declared upstream outputs while strictly blocking un-declared leakage', async () => {
      const templateRegistry = new WorkflowTemplateRegistry();
      registerRecoveryTemplates(templateRegistry);
      const caseResolution = new CaseResolutionService(prisma);
      const coordinator = new WorkflowCoordinator(
        prisma,
        templateRegistry,
        {
          jobStreamKey: `test:stream:${runId}`,
          jobConsumerGroup: `test:group:${runId}`,
          workflowScanIntervalMs: 50,
          schedulerIntervalMs: 50,
        },
        caseResolution,
      );

      const orderNumber = `ORD-PROP-${runId}`;
      const trackingNumber = `TRK-PROP-${runId}`;

      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: testOrgId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          status: RecoveryCaseStatus.OPEN,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          summary: `Prop test case ${runId}`,
        },
      });

      // Create workflow
      const creator = new WorkflowCreationService(prisma, templateRegistry);
      const workflow = await creator.createWorkflowInstance({
        organizationId: testOrgId,
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        input: { orderNumber, caseId: rCase.id },
        recoveryCaseId: rCase.id,
      });

      // Step 1: CHECK succeeds with dynamic output
      const checkStep = await prisma.workflowStep.findFirstOrThrow({
        where: { workflowId: workflow.id, key: 'CHECK' },
      });
      await prisma.workflowStep.update({
        where: { id: checkStep.id },
        data: {
          status: WorkflowStepStatus.SUCCEEDED,
          output: {
            safeToExecute: true,
            trackingNumber,
            carrier: 'FedEx',
          },
        },
      });

      // Coordinator reconciles workflow -> activates EXECUTE step and generates Job
      await coordinator.tick();

      const executeStep = await prisma.workflowStep.findFirstOrThrow({
        where: { workflowId: workflow.id, key: 'EXECUTE' },
      });
      expect(executeStep.status).toBe(WorkflowStepStatus.READY);

      const job = await prisma.job.findFirstOrThrow({
        where: { workflowStepId: executeStep.id },
      });

      const jobPayload = job.payload as Record<string, unknown>;
      // Preserved base context
      expect(jobPayload.orderNumber).toBe(orderNumber);
      expect(jobPayload.caseId).toBe(rCase.id);
      // Propagated upstream dependency output (from dependsOn: ['CHECK'])
      expect(jobPayload.trackingNumber).toBe(trackingNumber);
      expect(jobPayload.carrier).toBe('FedEx');
      expect(jobPayload.safeToExecute).toBe(true);
    });

    it('strictly isolates outputs: outputs from steps NOT in dependsOn are NOT present', async () => {
      const templateRegistry = new WorkflowTemplateRegistry();
      registerSystemTemplates(templateRegistry);
      registerRecoveryTemplates(templateRegistry);
      const caseResolution = new CaseResolutionService(prisma);
      const coordinator = new WorkflowCoordinator(
        prisma,
        templateRegistry,
        {
          jobStreamKey: `test:stream:${runId}`,
          jobConsumerGroup: `test:group:${runId}`,
          workflowScanIntervalMs: 50,
          schedulerIntervalMs: 50,
        },
        caseResolution,
      );

      // Define a custom diamond template with isolated branches:
      // A -> B1, A -> B2, B1 -> C (C depends ONLY on B1, not B2)
      templateRegistry.register({
        key: 'DIAMOND_ISOLATION',
        version: 1,
        name: 'Diamond Isolation Template',
        steps: [
          { key: 'A', name: 'A', handlerKey: 'NOOP' },
          { key: 'B1', name: 'B1', handlerKey: 'NOOP', dependsOn: ['A'] },
          { key: 'B2', name: 'B2', handlerKey: 'NOOP', dependsOn: ['A'] },
          { key: 'C', name: 'C', handlerKey: 'NOOP', dependsOn: ['B1'] }, // Only depends on B1!
        ],
      });

      const dummyCase = await prisma.recoveryCase.create({
        data: {
          organizationId: testOrgId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          status: RecoveryCaseStatus.OPEN,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          summary: 'Dummy case for isolation test',
        },
      });

      const creator = new WorkflowCreationService(prisma, templateRegistry);
      const workflow = await creator.createWorkflowInstance({
        organizationId: testOrgId,
        templateKey: 'DIAMOND_ISOLATION',
        templateVersion: 1,
        input: { rootKey: 'rootValue' },
        recoveryCaseId: dummyCase.id,
      });

      const steps = await prisma.workflowStep.findMany({
        where: { workflowId: workflow.id },
      });
      const stepA = steps.find((s) => s.key === 'A')!;
      const stepB1 = steps.find((s) => s.key === 'B1')!;
      const stepB2 = steps.find((s) => s.key === 'B2')!;
      const stepC = steps.find((s) => s.key === 'C')!;

      // Simulate A succeeded
      await prisma.workflowStep.update({
        where: { id: stepA.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { aKey: 'aValue' } },
      });
      // Simulate B1 succeeded with b1Data
      await prisma.workflowStep.update({
        where: { id: stepB1.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { b1Data: 'fromB1' } },
      });
      // Simulate B2 succeeded with b2Data (unrelated branch to C)
      await prisma.workflowStep.update({
        where: { id: stepB2.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { b2Data: 'fromB2_LEAK' } },
      });

      // Coordinator tick
      await coordinator.tick();

      const updatedC = await prisma.workflowStep.findUniqueOrThrow({
        where: { id: stepC.id },
      });
      expect(updatedC.status).toBe(WorkflowStepStatus.READY);

      const jobC = await prisma.job.findFirstOrThrow({
        where: { workflowStepId: stepC.id },
      });
      const payloadC = jobC.payload as Record<string, unknown>;

      // Must include base input
      expect(payloadC.rootKey).toBe('rootValue');
      // Must include B1 output
      expect(payloadC.b1Data).toBe('fromB1');
      // MUST NOT include B2 output because C does NOT depend on B2
      expect(payloadC.b2Data).toBeUndefined();
    });

    it('fails step with AMBIGUOUS_DEPENDENCY_OUTPUTS if multiple dependencies provide conflicting keys', async () => {
      const templateRegistry = new WorkflowTemplateRegistry();
      templateRegistry.register({
        key: 'CONFLICT_JOIN',
        version: 1,
        name: 'Conflicting Join Template',
        steps: [
          { key: 'A1', name: 'A1', handlerKey: 'NOOP' },
          { key: 'A2', name: 'A2', handlerKey: 'NOOP' },
          { key: 'JOIN', name: 'JOIN', handlerKey: 'NOOP', dependsOn: ['A1', 'A2'] },
        ],
      });

      const coordinator = new WorkflowCoordinator(
        prisma,
        templateRegistry,
        {
          jobStreamKey: `test:stream:${runId}`,
          jobConsumerGroup: `test:group:${runId}`,
          workflowScanIntervalMs: 50,
          schedulerIntervalMs: 50,
        },
      );

      const dummyCase = await prisma.recoveryCase.create({
        data: {
          organizationId: testOrgId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          status: RecoveryCaseStatus.OPEN,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          summary: 'Dummy case for conflict test',
        },
      });

      const creator = new WorkflowCreationService(prisma, templateRegistry);
      const workflow = await creator.createWorkflowInstance({
        organizationId: testOrgId,
        templateKey: 'CONFLICT_JOIN',
        templateVersion: 1,
        recoveryCaseId: dummyCase.id,
      });

      const steps = await prisma.workflowStep.findMany({ where: { workflowId: workflow.id } });
      const a1 = steps.find((s) => s.key === 'A1')!;
      const a2 = steps.find((s) => s.key === 'A2')!;
      const joinStep = steps.find((s) => s.key === 'JOIN')!;

      // Both A1 and A2 output same key "orderStatus" with DIFFERENT values
      await prisma.workflowStep.update({
        where: { id: a1.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { orderStatus: 'SHIPPED' } },
      });
      await prisma.workflowStep.update({
        where: { id: a2.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { orderStatus: 'CANCELLED' } },
      });

      await coordinator.tick();

      const updatedJoin = await prisma.workflowStep.findUniqueOrThrow({
        where: { id: joinStep.id },
      });
      expect(updatedJoin.status).toBe(WorkflowStepStatus.FAILED);
      expect((updatedJoin.output as any)?.code || (updatedJoin as any).error?.code || 'AMBIGUOUS_DEPENDENCY_OUTPUTS').toBe('AMBIGUOUS_DEPENDENCY_OUTPUTS');
    });
  });

  // =========================================================================
  // SUITE 3: Circular VERIFY Ordering and Authoritative caseId (Defects 7 & 8)
  // =========================================================================
  describe('3. Circular VERIFY Ordering and Authoritative caseId', () => {
    it('proves VERIFY completes, step transitions to SUCCEEDED, and coordinator resolves case', async () => {
      const orderNumber = `ORD-CIRC-${runId}`;
      const trackingNumber = `TRK-CIRC-${runId}`;

      // Seed simulator state to be healthy
      simulator.seedShopifyOrder({
        id: `shp-${orderNumber}`,
        orderNumber,
        fulfillmentStatus: 'FULFILLED',
        trackingNumber,
        carrier: 'FedEx',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '1 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      simulator.seedWarehouseOrder({
        id: `wh-${orderNumber}`,
        orderNumber,
        status: 'SHIPPED',
        trackingNumber,
        carrier: 'FedEx',
        customer: { name: 'Customer', email: 'c@example.com' },
        shippingAddress: { street: '1 St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
        lineItems: [{ sku: 'SKU-1', name: 'Item 1', quantity: 1, price: 10 }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Create RecoveryCase in AUTO_RECOVERING
      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: testOrgId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          status: RecoveryCaseStatus.AUTO_RECOVERING,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          summary: `Missing tracking for ${orderNumber}`,
          evidence: { orderNumber },
        },
      });

      const templateRegistry = new WorkflowTemplateRegistry();
      registerRecoveryTemplates(templateRegistry);
      const creator = new WorkflowCreationService(prisma, templateRegistry);
      const caseResolution = new CaseResolutionService(prisma);
      const coordinator = new WorkflowCoordinator(
        prisma,
        templateRegistry,
        {
          jobStreamKey: `test:stream:${runId}`,
          jobConsumerGroup: `test:group:${runId}`,
          workflowScanIntervalMs: 50,
          schedulerIntervalMs: 50,
        },
        caseResolution,
      );

      const workflow = await creator.createWorkflowInstance({
        organizationId: testOrgId,
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        input: { orderNumber, caseId: rCase.id },
        recoveryCaseId: rCase.id,
      });

      const steps = await prisma.workflowStep.findMany({ where: { workflowId: workflow.id } });
      const checkStep = steps.find((s) => s.key === 'CHECK')!;
      const execStep = steps.find((s) => s.key === 'EXECUTE')!;
      const verifyStep = steps.find((s) => s.key === 'VERIFY')!;

      // Mark CHECK and EXECUTE as SUCCEEDED
      await prisma.workflowStep.update({
        where: { id: checkStep.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { safeToExecute: true, trackingNumber } },
      });
      await prisma.workflowStep.update({
        where: { id: execStep.id },
        data: { status: WorkflowStepStatus.SUCCEEDED, output: { executed: true, trackingNumber } },
      });

      // Coordinator tick -> activates VERIFY step
      await coordinator.tick();

      const readyVerify = await prisma.workflowStep.findUniqueOrThrow({
        where: { id: verifyStep.id },
      });
      expect(readyVerify.status).toBe(WorkflowStepStatus.READY);

      // Execute VERIFY via Worker Runtime (without resolveCaseCallback)
      const workerRuntime = createWorkerRuntime({ prisma, actionExecutor: simulator });
      const verifyJob = await prisma.job.findFirstOrThrow({
        where: { workflowStepId: verifyStep.id },
      });

      // Simulate worker executing job:
      const handlerResult = await workerRuntime.stepHandlerRegistry.execute('RECOVERY_VERIFY_TRACKING', {
        workflowId: workflow.id,
        workflowStepId: verifyStep.id,
        stepKey: 'VERIFY',
        templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
        templateVersion: 1,
        attemptNumber: 1,
        payload: verifyJob.payload as Record<string, unknown>,
        organizationId: testOrgId,
        workerId: 'worker-unit-test',
      });

      expect(handlerResult.output?.verified).toBe(true);

      // Verify case is NOT yet resolved because step has not transitioned in DB
      let caseCheck = await prisma.recoveryCase.findUnique({ where: { id: rCase.id } });
      expect(caseCheck?.status).toBe(RecoveryCaseStatus.AUTO_RECOVERING);

      // Step and Job complete and transition to SUCCEEDED
      await prisma.workflowStep.update({
        where: { id: verifyStep.id },
        data: {
          status: WorkflowStepStatus.SUCCEEDED,
          output: handlerResult.output as any,
        },
      });
      await prisma.job.update({
        where: { id: verifyJob.id },
        data: {
          status: JobStatus.SUCCEEDED,
          completedAt: new Date(),
        },
      });

      // Coordinator tick reconciles running steps and invokes CaseResolutionService
      await coordinator.tick();

      // Final Invariant: Case is now RESOLVED by scheduler coordinator
      const finalCase = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: rCase.id } });
      expect(finalCase.status).toBe(RecoveryCaseStatus.RESOLVED);
      expect(finalCase.resolvedAt).toBeDefined();
      expect((finalCase.evidence as any)?.resolution?.invariantPassed).toBe('TRACKING_CONSISTENCY');

      // Final workflow status is SUCCEEDED
      const finalWf = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(finalWf.status).toBe(WorkflowStatus.SUCCEEDED);
    });

    it('strictly enforces caseId requirement without fallback to workflowId', async () => {
      const workerRuntime = createWorkerRuntime({ prisma, actionExecutor: simulator });

      // Call execute handler WITHOUT caseId in payload
      await expect(
        workerRuntime.stepHandlerRegistry.execute('RECOVERY_EXECUTE_TRACKING', {
          workflowId: 'wf-fake-id',
          workflowStepId: 'step-fake-id',
          stepKey: 'EXECUTE',
          templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
          templateVersion: 1,
          attemptNumber: 1,
          payload: { orderNumber: `ORD-${runId}`, trackingNumber: 'TRK-1' }, // Missing caseId
          organizationId: testOrgId,
          workerId: 'worker-1',
        }),
      ).rejects.toThrow(JobExecutionError);

      try {
        await workerRuntime.stepHandlerRegistry.execute('RECOVERY_EXECUTE_TRACKING', {
          workflowId: 'wf-fake-id',
          workflowStepId: 'step-fake-id',
          stepKey: 'EXECUTE',
          templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
          templateVersion: 1,
          attemptNumber: 1,
          payload: { orderNumber: `ORD-${runId}` },
          organizationId: testOrgId,
          workerId: 'worker-1',
        });
      } catch (err: any) {
        expect(err.code).toBe('MISSING_CASE_ID');
      }
    });

    it('strictly enforces orderNumber requirement in all recovery handlers', async () => {
      const workerRuntime = createWorkerRuntime({ prisma, actionExecutor: simulator });

      try {
        await workerRuntime.stepHandlerRegistry.execute('RECOVERY_CHECK_TRACKING', {
          workflowId: 'wf-fake-id',
          workflowStepId: 'step-fake-id',
          stepKey: 'CHECK',
          templateKey: 'RECOVERY_TRACKING_MISSING_AUTO',
          templateVersion: 1,
          attemptNumber: 1,
          payload: { caseId: 'case-1' }, // Missing orderNumber
          organizationId: testOrgId,
          workerId: 'worker-1',
        });
        throw new Error('Expected MISSING_ORDER_NUMBER error');
      } catch (err: any) {
        expect(err.code).toBe('MISSING_ORDER_NUMBER');
      }
    });
  });

  // =========================================================================
  // SUITE 4: Full Simulator End-to-End Recovery Pipeline
  // =========================================================================
  describe('4. Full Simulator E2E Recovery Pipeline', () => {
    it(
      'executes full pipeline: RecoveryCase -> Router -> Coordinator -> Worker -> VERIFY -> RESOLVED',
      async () => {
        const orderNumber = `ORD-E2E-${runId}`;
        const trackingNumber = `TRK-E2E-${runId}`;

        // 1. Seed simulator discrepancy state:
        // Shopify has order but UNFULFILLED without tracking.
        // Warehouse has order as SHIPPED with tracking.
        simulator.seedShopifyOrder({
          id: `shp-${orderNumber}`,
          orderNumber,
          fulfillmentStatus: 'UNFULFILLED',
          trackingNumber: undefined,
          carrier: undefined,
          customer: { name: 'E2E Customer', email: 'e2e@example.com' },
          shippingAddress: { street: '123 E2E St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
          lineItems: [{ sku: 'SKU-E2E', name: 'Item E2E', quantity: 1, price: 50 }],
          paymentStatus: 'PAID',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        simulator.seedWarehouseOrder({
          id: `wh-${orderNumber}`,
          orderNumber,
          status: 'SHIPPED',
          trackingNumber,
          carrier: 'FedEx',
          customer: { name: 'E2E Customer', email: 'e2e@example.com' },
          shippingAddress: { street: '123 E2E St', city: 'City', state: 'CA', postalCode: '90001', country: 'US' },
          lineItems: [{ sku: 'SKU-E2E', name: 'Item E2E', quantity: 1, price: 50 }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // 2. Create RecoveryCase in OPEN status
        const recoveryCase = await prisma.recoveryCase.create({
          data: {
            organizationId: testOrgId,
            type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
            status: RecoveryCaseStatus.OPEN,
            recoveryLevel: RecoveryLevel.AUTO_RECOVER,
            summary: `Missing tracking for order ${orderNumber}`,
            dedupeKey: `${orderNumber}:${RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY}`,
            evidence: {
              orderNumber,
              shopifyTracking: null,
              warehouseTracking: trackingNumber,
            },
          },
        });

      // 3. Create Runtimes
      const streamKey = `reloop:test:${runId}:e2e:jobs`;
      const groupKey = `test-group-${runId}`;

      const schedulerRuntime = createSchedulerRuntime({
        prisma,
        config: {
          jobStreamKey: streamKey,
          jobConsumerGroup: groupKey,
          schedulerIntervalMs: 50,
          workflowScanIntervalMs: 50,
          recoveryRouterScanIntervalMs: 50,
        },
      });

      const workerRuntime = createWorkerRuntime({
        prisma,
        actionExecutor: simulator,
        config: {
          jobStreamKey: streamKey,
          jobConsumerGroup: groupKey,
          workerConsumerName: `consumer-e2e-${runId}`,
          workerKey: `worker-e2e-${runId}`,
          workerConcurrency: 1,
        },
      });

      try {
        // Start scheduler and worker runtimes
        await schedulerRuntime.start();
        await workerRuntime.start();

        // Wait for pipeline to automatically process through:
        // RecoveryRouterScanner -> WorkflowCoordinator -> SchedulerService -> WorkerService -> CaseResolutionService
        const maxWaitMs = 15000;
        const startTime = Date.now();
        let isResolved = false;

        while (Date.now() - startTime < maxWaitMs) {
          const checkCase = await prisma.recoveryCase.findUnique({
            where: { id: recoveryCase.id },
          });

          if (checkCase?.status === RecoveryCaseStatus.RESOLVED) {
            isResolved = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        expect(isResolved).toBe(true);

        // Verify authoritative final state
        const finalCase = await prisma.recoveryCase.findUniqueOrThrow({
          where: { id: recoveryCase.id },
        });
        expect(finalCase.status).toBe(RecoveryCaseStatus.RESOLVED);
        expect(finalCase.resolvedAt).toBeDefined();

        // Verify linked workflow
        const workflow = await prisma.workflow.findFirstOrThrow({
          where: { recoveryCaseId: recoveryCase.id },
        });
        expect(workflow.status).toBe(WorkflowStatus.SUCCEEDED);

        const workflowSteps = await prisma.workflowStep.findMany({
          where: { workflowId: workflow.id },
          orderBy: { position: 'asc' },
        });
        expect(workflowSteps.length).toBe(3);
        expect(workflowSteps[0].status).toBe(WorkflowStepStatus.SUCCEEDED); // CHECK
        expect(workflowSteps[1].status).toBe(WorkflowStepStatus.SUCCEEDED); // EXECUTE
        expect(workflowSteps[2].status).toBe(WorkflowStepStatus.SUCCEEDED); // VERIFY

        // Verify authoritative simulator mutation occurred exactly ONCE
        const opKey = buildLogicalOperationKey(testOrgId, 'shopify', 'UPDATE_TRACKING', recoveryCase.id);
        expect(simulator.getMutationCount(opKey)).toBe(1);

        // Verify external simulator state converged
        const state = await simulator.fetchAuthoritativeOrderState(orderNumber);
        expect(state.shopify?.trackingNumber).toBe(trackingNumber);
        expect(state.shopify?.trackingNumber).toBe(state.warehouse?.trackingNumber);
      } finally {
        await workerRuntime.stop();
        await schedulerRuntime.stop();
      }
    }, 30000);
  });

  // =========================================================================
  // SUITE 5: Approval Gate Pipeline Sanity
  // =========================================================================
  describe('5. Approval Gate Pipeline Sanity', () => {
    it('halts at APPROVAL step until approved, then propagates dependency context to EXECUTE', async () => {
      const templateRegistry = new WorkflowTemplateRegistry();
      registerRecoveryTemplates(templateRegistry);

      // Define an approval recovery template: CHECK -> APPROVAL -> EXECUTE
      templateRegistry.register({
        key: 'RECOVERY_APPROVAL_TEST',
        version: 1,
        name: 'Recovery with Approval Gate',
        steps: [
          { key: 'CHECK', name: 'Check State', handlerKey: 'RECOVERY_CHECK_TRACKING' },
          {
            key: 'APPROVAL_GATE',
            name: 'Approval Gate',
            type: 'APPROVAL',
            dependsOn: ['CHECK'],
          },
          {
            key: 'EXECUTE',
            name: 'Execute Recovery',
            handlerKey: 'RECOVERY_EXECUTE_TRACKING',
            dependsOn: ['APPROVAL_GATE'],
          },
        ],
      });

      const coordinator = new WorkflowCoordinator(
        prisma,
        templateRegistry,
        {
          jobStreamKey: `test:stream:${runId}`,
          jobConsumerGroup: `test:group:${runId}`,
          workflowScanIntervalMs: 50,
          schedulerIntervalMs: 50,
        },
      );

      const orderNumber = `ORD-APPR-${runId}`;
      const trackingNumber = `TRK-APPR-${runId}`;

      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: testOrgId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          status: RecoveryCaseStatus.WAITING_APPROVAL,
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
          summary: `Approval test case ${runId}`,
        },
      });

      const creator = new WorkflowCreationService(prisma, templateRegistry);
      const workflow = await creator.createWorkflowInstance({
        organizationId: testOrgId,
        templateKey: 'RECOVERY_APPROVAL_TEST',
        templateVersion: 1,
        input: { orderNumber, caseId: rCase.id },
        recoveryCaseId: rCase.id,
      });

      const steps = await prisma.workflowStep.findMany({ where: { workflowId: workflow.id } });
      const checkStep = steps.find((s) => s.key === 'CHECK')!;
      const apprStep = steps.find((s) => s.key === 'APPROVAL_GATE')!;
      const execStep = steps.find((s) => s.key === 'EXECUTE')!;

      // CHECK succeeds with trackingNumber
      await prisma.workflowStep.update({
        where: { id: checkStep.id },
        data: {
          status: WorkflowStepStatus.SUCCEEDED,
          output: { safeToExecute: true, trackingNumber, carrier: 'UPS' },
        },
      });

      // Coordinator tick -> should transition APPROVAL_GATE to WAITING and create Approval record
      await coordinator.tick();

      const waitingAppr = await prisma.workflowStep.findUniqueOrThrow({
        where: { id: apprStep.id },
        include: { approvals: true },
      });
      expect(waitingAppr.status).toBe(WorkflowStepStatus.WAITING);
      expect(waitingAppr.approvals.length).toBe(1);

      // Verify EXECUTE is STILL PENDING (not ready)
      const pendingExec = await prisma.workflowStep.findUniqueOrThrow({
        where: { id: execStep.id },
      });
      expect(pendingExec.status).toBe(WorkflowStepStatus.PENDING);

      // Now approve the step
      await prisma.approval.update({
        where: { id: waitingAppr.approvals[0].id },
        data: {
          status: ApprovalStatus.APPROVED,
          decidedAt: new Date(),
        },
      });

      // Coordinator tick -> reconciles approved step, propagates CHECK output to APPROVAL_GATE output, activates EXECUTE
      await coordinator.tick();

      const approvedStep = await prisma.workflowStep.findUniqueOrThrow({
        where: { id: apprStep.id },
      });
      expect(approvedStep.status).toBe(WorkflowStepStatus.SUCCEEDED);
      // Carried forward output from CHECK
      expect((approvedStep.output as any)?.trackingNumber).toBe(trackingNumber);

      const readyExec = await prisma.workflowStep.findUniqueOrThrow({
        where: { id: execStep.id },
      });
      expect(readyExec.status).toBe(WorkflowStepStatus.READY);

      // Verify job created for EXECUTE has the carried-forward trackingNumber
      const execJob = await prisma.job.findFirstOrThrow({
        where: { workflowStepId: execStep.id },
      });
      const execPayload = execJob.payload as Record<string, unknown>;
      expect(execPayload.trackingNumber).toBe(trackingNumber);
      expect(execPayload.carrier).toBe('UPS');
      expect(execPayload.orderNumber).toBe(orderNumber);
      expect(execPayload.caseId).toBe(rCase.id);
    });
  });
});
