import * as dotenv from 'dotenv';
import Redis from 'ioredis';
import {
  PrismaClient,
  WorkflowStatus,
  WorkflowStepStatus,
  JobStatus,
  ApprovalStatus,
  Role,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
} from '@prisma/client';
import {
  WorkflowTemplateRegistry,
  registerSystemTemplates,
} from '@reloop/workflow-core';
import { WorkflowCoordinator } from '../apps/scheduler/src/workflow-coordinator';
import { WorkflowCreationService } from '../apps/scheduler/src/workflow-creator';
import { SchedulerService } from '../apps/scheduler/src/scheduler-service';
import { RedisPublisher } from '../apps/scheduler/src/redis-publisher';
import { loadSchedulerConfig } from '../apps/scheduler/src/config';
import { WorkerService } from '../apps/worker/src/worker-service';
import { loadWorkerConfig } from '../apps/worker/src/config';

dotenv.config();

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runApprovalDemo() {
  console.log('================================================================');
  console.log('  RELOOP DAY 11: HUMAN APPROVAL / HITL & RECOVERY PREVIEW DEMO  ');
  console.log('================================================================\n');

  const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
  await prisma.$connect();
  const redis = new Redis(redisUrl);

  const runId = Math.random().toString(36).substring(2, 8);
  const streamKey = `reloop:demo:approval:${runId}:jobs:ready`;
  const consumerGroup = `approval-demo-group-${runId}`;

  // 1. Template Registry
  const templateRegistry = new WorkflowTemplateRegistry();
  registerSystemTemplates(templateRegistry);

  const creationService = new WorkflowCreationService(prisma, templateRegistry);

  // 2. Scheduler Config & Publisher
  const schedulerConfig = loadSchedulerConfig({
    redisUrl,
    jobStreamKey: streamKey,
    jobConsumerGroup: consumerGroup,
    schedulerIntervalMs: 150,
    dispatchMarkerTtlMs: 200,
    workflowScanIntervalMs: 150,
    workflowScanBatchSize: 10,
  });
  const publisher = new RedisPublisher(schedulerConfig);
  await publisher.connect();
  await publisher.ensureConsumerGroup();

  const coordinator = new WorkflowCoordinator(prisma, templateRegistry, schedulerConfig);
  const scheduler = new SchedulerService(schedulerConfig, prisma, publisher, coordinator);

  // 3. Worker Config & Service
  const workerConfig = loadWorkerConfig({
    redisUrl,
    jobStreamKey: streamKey,
    jobConsumerGroup: consumerGroup,
    workerConcurrency: 4,
    jobLeaseDurationMs: 15000,
    jobRetryDelaysMs: [100, 200],
  });
  const worker = new WorkerService(workerConfig, prisma);

  try {
    const org = await prisma.organization.create({
      data: {
        name: `Approval Demo Org ${runId}`,
        slug: `approval-demo-${runId}`,
      },
    });

    const user = await prisma.user.create({
      data: {
        email: `operator-${runId}@example.com`,
        name: 'Demo Operator',
        passwordHash: 'dummy_hash_value_here',
      },
    });

    await prisma.organizationMember.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        role: Role.OPERATOR,
      },
    });

    console.log(`[Setup] Created Organization: ${org.name} (${org.id})`);
    console.log(`[Setup] Created Operator: ${user.email} (${user.id})`);
    console.log('[Setup] Starting Scheduler and Worker background engines...\n');

    await scheduler.start();
    await worker.start();

    // =========================================================================
    // SCENARIO 1: APPROVAL APPROVED (CHECK -> APPROVAL -> EXECUTE -> VERIFY)
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('SCENARIO 1: HITL APPROVAL APPROVED FLOW');
    console.log('  Flow: STEP_CHECK -> STEP_APPROVAL (WAITING) -> APPROVE -> STEP_EXECUTE -> STEP_VERIFY');
    console.log('----------------------------------------------------------------');

    const case1 = await prisma.recoveryCase.create({
      data: {
        organizationId: org.id,
        type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY, recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        status: RecoveryCaseStatus.OPEN,
        summary: 'Lost tracking package requiring replacement',
      },
    });

    const wf1 = await creationService.createWorkflowInstance({
      organizationId: org.id,
      recoveryCaseId: case1.id,
      templateKey: 'SYSTEM_APPROVAL',
      templateVersion: 1,
    });

    console.log(`[Scenario 1] Created workflow: ${wf1.id} (Template: SYSTEM_APPROVAL v1)`);

    // Poll until STEP_APPROVAL pauses the workflow in WAITING
    console.log('[Scenario 1] Waiting for STEP_CHECK to succeed and STEP_APPROVAL to pause workflow in WAITING...');
    let approvalRecord1: any = null;
    const startTime1 = Date.now();

    while (Date.now() - startTime1 < 10000) {
      await sleep(200);
      const currentWf = await prisma.workflow.findUnique({
        where: { id: wf1.id },
        include: { steps: { include: { approvals: true, jobs: true } } },
      });

      if (currentWf?.status === WorkflowStatus.WAITING) {
        const approvalStep = currentWf.steps.find((s) => s.key === 'STEP_APPROVAL');
        if (approvalStep?.status === WorkflowStepStatus.WAITING && approvalStep.approvals.length > 0) {
          approvalRecord1 = approvalStep.approvals[0];
          console.log(`[Scenario 1] Workflow successfully paused in WAITING!`);
          console.log(`[Scenario 1] Approval record created with ID: ${approvalRecord1.id}`);
          console.log(`[Scenario 1] Approval status: ${approvalRecord1.status}`);
          console.log(`[Scenario 1] Approval preview snapshot:`, JSON.stringify(approvalRecord1.previewSnapshot, null, 2));
          console.log(`[Scenario 1] Jobs count for STEP_APPROVAL: ${approvalStep.jobs.length} (must be 0)`);
          if (approvalStep.jobs.length !== 0) {
            throw new Error('Zero-job invariant violated on approval step!');
          }
          break;
        }
      }
    }

    if (!approvalRecord1) {
      throw new Error('Scenario 1 timed out waiting for workflow to enter WAITING status');
    }

    // Now simulate human operator approving
    console.log('\n[Scenario 1] Simulating Human Operator APPROVING the action...');
    await prisma.$transaction(async (tx) => {
      // Row lock
      await tx.$executeRaw`SELECT id FROM workflows WHERE id = ${wf1.id}::uuid FOR UPDATE`;
      await tx.$executeRaw`
        UPDATE approvals
        SET status = 'APPROVED'::"ApprovalStatus", decided_by_user_id = ${user.id}::uuid, decided_at = NOW(), reason = 'Operator confirmed replacement item'
        WHERE id = ${approvalRecord1.id}::uuid AND status = 'PENDING'::"ApprovalStatus"
      `;
      await tx.$executeRaw`
        UPDATE workflow_steps
        SET status = 'SUCCEEDED'::"WorkflowStepStatus", completed_at = NOW()
        WHERE id = ${approvalRecord1.workflowStepId}::uuid AND status = 'WAITING'::"WorkflowStepStatus"
      `;
      await tx.$executeRaw`
        UPDATE workflows
        SET status = 'RUNNING'::"WorkflowStatus"
        WHERE id = ${wf1.id}::uuid AND status = 'WAITING'::"WorkflowStatus"
      `;
      await tx.auditLog.create({
        data: {
          organizationId: org.id,
          actorUserId: user.id,
          entityType: 'APPROVAL',
          entityId: approvalRecord1.id,
          action: 'APPROVAL_APPROVED',
          metadata: { note: 'Operator confirmed replacement item' },
        },
      });
    });
    console.log('[Scenario 1] Approval granted & audit log written.');

    // Wait for downstream steps to execute and workflow to reach SUCCEEDED
    console.log('[Scenario 1] Waiting for downstream STEP_EXECUTE and STEP_VERIFY to finish...');
    const startTime1End = Date.now();
    let completedWf1: any = null;

    while (Date.now() - startTime1End < 10000) {
      await sleep(200);
      const currentWf = await prisma.workflow.findUnique({
        where: { id: wf1.id },
        include: { steps: { include: { jobs: true } } },
      });

      if (currentWf?.status === WorkflowStatus.SUCCEEDED) {
        completedWf1 = currentWf;
        break;
      }
    }

    if (!completedWf1) {
      throw new Error('Scenario 1 timed out waiting for workflow to reach SUCCEEDED');
    }

    console.log(`[Scenario 1] Workflow SUCCEEDED!`);
    for (const step of completedWf1.steps) {
      console.log(`  - Step: ${step.key} | Status: ${step.status} | Jobs: ${step.jobs.length}`);
    }

    // =========================================================================
    // SCENARIO 2: APPROVAL REJECTED FLOW
    // =========================================================================
    console.log('\n----------------------------------------------------------------');
    console.log('SCENARIO 2: HITL APPROVAL REJECTED FLOW');
    console.log('  Flow: STEP_CHECK -> STEP_APPROVAL (WAITING) -> REJECT -> STEP_APPROVAL (BLOCKED) -> WORKFLOW (BLOCKED)');
    console.log('----------------------------------------------------------------');

    const case2 = await prisma.recoveryCase.create({
      data: {
        organizationId: org.id,
        type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY, recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
        status: RecoveryCaseStatus.OPEN,
        summary: 'Suspected fraudulent replacement request',
      },
    });

    const wf2 = await creationService.createWorkflowInstance({
      organizationId: org.id,
      recoveryCaseId: case2.id,
      templateKey: 'SYSTEM_APPROVAL',
      templateVersion: 1,
    });

    console.log(`[Scenario 2] Created workflow: ${wf2.id} (Template: SYSTEM_APPROVAL v1)`);

    // Poll until STEP_APPROVAL pauses the workflow in WAITING
    console.log('[Scenario 2] Waiting for STEP_CHECK to succeed and STEP_APPROVAL to pause workflow in WAITING...');
    let approvalRecord2: any = null;
    const startTime2 = Date.now();

    while (Date.now() - startTime2 < 10000) {
      await sleep(200);
      const currentWf = await prisma.workflow.findUnique({
        where: { id: wf2.id },
        include: { steps: { include: { approvals: true, jobs: true } } },
      });

      if (currentWf?.status === WorkflowStatus.WAITING) {
        const approvalStep = currentWf.steps.find((s) => s.key === 'STEP_APPROVAL');
        if (approvalStep?.status === WorkflowStepStatus.WAITING && approvalStep.approvals.length > 0) {
          approvalRecord2 = approvalStep.approvals[0];
          console.log(`[Scenario 2] Workflow paused in WAITING as expected.`);
          break;
        }
      }
    }

    if (!approvalRecord2) {
      throw new Error('Scenario 2 timed out waiting for workflow to enter WAITING status');
    }

    // Now simulate human operator rejecting
    console.log('[Scenario 2] Simulating Human Operator REJECTING the action with reason...');
    const rejectionReason = 'Customer order address failed fraud risk screening';
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM workflows WHERE id = ${wf2.id}::uuid FOR UPDATE`;
      await tx.$executeRaw`
        UPDATE approvals
        SET status = 'REJECTED'::"ApprovalStatus", decided_by_user_id = ${user.id}::uuid, decided_at = NOW(), reason = ${rejectionReason}
        WHERE id = ${approvalRecord2.id}::uuid AND status = 'PENDING'::"ApprovalStatus"
      `;
      await tx.$executeRaw`
        UPDATE workflow_steps
        SET status = 'BLOCKED'::"WorkflowStepStatus", completed_at = NOW()
        WHERE id = ${approvalRecord2.workflowStepId}::uuid AND status = 'WAITING'::"WorkflowStepStatus"
      `;
      await tx.$executeRaw`
        UPDATE workflows
        SET status = 'BLOCKED'::"WorkflowStatus", completed_at = NOW()
        WHERE id = ${wf2.id}::uuid AND status = 'WAITING'::"WorkflowStatus"
      `;
      await tx.auditLog.create({
        data: {
          organizationId: org.id,
          actorUserId: user.id,
          entityType: 'APPROVAL',
          entityId: approvalRecord2.id,
          action: 'APPROVAL_REJECTED',
          metadata: { reason: rejectionReason },
        },
      });
    });
    console.log('[Scenario 2] Approval rejected & audit log written.');

    // Give scheduler and coordinator 1 second to ensure no downstream jobs run
    await sleep(1000);

    const checkWf2 = await prisma.workflow.findUnique({
      where: { id: wf2.id },
      include: { steps: { include: { jobs: true } } },
    });

    console.log(`[Scenario 2] Workflow final status: ${checkWf2?.status}`);
    console.log('[Scenario 2] Verifying downstream steps:');
    for (const step of checkWf2!.steps) {
      console.log(`  - Step: ${step.key} | Status: ${step.status} | Jobs: ${step.jobs.length}`);
      if (['STEP_EXECUTE', 'STEP_VERIFY'].includes(step.key)) {
        if (step.status !== WorkflowStepStatus.PENDING || step.jobs.length !== 0) {
          throw new Error(`Downstream step ${step.key} was activated despite rejection!`);
        }
      }
    }

    console.log('\n================================================================');
    console.log('  ALL HITL APPROVAL SCENARIOS VERIFIED AND COMPLETED SAFELY!   ');
    console.log('================================================================\n');
  } finally {
    await scheduler.stop();
    await worker.stop();
    await publisher.close();
    await redis.quit();
    await prisma.$disconnect();
  }
}

runApprovalDemo().catch((err) => {
  console.error('Approval demo failed:', err);
  process.exit(1);
});


