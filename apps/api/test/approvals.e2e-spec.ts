import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Configuration error: TEST_DATABASE_URL environment variable is required for E2E tests.');
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApprovalsService } from '../src/approvals/approvals.service';
import {
  Role,
  ApprovalStatus,
  WorkflowStatus,
  WorkflowStepStatus,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
} from '@reloop/database';
import { SecurityUtil } from '../src/auth/security.util';

describe('Day 11: Approvals API & HITL Boundary E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvalsService: ApprovalsService;

  let orgAId: string;
  let orgBId: string;

  let tokenOwnerA: string;
  let tokenAdminA: string;
  let tokenOperatorA: string;
  let tokenViewerA: string;
  let tokenOwnerB: string;

  let userOwnerAId: string;
  let userAdminAId: string;
  let userOperatorAId: string;
  let userViewerAId: string;

  const validPreviewSnapshot = {
    version: 1,
    problem: 'Carrier package destroyed in transit',
    proposedAction: 'Dispatch replacement item with express courier',
    why: 'Courier confirmed lost/destroyed tracking exception',
    safetyChecks: ['Verify replacement stock exists', 'Ensure shipping address valid'],
    changes: ['Generate label', 'Deduct inventory'],
    nonChanges: ['Do not refund credit card payment'],
    systems: ['Shopify', 'ShipStation'],
    risks: ['Carrier holiday delivery delay'],
    recoveryLevel: 'L2_REPLACE',
    caseReference: 'CASE-E2E-001',
    orderReference: 'ORD-E2E-999',
    expectedVerification: 'Tracking scan within 30 minutes',
  };

  beforeAll(async () => {
    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
    prisma = app.get(PrismaService);
    approvalsService = app.get(ApprovalsService);

    // Clean tables before suite
    await cleanDatabase();

    // 1. Setup Org A and Org B
    const hash = await SecurityUtil.hashPassword('Password123!');

    // Org A
    const orgA = await prisma.organization.create({
      data: { name: 'Acme Corp', slug: 'acme-corp' },
    });
    orgAId = orgA.id;

    // Org A Users
    const userOwnerA = await prisma.user.create({
      data: { email: 'owner.a@acme.com', name: 'Owner A', passwordHash: hash },
    });
    userOwnerAId = userOwnerA.id;
    await prisma.organizationMember.create({
      data: { organizationId: orgAId, userId: userOwnerA.id, role: Role.OWNER },
    });

    const userAdminA = await prisma.user.create({
      data: { email: 'admin.a@acme.com', name: 'Admin A', passwordHash: hash },
    });
    userAdminAId = userAdminA.id;
    await prisma.organizationMember.create({
      data: { organizationId: orgAId, userId: userAdminA.id, role: Role.ADMIN },
    });

    const userOperatorA = await prisma.user.create({
      data: { email: 'operator.a@acme.com', name: 'Operator A', passwordHash: hash },
    });
    userOperatorAId = userOperatorA.id;
    await prisma.organizationMember.create({
      data: { organizationId: orgAId, userId: userOperatorA.id, role: Role.OPERATOR },
    });

    const userViewerA = await prisma.user.create({
      data: { email: 'viewer.a@acme.com', name: 'Viewer A', passwordHash: hash },
    });
    userViewerAId = userViewerA.id;
    await prisma.organizationMember.create({
      data: { organizationId: orgAId, userId: userViewerA.id, role: Role.VIEWER },
    });

    // Org B
    const orgB = await prisma.organization.create({
      data: { name: 'Beta Ltd', slug: 'beta-ltd' },
    });
    orgBId = orgB.id;

    const userOwnerB = await prisma.user.create({
      data: { email: 'owner.b@beta.com', name: 'Owner B', passwordHash: hash },
    });
    await prisma.organizationMember.create({
      data: { organizationId: orgBId, userId: userOwnerB.id, role: Role.OWNER },
    });

    // Login each user to get access tokens
    tokenOwnerA = (await loginUser('owner.a@acme.com')).accessToken;
    tokenAdminA = (await loginUser('admin.a@acme.com')).accessToken;
    tokenOperatorA = (await loginUser('operator.a@acme.com')).accessToken;
    tokenViewerA = (await loginUser('viewer.a@acme.com')).accessToken;
    tokenOwnerB = (await loginUser('owner.b@beta.com')).accessToken;
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  async function cleanDatabase() {
    await prisma.auditLog.deleteMany({});
    await prisma.approval.deleteMany({});
    await prisma.jobAttempt.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.workflowStep.deleteMany({});
    await prisma.workflow.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.refreshSession.deleteMany({});
    await prisma.organizationMember.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.user.deleteMany({});
  }

  async function loginUser(email: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(200);
    return res.body;
  }

  async function createApprovalFixture(
    orgId: string,
    overrides: {
      workflowStatus?: WorkflowStatus;
      approvalStatus?: ApprovalStatus;
      stepStatus?: WorkflowStepStatus;
    } = {},
  ) {
    const recoveryCase = await prisma.recoveryCase.create({
      data: {
        organizationId: orgId,
        type: RecoveryCaseType.STUCK_ORDER,
        recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        status: RecoveryCaseStatus.WAITING_APPROVAL,
        summary: 'Delivery carrier exception',
      },
    });

    const workflow = await prisma.workflow.create({
      data: {
        organizationId: orgId,
        recoveryCaseId: recoveryCase.id,
        templateKey: 'SYSTEM_APPROVAL',
        templateVersion: 1,
        status: overrides.workflowStatus ?? WorkflowStatus.WAITING,
      },
    });

    const checkOutput = {
      safeToExecute: true,
      orderNumber: 'ORD-E2E-999',
      safetyFingerprint: 'e2e-verified-check-context',
    };
    const checkStep = await prisma.workflowStep.create({
      data: {
        organizationId: orgId,
        workflowId: workflow.id,
        key: 'CHECK',
        name: 'Verify approval context',
        position: 1,
        status: WorkflowStepStatus.SUCCEEDED,
        output: checkOutput,
        completedAt: new Date(),
      },
    });

    const step = await prisma.workflowStep.create({
      data: {
        organizationId: orgId,
        workflowId: workflow.id,
        key: 'STEP_APPROVAL',
        name: 'Step Approval - Human Decision',
        position: 2,
        status: overrides.stepStatus ?? WorkflowStepStatus.WAITING,
        dependsOnStepId: checkStep.id,
      },
    });

    const approval = await prisma.approval.create({
      data: {
        organizationId: orgId,
        recoveryCaseId: recoveryCase.id,
        workflowId: workflow.id,
        workflowStepId: step.id,
        status: overrides.approvalStatus ?? ApprovalStatus.PENDING,
        previewSnapshot: { ...validPreviewSnapshot, verifiedContext: checkOutput },
      },
    });

    return { recoveryCase, workflow, step, approval };
  }

  describe('1. Authentication Guards', () => {
    it('rejects unauthenticated GET /approvals with 401', async () => {
      await request(app.getHttpServer()).get('/approvals').expect(401);
    });

    it('rejects unauthenticated GET /approvals/:id with 401', async () => {
      await request(app.getHttpServer()).get('/approvals/some-uuid').expect(401);
    });

    it('rejects unauthenticated POST /approvals/:id/approve with 401', async () => {
      await request(app.getHttpServer())
        .post('/approvals/some-uuid/approve')
        .send({ note: 'ok' })
        .expect(401);
    });

    it('rejects unauthenticated POST /approvals/:id/reject with 401', async () => {
      await request(app.getHttpServer())
        .post('/approvals/some-uuid/reject')
        .send({ reason: 'no' })
        .expect(401);
    });

    it('rejects invalid bearer token with 401', async () => {
      await request(app.getHttpServer())
        .get('/approvals')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);
    });
  });

  describe('2. Multi-Tenant Isolation', () => {
    it('isolates approval lists across organizations', async () => {
      const fixA = await createApprovalFixture(orgAId);
      const fixB = await createApprovalFixture(orgBId);

      const resA = await request(app.getHttpServer())
        .get('/approvals')
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .expect(200);

      const idsA = resA.body.map((a: any) => a.id);
      expect(idsA).toContain(fixA.approval.id);
      expect(idsA).not.toContain(fixB.approval.id);

      const resB = await request(app.getHttpServer())
        .get('/approvals')
        .set('Authorization', `Bearer ${tokenOwnerB}`)
        .expect(200);

      const idsB = resB.body.map((a: any) => a.id);
      expect(idsB).toContain(fixB.approval.id);
      expect(idsB).not.toContain(fixA.approval.id);
    });

    it('cross-tenant GET /approvals/:id returns 404 Not Found', async () => {
      const fixA = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .get(`/approvals/${fixA.approval.id}`)
        .set('Authorization', `Bearer ${tokenOwnerB}`)
        .expect(404);
    });

    it('cross-tenant POST /approvals/:id/approve returns 404 Not Found', async () => {
      const fixA = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .post(`/approvals/${fixA.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOwnerB}`)
        .send({ note: 'Cross-tenant attack' })
        .expect(404);
    });

    it('cross-tenant POST /approvals/:id/reject returns 404 Not Found', async () => {
      const fixA = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .post(`/approvals/${fixA.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenOwnerB}`)
        .send({ reason: 'Cross-tenant attack' })
        .expect(404);
    });
  });

  describe('3. Role-Based Access Control (RBAC)', () => {
    it('VIEWER cannot approve (403 Forbidden)', async () => {
      const fixture = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenViewerA}`)
        .send({ note: 'Viewer should fail' })
        .expect(403);
    });

    it('VIEWER cannot reject (403 Forbidden)', async () => {
      const fixture = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenViewerA}`)
        .send({ reason: 'Viewer should fail' })
        .expect(403);
    });

    it('OPERATOR can approve (200/201)', async () => {
      const fixture = await createApprovalFixture(orgAId);

      const res = await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOperatorA}`)
        .send({ note: 'Operator approved' })
        .expect(201);

      expect(res.body.status).toBe(ApprovalStatus.APPROVED);
      expect(res.body.reason).toBe('Operator approved');
    });

    it('ADMIN can reject (200/201)', async () => {
      const fixture = await createApprovalFixture(orgAId);

      const res = await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ reason: 'Admin rejected due to high risk' })
        .expect(201);

      expect(res.body.status).toBe(ApprovalStatus.REJECTED);
      expect(res.body.reason).toBe('Admin rejected due to high risk');
    });

    it('OWNER can approve and reject', async () => {
      const fixture1 = await createApprovalFixture(orgAId);
      await request(app.getHttpServer())
        .post(`/approvals/${fixture1.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({})
        .expect(201);

      const fixture2 = await createApprovalFixture(orgAId);
      await request(app.getHttpServer())
        .post(`/approvals/${fixture2.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ reason: 'Owner rejected' })
        .expect(201);
    });
  });

  describe('4. Input Validation', () => {
    it('rejects POST /approvals/:id/reject without reason (400 Bad Request)', async () => {
      const fixture = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({})
        .expect(400);
    });

    it('rejects POST /approvals/:id/reject with empty or whitespace-only reason (400 Bad Request)', async () => {
      const fixture = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ reason: '   ' })
        .expect(400);
    });

    it('rejects POST /approvals/:id/reject with reason exceeding 1000 characters (400 Bad Request)', async () => {
      const fixture = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ reason: 'x'.repeat(1001) })
        .expect(400);
    });
  });

  describe('5. Atomic CAS & Race Condition Safety', () => {
    it('rejects duplicate approval with 409 Conflict', async () => {
      const fixture = await createApprovalFixture(orgAId);

      // First decision
      await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ note: 'First approve' })
        .expect(201);

      // Second decision on already decided approval
      const conflictRes = await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ note: 'Second approve' })
        .expect(409);

      expect(conflictRes.body.message).toContain('already been decided');
    });

    it('rejects duplicate rejection with 409 Conflict', async () => {
      const fixture = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ reason: 'First reject' })
        .expect(201);

      const conflictRes = await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ reason: 'Second reject' })
        .expect(409);

      expect(conflictRes.body.message).toContain('already been decided');
    });

    it('rejects rejection on already approved approval with 409 Conflict', async () => {
      const fixture = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ note: 'Approved first' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ reason: 'Too late to reject' })
        .expect(409);

      expect(res.body.message).toContain('already been decided');
    });

    it('concurrent approve vs reject race: exactly one wins and the other gets 409 Conflict', async () => {
      const fixture = await createApprovalFixture(orgAId);

      const [resApprove, resReject] = await Promise.all([
        request(app.getHttpServer())
          .post(`/approvals/${fixture.approval.id}/approve`)
          .set('Authorization', `Bearer ${tokenOperatorA}`)
          .send({ note: 'Race approve' }),
        request(app.getHttpServer())
          .post(`/approvals/${fixture.approval.id}/reject`)
          .set('Authorization', `Bearer ${tokenAdminA}`)
          .send({ reason: 'Race reject' }),
      ]);

      const statusCodes = [resApprove.status, resReject.status].sort();
      expect(statusCodes).toEqual([201, 409]);

      // Verify the winning status is persisted cleanly
      const finalApproval = await prisma.approval.findUnique({
        where: { id: fixture.approval.id },
      });
      expect(['APPROVED', 'REJECTED']).toContain(finalApproval?.status);
    });

    it('concurrent approve vs workflow terminalization race: cannot revive workflow if blocked concurrently', async () => {
      const fixture = await createApprovalFixture(orgAId);

      // Race: approve API request vs concurrent workflow blocking
      const [approveRes] = await Promise.all([
        request(app.getHttpServer())
          .post(`/approvals/${fixture.approval.id}/approve`)
          .set('Authorization', `Bearer ${tokenOperatorA}`)
          .send({ note: 'Race approve' }),
        prisma.workflow.update({
          where: { id: fixture.workflow.id },
          data: { status: WorkflowStatus.BLOCKED },
        }),
      ]);

      expect([201, 400]).toContain(approveRes.status);

      const finalWorkflow = await prisma.workflow.findUnique({
        where: { id: fixture.workflow.id },
      });

      if (approveRes.status === 400) {
        expect(finalWorkflow?.status).toBe(WorkflowStatus.BLOCKED);
        const finalApproval = await prisma.approval.findUnique({
          where: { id: fixture.approval.id },
        });
        expect(finalApproval?.status).toBe(ApprovalStatus.PENDING);
      } else {
        expect([WorkflowStatus.RUNNING, WorkflowStatus.BLOCKED]).toContain(finalWorkflow?.status);
      }
    });

    it('rejects attempt to spoof decidedByUserId in request body (400 Bad Request)', async () => {
      const fixture = await createApprovalFixture(orgAId);

      await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOperatorA}`)
        .send({ note: 'Valid note', decidedByUserId: '00000000-0000-0000-0000-000000000000' })
        .expect(400);
    });
  });

  describe('6. Stale Approval & Terminal Safety', () => {
    it('rejects decision if linked workflow is in FAILED status (400 Bad Request)', async () => {
      const fixture = await createApprovalFixture(orgAId, {
        workflowStatus: WorkflowStatus.FAILED,
      });

      const res = await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ note: 'Stale approve' })
        .expect(400);

      expect(res.body.message).toContain('terminal/blocked status');
    });

    it('rejects decision if linked workflow is in BLOCKED status (400 Bad Request)', async () => {
      const fixture = await createApprovalFixture(orgAId, {
        workflowStatus: WorkflowStatus.BLOCKED,
      });

      const res = await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ reason: 'Stale reject' })
        .expect(400);

      expect(res.body.message).toContain('terminal/blocked status');
    });

    it('rejects decision if linked workflow is in SUCCEEDED status (400 Bad Request)', async () => {
      const fixture = await createApprovalFixture(orgAId, {
        workflowStatus: WorkflowStatus.SUCCEEDED,
      });

      const res = await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ note: 'Stale approve' })
        .expect(400);

      expect(res.body.message).toContain('terminal/blocked status');
    });

    it('stale approval on BLOCKED workflow cannot revive workflow and creates zero downstream jobs', async () => {
      const fixture = await createApprovalFixture(orgAId, {
        workflowStatus: WorkflowStatus.BLOCKED,
      });

      await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOwnerA}`)
        .send({ note: 'Attempt revival' })
        .expect(400);

      const checkWf = await prisma.workflow.findUnique({ where: { id: fixture.workflow.id } });
      expect(checkWf?.status).toBe(WorkflowStatus.BLOCKED);

      const jobs = await prisma.job.findMany({ where: { workflowId: fixture.workflow.id } });
      expect(jobs).toHaveLength(0);
    });
  });

  describe('7. Audit Logging Atomicity & Verification', () => {
    it('creates APPROVAL_APPROVED AuditLog in same transaction when approved', async () => {
      const fixture = await createApprovalFixture(orgAId);

      const res = await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOperatorA}`)
        .send({ note: 'Audited approval note' })
        .expect(201);

      expect(res.body.decidedByUser.id).toBe(userOperatorAId);

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId: orgAId,
          entityType: 'APPROVAL',
          entityId: fixture.approval.id,
          action: 'APPROVAL_APPROVED',
        },
      });

      expect(auditLog).toBeDefined();
      expect(auditLog?.actorUserId).toBe(userOperatorAId);
      const metadata = auditLog?.metadata as any;
      expect(metadata.note).toBe('Audited approval note');
      expect(metadata.workflowId).toBe(fixture.workflow.id);
      expect(metadata.workflowStepId).toBe(fixture.step.id);
    });

    it('creates APPROVAL_REJECTED AuditLog in same transaction when rejected', async () => {
      const fixture = await createApprovalFixture(orgAId);

      const res = await request(app.getHttpServer())
        .post(`/approvals/${fixture.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ reason: 'Audited rejection reason' })
        .expect(201);

      expect(res.body.decidedByUser.id).toBe(userAdminAId);

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId: orgAId,
          entityType: 'APPROVAL',
          entityId: fixture.approval.id,
          action: 'APPROVAL_REJECTED',
        },
      });

      expect(auditLog).toBeDefined();
      expect(auditLog?.actorUserId).toBe(userAdminAId);
      const metadata = auditLog?.metadata as any;
      expect(metadata.reason).toBe('Audited rejection reason');
      expect(metadata.workflowId).toBe(fixture.workflow.id);
      expect(metadata.workflowStepId).toBe(fixture.step.id);
    });

    it('audit insertion failure rolls back decision and preserves PENDING status', async () => {
      const fixture = await createApprovalFixture(orgAId);

      const origTransaction = prisma.$transaction.bind(prisma);
      const txSpy = jest.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
        return origTransaction(async (tx: any) => {
          tx.auditLog.create = jest.fn().mockRejectedValue(new Error('Simulated Audit DB Failure'));
          return cb(tx);
        });
      });

      await expect(
        approvalsService.approveApproval(orgAId, fixture.approval.id, userOperatorAId, 'Test note'),
      ).rejects.toThrow('Simulated Audit DB Failure');

      txSpy.mockRestore();

      // Transaction must have rolled back completely:
      const checkApproval = await prisma.approval.findUnique({ where: { id: fixture.approval.id } });
      expect(checkApproval?.status).toBe(ApprovalStatus.PENDING);

      const checkWf = await prisma.workflow.findUnique({ where: { id: fixture.workflow.id } });
      expect(checkWf?.status).toBe(WorkflowStatus.WAITING);

      const checkStep = await prisma.workflowStep.findUnique({ where: { id: fixture.step.id } });
      expect(checkStep?.status).toBe(WorkflowStepStatus.WAITING);
    });
  });

  describe('8. Zero-Job Invariant on Approval Step', () => {
    it('preserves zero-job invariant on approval step before decision, after approve, and after reject', async () => {
      const fixApprove = await createApprovalFixture(orgAId);
      const jobsBefore = await prisma.job.findMany({ where: { workflowStepId: fixApprove.step.id } });
      expect(jobsBefore).toHaveLength(0);

      await request(app.getHttpServer())
        .post(`/approvals/${fixApprove.approval.id}/approve`)
        .set('Authorization', `Bearer ${tokenOperatorA}`)
        .send({ note: 'Zero job test' })
        .expect(201);

      const jobsAfterApprove = await prisma.job.findMany({ where: { workflowStepId: fixApprove.step.id } });
      expect(jobsAfterApprove).toHaveLength(0);

      const fixReject = await createApprovalFixture(orgAId);
      await request(app.getHttpServer())
        .post(`/approvals/${fixReject.approval.id}/reject`)
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ reason: 'Zero job reject test' })
        .expect(201);

      const jobsAfterReject = await prisma.job.findMany({ where: { workflowStepId: fixReject.step.id } });
      expect(jobsAfterReject).toHaveLength(0);
    });
  });

  describe('9. GET /approvals/:id detail includes previewSnapshot', () => {
    it('returns approval detail with structured previewSnapshot', async () => {
      const fixture = await createApprovalFixture(orgAId);

      const res = await request(app.getHttpServer())
        .get(`/approvals/${fixture.approval.id}`)
        .set('Authorization', `Bearer ${tokenViewerA}`)
        .expect(200);

      expect(res.body.id).toBe(fixture.approval.id);
      expect(res.body.previewSnapshot).toMatchObject(validPreviewSnapshot);
      expect(res.body.workflow).toBeDefined();
      expect(res.body.workflowStep).toBeDefined();
      expect(res.body.recoveryCase).toBeDefined();
    });
  });
});

