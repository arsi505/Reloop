import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for E2E tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  Role,
  IntegrationProvider,
  IntegrationStatus,
  OperationalMode,
  ExternalOrderStatus,
  IntegrationEventStatus,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
  WorkflowStatus,
  WorkflowStepStatus,
  JobStatus,
  JobAttemptStatus,
  JobErrorCategory,
  WorkerStatus,
  ApprovalStatus,
  Prisma,
} from '@reloop/database';

describe('Day 5: Core Reliability Data Model Invariants', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean all tables in dependency order
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.approval.deleteMany({});
    await prisma.workflowStep.deleteMany({});
    await prisma.workflow.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.externalReference.deleteMany({});
    await prisma.externalOrder.deleteMany({});
    await prisma.integrationEvent.deleteMany({});
    await prisma.integration.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.worker.deleteMany({});
    await prisma.refreshSession.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
  });

  describe('1. Tenant Isolation & Multi-Tenancy Invariants', () => {
    it('isolates orders, cases, and jobs per organization and permits cross-tenant idempotency key reuse', async () => {
      // Create Organization A and Organization B
      const orgA = await prisma.organization.create({
        data: { name: 'Acme Retail', slug: 'acme-retail' },
      });
      const orgB = await prisma.organization.create({
        data: { name: 'Globex Corp', slug: 'globex-corp' },
      });

      // Org A records
      const orderA = await prisma.externalOrder.create({
        data: {
          organizationId: orgA.id,
          externalOrderNumber: 'ORD-1001',
          status: ExternalOrderStatus.READY_FOR_FULFILLMENT,
        },
      });

      const caseA = await prisma.recoveryCase.create({
        data: {
          organizationId: orgA.id,
          externalOrderId: orderA.id,
          type: RecoveryCaseType.TEMPORARY_API_FAILURE,
          recoveryLevel: RecoveryLevel.AUTO_RECOVER,
          status: RecoveryCaseStatus.OPEN,
          summary: 'Transient 3PL connection failure for Org A',
        },
      });

      const jobA = await prisma.job.create({
        data: {
          organizationId: orgA.id,
          type: 'SYNC_ORDER',
          idempotencyKey: 'MUTATION-IDENTIFIER-999',
          status: JobStatus.QUEUED,
        },
      });

      // Org B records with identical order number and identical idempotency key
      const orderB = await prisma.externalOrder.create({
        data: {
          organizationId: orgB.id,
          externalOrderNumber: 'ORD-1001', // Same order number in different tenant
          status: ExternalOrderStatus.PENDING,
        },
      });

      const caseB = await prisma.recoveryCase.create({
        data: {
          organizationId: orgB.id,
          externalOrderId: orderB.id,
          type: RecoveryCaseType.STUCK_ORDER,
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
          status: RecoveryCaseStatus.WAITING_APPROVAL,
          summary: 'Stuck warehouse order for Org B',
        },
      });

      const jobB = await prisma.job.create({
        data: {
          organizationId: orgB.id,
          type: 'SYNC_ORDER',
          idempotencyKey: 'MUTATION-IDENTIFIER-999', // Same idempotency key in different tenant succeeds
          status: JobStatus.QUEUED,
        },
      });

      // Verify strict isolation
      const orgAOrders = await prisma.externalOrder.findMany({ where: { organizationId: orgA.id } });
      expect(orgAOrders).toHaveLength(1);
      expect(orgAOrders[0].id).toBe(orderA.id);

      const orgBCases = await prisma.recoveryCase.findMany({ where: { organizationId: orgB.id } });
      expect(orgBCases).toHaveLength(1);
      expect(orgBCases[0].id).toBe(caseB.id);

      expect(jobA.idempotencyKey).toBe(jobB.idempotencyKey);
      expect(jobA.organizationId).not.toBe(jobB.organizationId);
    });
  });

  describe('2. Integration Event Deduplication Invariants', () => {
    it('rejects duplicate providerEventId for the same integration but allows it across different integrations or when null', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Omni Goods', slug: 'omni-goods' },
      });

      const int1 = await prisma.integration.create({
        data: {
          organizationId: org.id,
          provider: IntegrationProvider.SHOPIFY,
          name: 'Primary Shopify Store',
          status: IntegrationStatus.CONNECTED,
          mode: OperationalMode.SAFE_AUTO_RECOVERY,
        },
      });

      const int2 = await prisma.integration.create({
        data: {
          organizationId: org.id,
          provider: IntegrationProvider.SHOPIFY,
          name: 'Secondary Shopify Store',
          status: IntegrationStatus.CONNECTED,
          mode: OperationalMode.OBSERVE,
        },
      });

      // 1. First event on int1 succeeds
      await prisma.integrationEvent.create({
        data: {
          organizationId: org.id,
          integrationId: int1.id,
          providerEventId: 'evt_shopify_12345',
          eventType: 'orders/create',
          payload: { order_id: 12345 },
          status: IntegrationEventStatus.RECEIVED,
        },
      });

      // 2. Duplicate event on int1 is rejected by unique constraint
      await expect(
        prisma.integrationEvent.create({
          data: {
            organizationId: org.id,
            integrationId: int1.id,
            providerEventId: 'evt_shopify_12345',
            eventType: 'orders/create',
            payload: { order_id: 12345 },
            status: IntegrationEventStatus.RECEIVED,
          },
        }),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

      // 3. Same providerEventId on int2 is allowed
      const eventInt2 = await prisma.integrationEvent.create({
        data: {
          organizationId: org.id,
          integrationId: int2.id,
          providerEventId: 'evt_shopify_12345',
          eventType: 'orders/create',
          payload: { order_id: 12345 },
          status: IntegrationEventStatus.RECEIVED,
        },
      });
      expect(eventInt2.id).toBeDefined();

      // 4. Multiple events without providerEventId (null) on same integration are allowed
      const nullEvent1 = await prisma.integrationEvent.create({
        data: {
          organizationId: org.id,
          integrationId: int1.id,
          providerEventId: null,
          eventType: 'poll/inventory',
          payload: { count: 10 },
          status: IntegrationEventStatus.RECEIVED,
        },
      });
      const nullEvent2 = await prisma.integrationEvent.create({
        data: {
          organizationId: org.id,
          integrationId: int1.id,
          providerEventId: null,
          eventType: 'poll/inventory',
          payload: { count: 12 },
          status: IntegrationEventStatus.RECEIVED,
        },
      });
      expect(nullEvent1.id).toBeDefined();
      expect(nullEvent2.id).toBeDefined();
    });
  });

  describe('3. Membership & Existing Auth Preservation', () => {
    it('preserves Day 3 User, Organization, Membership and RefreshSession models', async () => {
      const user = await prisma.user.create({
        data: {
          email: 'founder@reloop.test',
          name: 'Founder User',
          passwordHash: 'dummy_hash_for_test',
        },
      });

      const org = await prisma.organization.create({
        data: { name: 'Reliability Inc', slug: 'reliability-inc' },
      });

      const member = await prisma.organizationMember.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          role: Role.OWNER,
        },
      });

      const session = await prisma.refreshSession.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          tokenHash: 'session_token_hash_value',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      expect(member.role).toBe(Role.OWNER);
      expect(session.userId).toBe(user.id);
    });
  });

  describe('4. RecoveryCase Invariants', () => {
    it('accepts all 8 canonical V1 failure types and strictly models recovery levels and statuses', async () => {
      const org = await prisma.organization.create({
        data: { name: 'V1 Brand', slug: 'v1-brand' },
      });

      const failureTypes: RecoveryCaseType[] = [
        RecoveryCaseType.TEMPORARY_API_FAILURE,
        RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
        RecoveryCaseType.STUCK_ORDER,
        RecoveryCaseType.ORDER_MISSING_AT_3PL,
        RecoveryCaseType.SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY,
        RecoveryCaseType.INVENTORY_MISMATCH,
        RecoveryCaseType.DUPLICATE_RISK,
        RecoveryCaseType.INVALID_ORDER_DATA,
      ];

      for (let i = 0; i < failureTypes.length; i++) {
        const type = failureTypes[i];
        const createdCase = await prisma.recoveryCase.create({
          data: {
            organizationId: org.id,
            type,
            recoveryLevel: RecoveryLevel.AUTO_RECOVER,
            status: RecoveryCaseStatus.OPEN,
            summary: `Validation case for ${type}`,
          },
        });
        expect(createdCase.type).toBe(type);
      }

      const totalCases = await prisma.recoveryCase.count({ where: { organizationId: org.id } });
      expect(totalCases).toBe(8);
    });
  });

  describe('5. Job Idempotency & JobAttempt Invariants', () => {
    it('enforces organization-scoped idempotency uniqueness and jobId+attemptNumber uniqueness', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Execution Co', slug: 'execution-co' },
      });

      // 1. Create Job with idempotency key
      const job = await prisma.job.create({
        data: {
          organizationId: org.id,
          type: 'SUBMIT_3PL_ORDER',
          idempotencyKey: 'IDEMP-JOB-777',
          status: JobStatus.QUEUED,
        },
      });

      // 2. Reject duplicate idempotencyKey in same org
      await expect(
        prisma.job.create({
          data: {
            organizationId: org.id,
            type: 'SUBMIT_3PL_ORDER',
            idempotencyKey: 'IDEMP-JOB-777',
            status: JobStatus.QUEUED,
          },
        }),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

      // 3. Register worker and job attempt 1
      const worker = await prisma.worker.create({
        data: {
          workerKey: 'worker-node-01',
          status: WorkerStatus.ONLINE,
        },
      });

      const attempt1 = await prisma.jobAttempt.create({
        data: {
          jobId: job.id,
          workerId: worker.id,
          attemptNumber: 1,
          status: JobAttemptStatus.FAILED,
          errorCategory: JobErrorCategory.RATE_LIMITED,
          errorCode: 'HTTP_429',
          errorMessage: 'Rate limit encountered on downstream provider',
        },
      });
      expect(attempt1.attemptNumber).toBe(1);

      // 4. Reject duplicate attemptNumber for same jobId
      await expect(
        prisma.jobAttempt.create({
          data: {
            jobId: job.id,
            workerId: worker.id,
            attemptNumber: 1,
            status: JobAttemptStatus.STARTED,
          },
        }),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

      // 5. Allow attempt 2 on same job
      const attempt2 = await prisma.jobAttempt.create({
        data: {
          jobId: job.id,
          workerId: worker.id,
          attemptNumber: 2,
          status: JobAttemptStatus.SUCCEEDED,
        },
      });
      expect(attempt2.attemptNumber).toBe(2);
    });
  });

  describe('6. External Reference Mapping Invariants', () => {
    it('prevents duplicate provider resource mappings within an organization', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Catalog Co', slug: 'catalog-co' },
      });

      const int = await prisma.integration.create({
        data: {
          organizationId: org.id,
          provider: IntegrationProvider.SHOPIFY,
          name: 'Shopify Store',
        },
      });

      const order = await prisma.externalOrder.create({
        data: {
          organizationId: org.id,
          externalOrderNumber: 'ORD-REF-01',
        },
      });

      // Create external reference
      await prisma.externalReference.create({
        data: {
          organizationId: org.id,
          externalOrderId: order.id,
          integrationId: int.id,
          resourceType: 'ORDER',
          externalId: 'gid://shopify/Order/999999',
          externalReference: 'WEB-999999',
        },
      });

      // Reject duplicate mapping for same [org, integration, resourceType, externalId]
      await expect(
        prisma.externalReference.create({
          data: {
            organizationId: org.id,
            externalOrderId: order.id,
            integrationId: int.id,
            resourceType: 'ORDER',
            externalId: 'gid://shopify/Order/999999',
            externalReference: 'ANOTHER-REF',
          },
        }),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    });
  });

  describe('7. Approval & Workflow Relationships', () => {
    it('supports recovery case, workflow, DAG step dependencies, and human approval tracking', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Approval Corp', slug: 'approval-corp' },
      });

      const user = await prisma.user.create({
        data: {
          email: 'ops@approval.test',
          name: 'Ops Manager',
          passwordHash: 'dummy_hash',
        },
      });

      const rCase = await prisma.recoveryCase.create({
        data: {
          organizationId: org.id,
          type: RecoveryCaseType.INVALID_ORDER_DATA,
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
          status: RecoveryCaseStatus.WAITING_APPROVAL,
          summary: 'Shipping address missing postal code',
        },
      });

      const workflow = await prisma.workflow.create({
        data: {
          organizationId: org.id,
          recoveryCaseId: rCase.id,
          templateKey: 'ADDRESS_CORRECTION_WORKFLOW',
          templateVersion: 1,
          status: WorkflowStatus.WAITING,
        },
      });

      // Step 1: Request Correction
      const step1 = await prisma.workflowStep.create({
        data: {
          organizationId: org.id,
          workflowId: workflow.id,
          key: 'REQUEST_CORRECTION',
          name: 'Request Address Correction',
          position: 1,
          status: WorkflowStepStatus.SUCCEEDED,
        },
      });

      // Step 2: Depends on Step 1
      const step2 = await prisma.workflowStep.create({
        data: {
          organizationId: org.id,
          workflowId: workflow.id,
          key: 'SUBMIT_TO_3PL',
          name: 'Submit Updated Order to 3PL',
          position: 2,
          status: WorkflowStepStatus.PENDING,
          dependsOnStepId: step1.id,
        },
      });

      expect(step2.dependsOnStepId).toBe(step1.id);

      // Verify DAG self-relation
      const step2WithParent = await prisma.workflowStep.findUnique({
        where: { id: step2.id },
        include: { dependsOn: true },
      });
      expect(step2WithParent?.dependsOn?.key).toBe('REQUEST_CORRECTION');

      // Create Approval
      const approval = await prisma.approval.create({
        data: {
          organizationId: org.id,
          recoveryCaseId: rCase.id,
          workflowId: workflow.id,
          workflowStepId: step2.id,
          requestedByUserId: user.id,
          status: ApprovalStatus.PENDING,
          reason: 'Manual validation of international postal code required',
        },
      });

      expect(approval.status).toBe(ApprovalStatus.PENDING);
      expect(approval.requestedByUserId).toBe(user.id);
    });
  });

  describe('8. AuditLog Invariants', () => {
    it('records append-oriented audit events with or without an actor user and preserves records on user delete', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Audit Co', slug: 'audit-co' },
      });

      const actor = await prisma.user.create({
        data: {
          email: 'auditor@reloop.test',
          name: 'Auditor User',
          passwordHash: 'dummy_hash',
        },
      });

      // 1. User-initiated audit record
      const userAudit = await prisma.auditLog.create({
        data: {
          organizationId: org.id,
          actorUserId: actor.id,
          entityType: 'RECOVERY_CASE',
          entityId: 'rc-100',
          action: 'CASE_RESOLVED',
          metadata: { reason: 'Resolved manually by operator' },
        },
      });

      // 2. System-generated audit record (no actor user)
      const systemAudit = await prisma.auditLog.create({
        data: {
          organizationId: org.id,
          actorUserId: null,
          entityType: 'RECOVERY_CASE',
          entityId: 'rc-101',
          action: 'CASE_DETECTED',
          metadata: { scanner: 'periodic_sync_scanner' },
        },
      });

      expect(systemAudit.actorUserId).toBeNull();
      expect(userAudit.actorUserId).toBe(actor.id);

      // 3. Deleting actor user sets actorUserId to null without deleting the audit history
      await prisma.user.delete({ where: { id: actor.id } });

      const reloadedUserAudit = await prisma.auditLog.findUnique({ where: { id: userAudit.id } });
      expect(reloadedUserAudit).not.toBeNull();
      expect(reloadedUserAudit?.actorUserId).toBeNull();
    });
  });

  describe('9. Money Precision Invariants', () => {
    it('persists monetary amounts using Decimal to prevent floating point inaccuracies', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Fintech Retail', slug: 'fintech-retail' },
      });

      const order = await prisma.externalOrder.create({
        data: {
          organizationId: org.id,
          externalOrderNumber: 'ORD-MONEY-01',
          currency: 'USD',
          totalAmount: new Prisma.Decimal('199.99'),
        },
      });

      const retrieved = await prisma.externalOrder.findUnique({ where: { id: order.id } });
      expect(retrieved?.totalAmount?.toString()).toBe('199.99');
    });
  });
});
