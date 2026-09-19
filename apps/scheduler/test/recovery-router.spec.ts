import * as path from 'path';
import * as dotenv from 'dotenv';
import {
  PrismaClient,
  RecoveryCaseStatus,
  RecoveryCaseType,
  RecoveryLevel,
  WorkflowStatus,
} from '@prisma/client';
import {
  WorkflowTemplateRegistry,
  registerSystemTemplates,
  registerRecoveryTemplates,
} from '@reloop/workflow-core';
import { routeRecoveryPolicy } from '../src/recovery-router/recovery-policy-router';
import { RecoveryRouterService } from '../src/recovery-router/recovery-router.service';
import { WorkflowCreationService } from '../src/workflow-creator';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:reloop_app_dev_password@localhost:5433/reloop_test?schema=public';

describe('Day 13: Recovery Policy Router & Workflow Idempotency', () => {
  let prisma: PrismaClient;
  let registry: WorkflowTemplateRegistry;
  let workflowCreator: WorkflowCreationService;
  let routerService: RecoveryRouterService;

  let orgAId: string;
  let orgBId: string;
  const runId = Math.random().toString(36).substring(2, 7);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
    await prisma.$connect();

    registry = new WorkflowTemplateRegistry();
    registerSystemTemplates(registry);
    registerRecoveryTemplates(registry);

    workflowCreator = new WorkflowCreationService(prisma, registry);
    routerService = new RecoveryRouterService(prisma, workflowCreator);

    const orgA = await prisma.organization.create({
      data: { name: `Org Router A ${runId}`, slug: `org-router-a-${runId}` },
    });
    const orgB = await prisma.organization.create({
      data: { name: `Org Router B ${runId}`, slug: `org-router-b-${runId}` },
    });

    orgAId = orgA.id;
    orgBId = orgB.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('1. Pure Deterministic Policy Router Unit Tests', () => {
    it('BLOCK routing: DUPLICATE_RISK and INVALID_ORDER_DATA return BLOCKED', () => {
      const mockDupCase = {
        type: RecoveryCaseType.DUPLICATE_RISK,
        recoveryLevel: RecoveryLevel.BLOCK,
      } as any;
      const decDup = routeRecoveryPolicy(mockDupCase);
      expect(decDup.action).toBe('BLOCKED');
      expect(decDup.templateKey).toBeUndefined();

      const mockInvalidCase = {
        type: RecoveryCaseType.INVALID_ORDER_DATA,
        recoveryLevel: RecoveryLevel.BLOCK,
      } as any;
      const decInvalid = routeRecoveryPolicy(mockInvalidCase);
      expect(decInvalid.action).toBe('BLOCKED');
      expect(decInvalid.templateKey).toBeUndefined();
    });

    it('AUTO_INVESTIGATE routing: STUCK_ORDER returns RECOVERY_STUCK_INVESTIGATION', () => {
      const mockStuck = {
        type: RecoveryCaseType.STUCK_ORDER,
        recoveryLevel: RecoveryLevel.AUTO_INVESTIGATE,
      } as any;
      const dec = routeRecoveryPolicy(mockStuck);
      expect(dec.action).toBe('INVESTIGATE_ONLY');
      expect(dec.templateKey).toBe('RECOVERY_STUCK_INVESTIGATION');
      expect(dec.templateVersion).toBe(1);
    });

    it('AUTO_RECOVER routing: TRACKING_MISSING_IN_SHOPIFY returns RECOVERY_TRACKING_MISSING_AUTO', () => {
      const mockCase = {
        type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
        recoveryLevel: RecoveryLevel.AUTO_RECOVER,
      } as any;
      const dec = routeRecoveryPolicy(mockCase);
      expect(dec.action).toBe('START_WORKFLOW');
      expect(dec.templateKey).toBe('RECOVERY_TRACKING_MISSING_AUTO');
      expect(dec.templateVersion).toBe(1);
    });

    it('REQUIRE_APPROVAL routing: canonical categories map to approval templates', () => {
      const trackingApproval = routeRecoveryPolicy({
        type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
        recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
      } as any);
      expect(trackingApproval.action).toBe('START_WORKFLOW');
      expect(trackingApproval.templateKey).toBe('RECOVERY_TRACKING_MISSING_APPROVAL');

      const missing3pl = routeRecoveryPolicy({
        type: RecoveryCaseType.ORDER_MISSING_AT_3PL,
        recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
      } as any);
      expect(missing3pl.action).toBe('START_WORKFLOW');
      expect(missing3pl.templateKey).toBe('RECOVERY_ORDER_MISSING_3PL');

      const shippedUnfulfilled = routeRecoveryPolicy({
        type: RecoveryCaseType.SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY,
        recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
      } as any);
      expect(shippedUnfulfilled.action).toBe('START_WORKFLOW');
      expect(shippedUnfulfilled.templateKey).toBe('RECOVERY_SHIPPED_UNFULFILLED');
    });

    it('INVENTORY_MISMATCH routing: returns BLOCKED to prevent automatic inventory mutation', () => {
      const dec = routeRecoveryPolicy({
        type: RecoveryCaseType.INVENTORY_MISMATCH,
        recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
      } as any);
      expect(dec.action).toBe('BLOCKED');
      expect(dec.templateKey).toBeUndefined();
    });
  });

  describe('2. Router Service Integration & Idempotency Tests', () => {
    it('routes AUTO_RECOVER case to Workflow and updates status to AUTO_RECOVERING', async () => {
      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgAId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          status: RecoveryCaseStatus.OPEN,
          summary: 'Missing tracking auto',
          dedupeKey: `ORD-TRK-AUTO-${runId}:TRACKING_MISSING_IN_SHOPIFY`,
        },
      });

      const result = await routerService.routeCase(rCase.id, orgAId);
      expect(result.routed).toBe(true);
      expect(result.workflow).toBeDefined();
      expect(result.workflow?.templateKey).toBe('RECOVERY_TRACKING_MISSING_AUTO');

      const updatedCase = await prisma.recoveryCase.findUnique({ where: { id: rCase.id } });
      expect(updatedCase?.status).toBe(RecoveryCaseStatus.AUTO_RECOVERING);

      const workflowSteps = await prisma.workflowStep.findMany({
        where: { workflowId: result.workflow!.id },
      });
      expect(workflowSteps.map((s) => s.key)).toEqual(['CHECK', 'EXECUTE', 'VERIFY']);
    });

    it('routes REQUIRE_APPROVAL case to approval-gated Workflow and updates status to WAITING_APPROVAL', async () => {
      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgAId,
          type: RecoveryCaseType.SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY,
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
          status: RecoveryCaseStatus.OPEN,
          summary: 'Shipped unfulfilled approval',
          dedupeKey: `ORD-SHP-APP-${runId}:SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY`,
        },
      });

      const result = await routerService.routeCase(rCase.id, orgAId);
      expect(result.routed).toBe(true);
      expect(result.workflow?.templateKey).toBe('RECOVERY_SHIPPED_UNFULFILLED');

      const updatedCase = await prisma.recoveryCase.findUnique({ where: { id: rCase.id } });
      expect(updatedCase?.status).toBe(RecoveryCaseStatus.WAITING_APPROVAL);

      const workflowSteps = await prisma.workflowStep.findMany({
        where: { workflowId: result.workflow!.id },
      });
      expect(workflowSteps.map((s) => s.key)).toEqual(['CHECK', 'APPROVAL', 'EXECUTE', 'VERIFY']);
    });

    it('BLOCK level creates strictly ZERO Workflows, ZERO Jobs, ZERO Approvals and marks case BLOCKED', async () => {
      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgAId,
          type: RecoveryCaseType.DUPLICATE_RISK,
          recoveryLevel: RecoveryLevel.BLOCK,
          status: RecoveryCaseStatus.OPEN,
          summary: 'Duplicate risk order',
          dedupeKey: `ORD-DUP-${runId}:DUPLICATE_RISK`,
        },
      });

      const result = await routerService.routeCase(rCase.id, orgAId);
      expect(result.routed).toBe(false);
      expect(result.action).toBe('BLOCKED');
      expect(result.workflow).toBeUndefined();

      const updatedCase = await prisma.recoveryCase.findUnique({ where: { id: rCase.id } });
      expect(updatedCase?.status).toBe(RecoveryCaseStatus.BLOCKED);

      const wfCount = await prisma.workflow.count({ where: { recoveryCaseId: rCase.id } });
      const jobCount = await prisma.job.count({ where: { organizationId: orgAId } });
      const appCount = await prisma.approval.count({ where: { recoveryCaseId: rCase.id } });

      expect(wfCount).toBe(0);
      expect(appCount).toBe(0);
    });

    it('idempotency: subsequent routeCase calls reuse active workflow without duplicates', async () => {
      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgAId,
          type: RecoveryCaseType.ORDER_MISSING_AT_3PL,
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
          status: RecoveryCaseStatus.OPEN,
          summary: 'Missing 3PL order',
          dedupeKey: `ORD-M3PL-${runId}:ORDER_MISSING_AT_3PL`,
        },
      });

      const first = await routerService.routeCase(rCase.id, orgAId);
      expect(first.routed).toBe(true);
      const wfId = first.workflow!.id;

      const second = await routerService.routeCase(rCase.id, orgAId);
      expect(second.routed).toBe(false);
      expect(second.reusedActiveWorkflow).toBe(true);
      expect(second.workflow?.id).toBe(wfId);

      const totalWorkflows = await prisma.workflow.count({ where: { recoveryCaseId: rCase.id } });
      expect(totalWorkflows).toBe(1);
    });

    it('multi-router race: 3 concurrent routeCase calls resolve to exactly 1 active Workflow', async () => {
      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgAId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          status: RecoveryCaseStatus.OPEN,
          summary: 'Race test case',
          dedupeKey: `ORD-RACE-${runId}:TRACKING_MISSING_IN_SHOPIFY`,
        },
      });

      const results = await Promise.all([
        routerService.routeCase(rCase.id, orgAId),
        routerService.routeCase(rCase.id, orgAId),
        routerService.routeCase(rCase.id, orgAId),
      ]);

      const routedCount = results.filter((r) => r.routed).length;
      const reusedCount = results.filter((r) => r.reusedActiveWorkflow).length;

      expect(routedCount).toBe(1);
      expect(reusedCount).toBe(2);

      const totalWorkflows = await prisma.workflow.count({ where: { recoveryCaseId: rCase.id } });
      expect(totalWorkflows).toBe(1);
    });

    it('router restart safety: re-instantiating router service reuses existing workflow', async () => {
      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgAId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          status: RecoveryCaseStatus.OPEN,
          summary: 'Restart test case',
          dedupeKey: `ORD-RESTART-${runId}:TRACKING_MISSING_IN_SHOPIFY`,
        },
      });

      const initialResult = await routerService.routeCase(rCase.id, orgAId);
      expect(initialResult.routed).toBe(true);

      // Create new router service instance (simulating scanner restart)
      const restartedRouter = new RecoveryRouterService(prisma, workflowCreator);
      const restartResult = await restartedRouter.routeCase(rCase.id, orgAId);

      expect(restartResult.routed).toBe(false);
      expect(restartResult.reusedActiveWorkflow).toBe(true);
      expect(restartResult.workflow?.id).toBe(initialResult.workflow?.id);
    });

    it('tenant isolation: Org B cannot route Org A case', async () => {
      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: orgAId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          status: RecoveryCaseStatus.OPEN,
          summary: 'Tenant test case',
          dedupeKey: `ORD-TENANT-${runId}:TRACKING_MISSING_IN_SHOPIFY`,
        },
      });

      await expect(routerService.routeCase(rCase.id, orgBId)).rejects.toThrow(/Tenant mismatch/);
    });
  });
});
