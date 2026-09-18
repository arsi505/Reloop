import * as dotenv from 'dotenv';
import Redis from 'ioredis';
import {
  PrismaClient,
  WorkflowStatus,
  WorkflowStepStatus,
  JobStatus,
  JobAttemptStatus,
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

async function runWorkflowEngineDemo() {
  console.log('================================================================');
  console.log('  RELOOP DAY 10: VERSIONED WORKFLOW / DAG ORCHESTRATION DEMO   ');
  console.log('================================================================\n');

  const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl } } });
  await prisma.$connect();
  const redis = new Redis(redisUrl);

  const runId = Math.random().toString(36).substring(2, 8);
  const streamKey = `reloop:demo:wf:${runId}:jobs:ready`;
  const consumerGroup = `workflow-demo-group-${runId}`;

  // 1. Setup template registry
  const templateRegistry = new WorkflowTemplateRegistry();
  registerSystemTemplates(templateRegistry);

  const creationService = new WorkflowCreationService(prisma, templateRegistry);

  // Setup Scheduler & Publisher
  const schedulerConfig = loadSchedulerConfig({
    redisUrl,
    jobStreamKey: streamKey,
    jobConsumerGroup: consumerGroup,
    schedulerIntervalMs: 200,
    dispatchMarkerTtlMs: 200,
    workflowScanIntervalMs: 200,
    workflowScanBatchSize: 10,
  });
  const publisher = new RedisPublisher(schedulerConfig);
  await publisher.connect();
  await publisher.ensureConsumerGroup();

  const coordinator = new WorkflowCoordinator(prisma, templateRegistry, schedulerConfig);
  const scheduler = new SchedulerService(schedulerConfig, prisma, publisher, coordinator);

  // Setup Worker
  const workerConfig = loadWorkerConfig({
    redisUrl,
    jobStreamKey: streamKey,
    jobConsumerGroup: consumerGroup,
    workerConcurrency: 5,
    jobLeaseDurationMs: 15000,
    jobRetryDelaysMs: [200, 400],
  });
  const worker = new WorkerService(workerConfig, prisma);

  try {
    const org = await prisma.organization.create({
      data: {
        name: `Workflow Demo Org ${runId}`,
        slug: `wf-demo-org-${runId}`,
      },
    });

    console.log(`[Setup] Created Demo Organization: ${org.name} (${org.id})`);
    console.log('[Setup] Starting Scheduler, Workflow Coordinator, and Worker engine...');

    await scheduler.start();
    await worker.start();

    // =========================================================================
    // SCENARIO A: SYSTEM_LINEAR_V1 (A -> B -> C)
    // =========================================================================
    console.log('\n----------------------------------------------------------------');
    console.log('SCENARIO A: SYSTEM_LINEAR_V1 (A -> B -> C)');
    console.log('----------------------------------------------------------------');

    const rCaseA = await prisma.recoveryCase.create({
      data: {
        organizationId: org.id,
        type: RecoveryCaseType.TEMPORARY_API_FAILURE,
        recoveryLevel: RecoveryLevel.AUTO_RECOVER,
        status: RecoveryCaseStatus.OPEN,
        summary: 'Demo Scenario A: Linear DAG Execution',
      },
    });

    const wfA = await creationService.createWorkflowInstance({
      organizationId: org.id,
      recoveryCaseId: rCaseA.id,
      templateKey: 'SYSTEM_LINEAR',
      templateVersion: 1,
    });
    console.log(`[Linear] Created workflow instance ${wfA.id} in status ${wfA.status}`);

    // Wait for Linear workflow to reach SUCCEEDED
    let linearFinal = null;
    const maxLinearWait = 150; // 15 seconds
    for (let i = 0; i < maxLinearWait; i++) {
      linearFinal = await prisma.workflow.findUnique({
        where: { id: wfA.id },
        include: { steps: { orderBy: { position: 'asc' }, include: { jobs: true } } },
      });
      if (linearFinal?.status === WorkflowStatus.SUCCEEDED) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (linearFinal?.status !== WorkflowStatus.SUCCEEDED) {
      throw new Error(`Scenario A failed: Workflow did not reach SUCCEEDED in time (status: ${linearFinal?.status})`);
    }

    console.log(`[Linear] Workflow status: ${linearFinal.status}`);
    console.log(`[Linear] Steps count: ${linearFinal.steps.length}`);
    for (const s of linearFinal.steps) {
      console.log(`  - Step ${s.key}: status=${s.status}, jobsCount=${s.jobs.length}, jobStatus=${s.jobs[0]?.status}`);
    }

    // Assertions for Linear
    if (linearFinal.steps.length !== 3) throw new Error('Expected 3 steps');
    if (!linearFinal.steps.every((s) => s.status === WorkflowStepStatus.SUCCEEDED)) {
      throw new Error('Not all steps reached SUCCEEDED');
    }
    const allLinearJobs = await prisma.job.findMany({ where: { workflowId: wfA.id } });
    if (allLinearJobs.length !== 3) throw new Error(`Expected 3 logical jobs, found ${allLinearJobs.length}`);

    // Verify ordering by completedAt
    const stepCompletedTimes = linearFinal.steps.map((s) => s.completedAt!.getTime());
    if (stepCompletedTimes[0] > stepCompletedTimes[1] || stepCompletedTimes[1] > stepCompletedTimes[2]) {
      throw new Error('Steps were not completed in strict linear order');
    }
    console.log('[Linear] SCENARIO A PASSED cleanly with strict dependency ordering!');

    // =========================================================================
    // SCENARIO B: SYSTEM_PARALLEL_JOIN_V1 (A -> (B, C) -> D)
    // =========================================================================
    console.log('\n----------------------------------------------------------------');
    console.log('SCENARIO B: SYSTEM_PARALLEL_JOIN_V1 (A -> B + C in parallel -> D)');
    console.log('----------------------------------------------------------------');

    const rCaseB = await prisma.recoveryCase.create({
      data: {
        organizationId: org.id,
        type: RecoveryCaseType.TEMPORARY_API_FAILURE,
        recoveryLevel: RecoveryLevel.AUTO_RECOVER,
        status: RecoveryCaseStatus.OPEN,
        summary: 'Demo Scenario B: Parallel Join Execution',
      },
    });

    const wfB = await creationService.createWorkflowInstance({
      organizationId: org.id,
      recoveryCaseId: rCaseB.id,
      templateKey: 'SYSTEM_PARALLEL_JOIN',
      templateVersion: 1,
    });
    console.log(`[Parallel] Created workflow instance ${wfB.id} in status ${wfB.status}`);

    let parallelFinal = null;
    for (let i = 0; i < maxLinearWait; i++) {
      parallelFinal = await prisma.workflow.findUnique({
        where: { id: wfB.id },
        include: { steps: { orderBy: { position: 'asc' }, include: { jobs: true } } },
      });
      if (parallelFinal?.status === WorkflowStatus.SUCCEEDED) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (parallelFinal?.status !== WorkflowStatus.SUCCEEDED) {
      throw new Error(`Scenario B failed: Workflow did not reach SUCCEEDED (status: ${parallelFinal?.status})`);
    }

    console.log(`[Parallel] Workflow status: ${parallelFinal.status}`);
    for (const s of parallelFinal.steps) {
      console.log(`  - Step ${s.key}: status=${s.status}, jobsCount=${s.jobs.length}, jobStatus=${s.jobs[0]?.status}`);
    }

    const stepMapB = new Map(parallelFinal.steps.map((s) => [s.key, s]));
    const stepA = stepMapB.get('STEP_A')!;
    const stepB = stepMapB.get('STEP_B')!;
    const stepC = stepMapB.get('STEP_C')!;
    const stepD = stepMapB.get('STEP_D')!;

    // Step D completedAt must be >= both Step B and Step C completedAt
    if (stepD.completedAt!.getTime() < stepB.completedAt!.getTime() || stepD.completedAt!.getTime() < stepC.completedAt!.getTime()) {
      throw new Error('Step D completed before upstream parallel branches completed');
    }
    console.log('[Parallel] SCENARIO B PASSED: Step D waited for both B and C to complete!');

    // =========================================================================
    // SCENARIO C: SYSTEM_RETRY_V1 (Transient Failure on Attempt 1, Success on Attempt 2)
    // =========================================================================
    console.log('\n----------------------------------------------------------------');
    console.log('SCENARIO C: SYSTEM_RETRY_V1 (Transient Failure -> Retry -> Success)');
    console.log('----------------------------------------------------------------');

    const rCaseC = await prisma.recoveryCase.create({
      data: {
        organizationId: org.id,
        type: RecoveryCaseType.TEMPORARY_API_FAILURE,
        recoveryLevel: RecoveryLevel.AUTO_RECOVER,
        status: RecoveryCaseStatus.OPEN,
        summary: 'Demo Scenario C: Retry in Workflow',
      },
    });

    const wfC = await creationService.createWorkflowInstance({
      organizationId: org.id,
      recoveryCaseId: rCaseC.id,
      templateKey: 'SYSTEM_RETRY',
      templateVersion: 1,
    });
    console.log(`[Retry] Created workflow instance ${wfC.id}`);

    let retryFinal = null;
    for (let i = 0; i < maxLinearWait; i++) {
      retryFinal = await prisma.workflow.findUnique({
        where: { id: wfC.id },
        include: { steps: { include: { jobs: { include: { attempts: true } } } } },
      });
      if (retryFinal?.status === WorkflowStatus.SUCCEEDED) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (retryFinal?.status !== WorkflowStatus.SUCCEEDED) {
      throw new Error(`Scenario C failed: Workflow did not reach SUCCEEDED (status: ${retryFinal?.status})`);
    }

    const retryStep = retryFinal.steps[0];
    const retryJob = retryStep.jobs[0];

    console.log(`[Retry] Workflow status: ${retryFinal.status}`);
    console.log(`[Retry] Step status: ${retryStep.status}`);
    console.log(`[Retry] Job status: ${retryJob.status}, attemptCount: ${retryJob.attemptCount}`);
    console.log(`[Retry] JobAttempts recorded: ${retryJob.attempts.length}`);
    for (const att of retryJob.attempts) {
      console.log(`  - Attempt #${att.attemptNumber}: status=${att.status}, startedAt=${att.startedAt.toISOString()}`);
    }

    if (retryJob.attemptCount < 2) throw new Error('Expected at least 2 attempts');
    if (retryJob.attempts.length < 2) throw new Error('Expected at least 2 JobAttempt rows');
    if (retryJob.attempts[0].status !== JobAttemptStatus.FAILED) throw new Error('Attempt 1 should be FAILED');
    if (retryJob.attempts[1].status !== JobAttemptStatus.SUCCEEDED) throw new Error('Attempt 2 should be SUCCEEDED');

    // Exactly 1 WorkflowStep and 1 Job
    const totalJobsC = await prisma.job.findMany({ where: { workflowId: wfC.id } });
    if (totalJobsC.length !== 1) throw new Error('Expected exactly 1 logical Job for retry step');

    console.log('[Retry] SCENARIO C PASSED: Retry reused same Job and same WorkflowStep across multiple JobAttempts!');

    console.log('\n================================================================');
    console.log('  ALL WORKFLOW ENGINE DEMO SCENARIOS PASSED WITH FULL INTEGRITY!  ');
    console.log('================================================================\n');
  } finally {
    await scheduler.stop();
    await worker.stop();
    await publisher.close();
    await redis.del(streamKey);
    await redis.quit();
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runWorkflowEngineDemo().catch((err) => {
    console.error('\nFatal Demo Error:', err);
    process.exit(1);
  });
}
