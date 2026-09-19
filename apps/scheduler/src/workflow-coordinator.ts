import {
  PrismaClient,
  Prisma,
  Workflow,
  WorkflowStep,
  WorkflowStatus,
  WorkflowStepStatus,
  JobStatus,
  Job,
  ApprovalStatus,
  Approval,
} from '@prisma/client';
import { WorkflowTemplateRegistry, evaluateCondition } from '@reloop/workflow-core';
import { SchedulerConfig } from './config';

export interface WorkflowCoordinatorMetrics {
  scannedCount: number;
  readiedStepsCount: number;
  createdJobsCount: number;
  skippedStepsCount: number;
  completedWorkflowsCount: number;
  failedWorkflowsCount: number;
  blockedWorkflowsCount: number;
  lastTickDurationMs: number;
  lastTickAt: Date | null;
}

export interface WorkflowCoordinatorTickResult {
  scanned: number;
  readiedSteps: number;
  createdJobs: number;
  skippedSteps: number;
  completedWorkflows: number;
  failedWorkflows: number;
  blockedWorkflows: number;
  durationMs: number;
  errors: number;
}

type StepWithJobsAndApprovals = WorkflowStep & { jobs: Job[]; approvals: Approval[] };

export class WorkflowCoordinator {
  private prisma: PrismaClient;
  private templateRegistry: WorkflowTemplateRegistry;
  private scanIntervalMs: number;
  private scanBatchSize: number;

  private isRunning: boolean = false;
  private isTickRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  private metrics: WorkflowCoordinatorMetrics = {
    scannedCount: 0,
    readiedStepsCount: 0,
    createdJobsCount: 0,
    skippedStepsCount: 0,
    completedWorkflowsCount: 0,
    failedWorkflowsCount: 0,
    blockedWorkflowsCount: 0,
    lastTickDurationMs: 0,
    lastTickAt: null,
  };

  constructor(
    prisma: PrismaClient,
    templateRegistry: WorkflowTemplateRegistry,
    config: Partial<SchedulerConfig> = {},
  ) {
    this.prisma = prisma;
    this.templateRegistry = templateRegistry;
    this.scanIntervalMs = config.workflowScanIntervalMs ?? 1000;
    this.scanBatchSize = config.workflowScanBatchSize ?? 20;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextTick(0);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }

  getMetrics(): WorkflowCoordinatorMetrics {
    return { ...this.metrics };
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        console.error('[Reloop WorkflowCoordinator] Unhandled error during tick:', err);
      } finally {
        if (this.isRunning) {
          this.scheduleNextTick(this.scanIntervalMs);
        }
      }
    }, delayMs);
  }

  /**
   * Execute a single reconciliation and progression tick across active workflows.
   * Guarded against overlapping execution within this coordinator instance.
   */
  async tick(): Promise<WorkflowCoordinatorTickResult> {
    if (this.isTickRunning) {
      return {
        scanned: 0,
        readiedSteps: 0,
        createdJobs: 0,
        skippedSteps: 0,
        completedWorkflows: 0,
        failedWorkflows: 0,
        blockedWorkflows: 0,
        durationMs: 0,
        errors: 0,
      };
    }

    this.isTickRunning = true;
    const startTime = Date.now();

    const result: WorkflowCoordinatorTickResult = {
      scanned: 0,
      readiedSteps: 0,
      createdJobs: 0,
      skippedSteps: 0,
      completedWorkflows: 0,
      failedWorkflows: 0,
      blockedWorkflows: 0,
      durationMs: 0,
      errors: 0,
    };

    try {
      // 1. Fetch active workflows: PENDING, RUNNING, or WAITING
      const workflows = await this.prisma.workflow.findMany({
        where: {
          status: { in: [WorkflowStatus.PENDING, WorkflowStatus.RUNNING, WorkflowStatus.WAITING] },
        },
        orderBy: { createdAt: 'asc' },
        take: this.scanBatchSize,
      });

      result.scanned = workflows.length;

      for (const workflow of workflows) {
        try {
          await this.reconcileWorkflow(workflow, result);
        } catch (wfErr) {
          result.errors++;
          console.error(
            `[Reloop WorkflowCoordinator] Error reconciling workflow ${workflow.id}:`,
            wfErr,
          );
        }
      }
    } catch (err) {
      result.errors++;
      console.error('[Reloop WorkflowCoordinator] Tick level error:', err);
    } finally {
      this.isTickRunning = false;
      result.durationMs = Date.now() - startTime;
      this.metrics.scannedCount += result.scanned;
      this.metrics.readiedStepsCount += result.readiedSteps;
      this.metrics.createdJobsCount += result.createdJobs;
      this.metrics.skippedStepsCount += result.skippedSteps;
      this.metrics.completedWorkflowsCount += result.completedWorkflows;
      this.metrics.failedWorkflowsCount += result.failedWorkflows;
      this.metrics.blockedWorkflowsCount += result.blockedWorkflows;
      this.metrics.lastTickDurationMs = result.durationMs;
      this.metrics.lastTickAt = new Date();
    }

    return result;
  }

  /**
   * Reconcile a single workflow instance.
   */
  private async reconcileWorkflow(
    workflow: Workflow,
    result: WorkflowCoordinatorTickResult,
  ): Promise<void> {
    // 1. Load exact template key and version
    const template = this.templateRegistry.get(workflow.templateKey, workflow.templateVersion);
    if (!template) {
      // Rule 14: MISSING TEMPLATE SAFETY - Transition Workflow to BLOCKED
      console.warn(
        `[Reloop WorkflowCoordinator] Template "${workflow.templateKey}" v${workflow.templateVersion} is not registered. Blocking workflow ${workflow.id}.`,
      );
      await this.prisma.workflow.update({
        where: { id: workflow.id },
        data: { status: WorkflowStatus.BLOCKED },
      });
      result.blockedWorkflows++;
      return;
    }

    // 2. Load all WorkflowSteps with their linked Jobs and Approvals
    const steps: StepWithJobsAndApprovals[] = await this.prisma.workflowStep.findMany({
      where: {
        workflowId: workflow.id,
        organizationId: workflow.organizationId,
      },
      include: {
        jobs: true,
        approvals: true,
      },
      orderBy: { position: 'asc' },
    });

    const stepMap = new Map<string, StepWithJobsAndApprovals>();
    for (const step of steps) {
      stepMap.set(step.key, step);
    }

    // 3. Reconcile finished / failed / blocked step Jobs
    for (const step of steps) {
      if (step.jobs && step.jobs.length > 0) {
        const job = step.jobs[0];

        if (job.status === JobStatus.SUCCEEDED) {
          const jobPayload = (job.payload as any) ?? {};
          const savedResult = jobPayload.result;
          const stepOutput =
            savedResult && typeof savedResult === 'object' && 'output' in savedResult
              ? savedResult.output
              : savedResult;

          if (
            step.status !== WorkflowStepStatus.SUCCEEDED ||
            (step.output === null && stepOutput !== undefined)
          ) {
            await this.prisma.workflowStep.update({
              where: { id: step.id },
              data: {
                status: WorkflowStepStatus.SUCCEEDED,
                output: (stepOutput as Prisma.InputJsonValue) ?? (step.output as Prisma.InputJsonValue),
                completedAt: job.completedAt ?? new Date(),
              },
            });
            step.status = WorkflowStepStatus.SUCCEEDED;
            if (stepOutput !== undefined && stepOutput !== null) {
              step.output = stepOutput as any;
            }
          }
        } else if (
          (job.status === JobStatus.FAILED || job.status === JobStatus.DEAD_LETTERED) &&
          step.status !== WorkflowStepStatus.FAILED
        ) {
          // Rule 25: Reconcile linked WorkflowStep to FAILED
          await this.prisma.workflowStep.update({
            where: { id: step.id },
            data: {
              status: WorkflowStepStatus.FAILED,
              completedAt: new Date(),
            },
          });
          step.status = WorkflowStepStatus.FAILED;
        } else if (job.status === JobStatus.BLOCKED && step.status !== WorkflowStepStatus.BLOCKED) {
          // Rule 26: Reconcile linked WorkflowStep to BLOCKED
          await this.prisma.workflowStep.update({
            where: { id: step.id },
            data: {
              status: WorkflowStepStatus.BLOCKED,
            },
          });
          step.status = WorkflowStepStatus.BLOCKED;
        } else if (job.status === JobStatus.RETRY_WAITING && step.status !== WorkflowStepStatus.RUNNING) {
          // Rule 24: Step remains RUNNING during retries
          await this.prisma.workflowStep.update({
            where: { id: step.id },
            data: {
              status: WorkflowStepStatus.RUNNING,
            },
          });
          step.status = WorkflowStepStatus.RUNNING;
        }
      }

      // Reconcile WAITING approval steps
      if (step.status === WorkflowStepStatus.WAITING && step.approvals && step.approvals.length > 0) {
        const approval = step.approvals[0];
        if (approval.status === ApprovalStatus.APPROVED) {
          await this.prisma.workflowStep.update({
            where: { id: step.id },
            data: {
              status: WorkflowStepStatus.SUCCEEDED,
              completedAt: approval.decidedAt ?? new Date(),
            },
          });
          step.status = WorkflowStepStatus.SUCCEEDED;
          if (workflow.status === WorkflowStatus.WAITING) {
            await this.prisma.workflow.update({
              where: { id: workflow.id },
              data: {
                status: WorkflowStatus.RUNNING,
              },
            });
            workflow.status = WorkflowStatus.RUNNING;
          }
        } else if (approval.status === ApprovalStatus.REJECTED) {
          await this.prisma.workflowStep.update({
            where: { id: step.id },
            data: {
              status: WorkflowStepStatus.BLOCKED,
              completedAt: approval.decidedAt ?? new Date(),
            },
          });
          step.status = WorkflowStepStatus.BLOCKED;
          await this.prisma.workflow.update({
            where: { id: workflow.id },
            data: {
              status: WorkflowStatus.BLOCKED,
            },
          });
          workflow.status = WorkflowStatus.BLOCKED;
          result.blockedWorkflows++;
          return;
        }
      }
    }

    // 4. Check for workflow-level terminal states (Failure or Blocked propagation)
    const hasFailedStep = steps.some((s) => s.status === WorkflowStepStatus.FAILED);
    if (hasFailedStep) {
      // Rule 31: Workflow -> FAILED
      await this.prisma.workflow.update({
        where: { id: workflow.id },
        data: {
          status: WorkflowStatus.FAILED,
          completedAt: new Date(),
        },
      });
      result.failedWorkflows++;
      return;
    }

    const hasBlockedStep = steps.some((s) => s.status === WorkflowStepStatus.BLOCKED);
    if (hasBlockedStep) {
      // Rule 31: Workflow -> BLOCKED
      await this.prisma.workflow.update({
        where: { id: workflow.id },
        data: {
          status: WorkflowStatus.BLOCKED,
        },
      });
      result.blockedWorkflows++;
      return;
    }

    // 5. Gather step outputs for condition evaluation
    const stepOutputs: Record<string, unknown> = {};
    for (const step of steps) {
      if (step.output !== null && step.output !== undefined) {
        stepOutputs[step.key] = step.output;
      }
    }

    // 6. Evaluate DAG dependencies and safe conditions for PENDING steps
    let newlyActivated = false;

    for (const stepDef of template.steps) {
      const stepRow = stepMap.get(stepDef.key);
      if (!stepRow) continue;

      // Handle repairing orphaned READY steps (READY in DB but Job was never inserted)
      if (
        stepRow.status === WorkflowStepStatus.READY &&
        stepDef.type !== 'APPROVAL' &&
        (!stepRow.jobs || stepRow.jobs.length === 0)
      ) {
        await this.createJobForReadyStep(workflow, stepRow, stepDef as any);
        result.createdJobs++;
        continue;
      }

      if (stepRow.status !== WorkflowStepStatus.PENDING) {
        continue;
      }

      // Check if all upstream dependencies are satisfied
      // Section 8 Dependency Safety: Upstream step is satisfied ONLY when:
      // - It is SKIPPED
      // OR
      // - WorkflowStep.status === SUCCEEDED AND its logical Job.status === SUCCEEDED
      const deps = stepDef.dependsOn ?? [];
      let allDepsSatisfied = true;

      for (const depKey of deps) {
        const depRow = stepMap.get(depKey);
        if (!depRow) {
          allDepsSatisfied = false;
          break;
        }

        if (depRow.status === WorkflowStepStatus.SKIPPED) {
          continue;
        }

        if (depRow.status === WorkflowStepStatus.SUCCEEDED) {
          const depJob = depRow.jobs && depRow.jobs.length > 0 ? depRow.jobs[0] : null;
          if (depJob && depJob.status !== JobStatus.SUCCEEDED) {
            allDepsSatisfied = false;
            break;
          }
          continue;
        }

        allDepsSatisfied = false;
        break;
      }

      if (!allDepsSatisfied) {
        continue;
      }

      // Evaluate safe declarative condition
      const conditionSatisfied = evaluateCondition(stepDef.condition, stepOutputs);
      if (!conditionSatisfied) {
        // Condition false: step becomes SKIPPED without creating a Job
        await this.prisma.workflowStep.update({
          where: { id: stepRow.id },
          data: {
            status: WorkflowStepStatus.SKIPPED,
            completedAt: new Date(),
          },
        });
        stepRow.status = WorkflowStepStatus.SKIPPED;
        result.skippedSteps++;
        newlyActivated = true;
        continue;
      }

      if (stepDef.type === 'APPROVAL') {
        // Pauses step in WAITING and creates Approval record idempotently (0 jobs created)
        await this.pauseStepForApproval(workflow, stepRow, stepDef, stepOutputs);
        stepRow.status = WorkflowStepStatus.WAITING;
        workflow.status = WorkflowStatus.WAITING;
        newlyActivated = true;
        continue;
      }

      // Condition satisfied: Step transitions PENDING -> READY and Job is created atomically
      await this.readyStepAndCreateJob(workflow, stepRow, stepDef as any);
      stepRow.status = WorkflowStepStatus.READY;
      result.readiedSteps++;
      result.createdJobs++;
      newlyActivated = true;
    }

    // 7. Workflow status derivation
    // Section 9 Completion Safety:
    // Workflow cannot become SUCCEEDED if any step is not (SUCCEEDED or SKIPPED),
    // OR if any executable step's Job is NOT SUCCEEDED.
    const allTerminalSuccess = steps.length > 0 && steps.every((s) => {
      if (s.status === WorkflowStepStatus.SKIPPED) return true;
      if (s.status === WorkflowStepStatus.SUCCEEDED) {
        const stepJob = s.jobs && s.jobs.length > 0 ? s.jobs[0] : null;
        if (stepJob && stepJob.status !== JobStatus.SUCCEEDED) {
          return false;
        }
        return true;
      }
      return false;
    });

    if (allTerminalSuccess) {
      // Rule 30: All steps SUCCEEDED or SKIPPED -> Workflow SUCCEEDED
      await this.prisma.workflow.update({
        where: { id: workflow.id },
        data: {
          status: WorkflowStatus.SUCCEEDED,
          completedAt: new Date(),
        },
      });
      result.completedWorkflows++;
    } else if (workflow.status === WorkflowStatus.PENDING && newlyActivated) {
      // Rule 29: First step activation -> Workflow PENDING to RUNNING with startedAt set once
      await this.prisma.workflow.update({
        where: { id: workflow.id },
        data: {
          status: WorkflowStatus.RUNNING,
          startedAt: workflow.startedAt ?? new Date(),
        },
      });
      workflow.status = WorkflowStatus.RUNNING;
    }
  }

  /**
   * Atomically transitions WorkflowStep from PENDING to READY and creates durable Job.
   * Uses ON CONFLICT (organization_id, idempotency_key) DO NOTHING for multi-coordinator race safety.
   */
  private async readyStepAndCreateJob(
    workflow: Workflow,
    step: WorkflowStep,
    stepDef: { key: string; handlerKey: string; priority?: number; maxAttempts?: number },
  ): Promise<void> {
    const idempotencyKey = `workflow-step:${workflow.id}:${step.key}:v${workflow.templateVersion}`;
    const payload = {
      templateKey: workflow.templateKey,
      templateVersion: workflow.templateVersion,
      stepKey: step.key,
      handlerKey: stepDef.handlerKey,
    };

    await this.prisma.$transaction(async (tx) => {
      // 1. Mark step READY
      await tx.workflowStep.update({
        where: { id: step.id },
        data: { status: WorkflowStepStatus.READY },
      });

      // 2. Insert durable Job idempotently
      await tx.$executeRaw`
        INSERT INTO jobs (
          id,
          organization_id,
          workflow_id,
          workflow_step_id,
          type,
          status,
          priority,
          payload,
          attempt_count,
          max_attempts,
          next_run_at,
          idempotency_key,
          created_at,
          updated_at
        )
        VALUES (
          gen_random_uuid(),
          ${workflow.organizationId}::uuid,
          ${workflow.id}::uuid,
          ${step.id}::uuid,
          'WORKFLOW_STEP',
          'QUEUED'::"JobStatus",
          ${stepDef.priority ?? 0},
          ${JSON.stringify(payload)}::jsonb,
          0,
          ${stepDef.maxAttempts ?? 3},
          NOW(),
          ${idempotencyKey},
          NOW(),
          NOW()
        )
        ON CONFLICT (organization_id, idempotency_key) DO NOTHING
      `;
    });
  }

  /**
   * Repairs an orphaned READY step missing a durable Job.
   */
  private async createJobForReadyStep(
    workflow: Workflow,
    step: WorkflowStep,
    stepDef: { key: string; handlerKey: string; priority?: number; maxAttempts?: number },
  ): Promise<void> {
    const idempotencyKey = `workflow-step:${workflow.id}:${step.key}:v${workflow.templateVersion}`;
    const payload = {
      templateKey: workflow.templateKey,
      templateVersion: workflow.templateVersion,
      stepKey: step.key,
      handlerKey: stepDef.handlerKey,
    };

    await this.prisma.$executeRaw`
      INSERT INTO jobs (
        id,
        organization_id,
        workflow_id,
        workflow_step_id,
        type,
        status,
        priority,
        payload,
        attempt_count,
        max_attempts,
        next_run_at,
        idempotency_key,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        ${workflow.organizationId}::uuid,
        ${workflow.id}::uuid,
        ${step.id}::uuid,
        'WORKFLOW_STEP',
        'QUEUED'::"JobStatus",
        ${stepDef.priority ?? 0},
        ${JSON.stringify(payload)}::jsonb,
        0,
        ${stepDef.maxAttempts ?? 3},
        NOW(),
        ${idempotencyKey},
        NOW(),
        NOW()
      )
      ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    `;
  }

  /**
   * Atomically pauses WorkflowStep in WAITING and creates durable Approval record.
   * Creates ZERO jobs. Uses ON CONFLICT (workflow_step_id) DO NOTHING for multi-coordinator race safety.
   */
  private async pauseStepForApproval(
    workflow: Workflow,
    step: WorkflowStep,
    stepDef: { key: string; preview?: any },
    stepOutputs?: Record<string, unknown>,
  ): Promise<void> {
    // Dynamic preview from upstream CHECK output if available (Requirement 23)
    let dynamicPreview = stepDef.preview;
    if (stepOutputs) {
      for (const outputVal of Object.values(stepOutputs)) {
        if (outputVal && typeof outputVal === 'object' && 'preview' in outputVal) {
          dynamicPreview = (outputVal as any).preview;
          break;
        }
      }
    }
    const previewJson = dynamicPreview ? JSON.stringify(dynamicPreview) : null;

    await this.prisma.$transaction(async (tx) => {
      // 1. Insert Approval row idempotently
      await tx.$executeRaw`
        INSERT INTO approvals (
          id,
          organization_id,
          recovery_case_id,
          workflow_id,
          workflow_step_id,
          status,
          preview_snapshot,
          requested_at,
          created_at,
          updated_at
        )
        VALUES (
          gen_random_uuid(),
          ${workflow.organizationId}::uuid,
          ${workflow.recoveryCaseId}::uuid,
          ${workflow.id}::uuid,
          ${step.id}::uuid,
          'PENDING'::"ApprovalStatus",
          ${previewJson}::jsonb,
          NOW(),
          NOW(),
          NOW()
        )
        ON CONFLICT (workflow_step_id) DO NOTHING
      `;

      // 2. Mark WorkflowStep as WAITING
      await tx.workflowStep.update({
        where: { id: step.id },
        data: { status: WorkflowStepStatus.WAITING },
      });

      // 3. Mark Workflow as WAITING
      await tx.workflow.update({
        where: { id: workflow.id },
        data: {
          status: WorkflowStatus.WAITING,
          startedAt: workflow.startedAt ?? new Date(),
        },
      });
    });
  }
}
