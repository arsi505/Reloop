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
  RecoveryCaseStatus,
} from '@prisma/client';
import { WorkflowTemplateRegistry, evaluateCondition } from '@reloop/workflow-core';
import { SchedulerConfig } from './config';
import { CaseResolutionService } from './case-resolution/case-resolution.service';
import { isDeepStrictEqual } from 'node:util';

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
  private caseResolutionService: CaseResolutionService;
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
    caseResolutionService?: CaseResolutionService,
  ) {
    this.prisma = prisma;
    this.templateRegistry = templateRegistry;
    this.scanIntervalMs = config.workflowScanIntervalMs ?? 1000;
    this.scanBatchSize = config.workflowScanBatchSize ?? 20;
    this.caseResolutionService = caseResolutionService ?? new CaseResolutionService(prisma);
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

    const stepDefMap = new Map<string, (typeof template.steps)[0]>();
    for (const sd of template.steps) {
      stepDefMap.set(sd.key, sd);
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
        const approvalGraphMatches =
          workflow.recoveryCaseId !== null &&
          approval.organizationId === workflow.organizationId &&
          approval.workflowId === workflow.id &&
          approval.workflowStepId === step.id &&
          approval.recoveryCaseId === workflow.recoveryCaseId;
        if (!approvalGraphMatches) {
          await this.prisma.$transaction(async (tx) => {
            await tx.workflowStep.update({
              where: { id: step.id },
              data: {
                status: WorkflowStepStatus.BLOCKED,
                output: {
                  code: 'INVALID_APPROVAL_GRAPH',
                  message: 'Approval does not belong to this workflow, step, tenant, and recovery case',
                },
                completedAt: new Date(),
              },
            });
            await tx.workflow.update({
              where: { id: workflow.id },
              data: { status: WorkflowStatus.BLOCKED, completedAt: new Date() },
            });
            if (workflow.recoveryCaseId) {
              const caseResult = await tx.recoveryCase.updateMany({
                where: {
                  id: workflow.recoveryCaseId,
                  organizationId: workflow.organizationId,
                  status: RecoveryCaseStatus.WAITING_APPROVAL,
                },
                data: { status: RecoveryCaseStatus.BLOCKED },
              });
              if (caseResult.count !== 1) {
                throw new Error('Recovery case is not waiting for this approval graph');
              }
            }
          });
          step.status = WorkflowStepStatus.BLOCKED;
          workflow.status = WorkflowStatus.BLOCKED;
          result.blockedWorkflows++;
          return;
        }
        if (approval.status === ApprovalStatus.APPROVED) {
          const stepDef = stepDefMap.get(step.key);
          const parentDepKey = stepDef?.dependsOn && stepDef.dependsOn.length > 0 ? stepDef.dependsOn[0] : null;
          const parentRow = parentDepKey ? stepMap.get(parentDepKey) : null;
          const parentOutput =
            parentRow && parentRow.output !== null && typeof parentRow.output === 'object' && !Array.isArray(parentRow.output)
              ? (parentRow.output as Record<string, unknown>)
              : null;
          const snapshot =
            approval.previewSnapshot !== null &&
            typeof approval.previewSnapshot === 'object' &&
            !Array.isArray(approval.previewSnapshot)
              ? (approval.previewSnapshot as Record<string, unknown>)
              : null;
          const reviewedContext = snapshot?.verifiedContext;

          if (
            parentRow?.status !== WorkflowStepStatus.SUCCEEDED ||
            !parentOutput ||
            reviewedContext === null ||
            typeof reviewedContext !== 'object' ||
            Array.isArray(reviewedContext) ||
            !isDeepStrictEqual(reviewedContext, parentOutput)
          ) {
            await this.prisma.$transaction(async (tx) => {
              await tx.workflowStep.update({
                where: { id: step.id },
                data: {
                  status: WorkflowStepStatus.BLOCKED,
                  output: {
                    code: 'INVALID_APPROVAL_CONTEXT',
                    message: 'Approved context is missing, stale, or does not match verified CHECK output',
                  },
                  completedAt: approval.decidedAt ?? new Date(),
                },
              });
              await tx.workflow.update({
                where: { id: workflow.id },
                data: { status: WorkflowStatus.BLOCKED, completedAt: new Date() },
              });
              const caseResult = await tx.recoveryCase.updateMany({
                where: {
                  id: workflow.recoveryCaseId!,
                  organizationId: workflow.organizationId,
                  status: RecoveryCaseStatus.WAITING_APPROVAL,
                },
                data: { status: RecoveryCaseStatus.BLOCKED },
              });
              if (caseResult.count !== 1) {
                throw new Error('Recovery case is not waiting for this approval graph');
              }
            });
            step.status = WorkflowStepStatus.BLOCKED;
            workflow.status = WorkflowStatus.BLOCKED;
            result.blockedWorkflows++;
            return;
          }

          const approvalOutput = {
            ...(reviewedContext as Record<string, unknown>),
            approved: true,
            approvalId: approval.id,
            decidedAt: approval.decidedAt ?? new Date(),
          };

          await this.prisma.$transaction(async (tx) => {
            await tx.workflowStep.update({
              where: { id: step.id },
              data: {
                status: WorkflowStepStatus.SUCCEEDED,
                output: approvalOutput as Prisma.InputJsonValue,
                completedAt: approval.decidedAt ?? new Date(),
              },
            });
            await tx.workflow.update({
              where: { id: workflow.id },
              data: { status: WorkflowStatus.RUNNING },
            });
            const caseResult = await tx.recoveryCase.updateMany({
              where: {
                id: workflow.recoveryCaseId!,
                organizationId: workflow.organizationId,
                status: RecoveryCaseStatus.WAITING_APPROVAL,
              },
              data: { status: RecoveryCaseStatus.RECOVERING },
            });
            if (caseResult.count !== 1) {
              throw new Error('Recovery case is not waiting for this approval graph');
            }
          });
          step.status = WorkflowStepStatus.SUCCEEDED;
          step.output = approvalOutput as any;
          workflow.status = WorkflowStatus.RUNNING;
        } else if (approval.status === ApprovalStatus.REJECTED) {
          await this.prisma.$transaction(async (tx) => {
            await tx.workflowStep.update({
              where: { id: step.id },
              data: {
                status: WorkflowStepStatus.BLOCKED,
                completedAt: approval.decidedAt ?? new Date(),
              },
            });
            await tx.workflow.update({
              where: { id: workflow.id },
              data: { status: WorkflowStatus.BLOCKED, completedAt: new Date() },
            });
            if (workflow.recoveryCaseId) {
              const caseResult = await tx.recoveryCase.updateMany({
                where: {
                  id: workflow.recoveryCaseId,
                  organizationId: workflow.organizationId,
                  status: RecoveryCaseStatus.WAITING_APPROVAL,
                },
                data: { status: RecoveryCaseStatus.BLOCKED },
              });
              if (caseResult.count !== 1) {
                throw new Error('Recovery case is not waiting for this approval graph');
              }
            }
          });
          step.status = WorkflowStepStatus.BLOCKED;
          workflow.status = WorkflowStatus.BLOCKED;
          result.blockedWorkflows++;
          return;
        } else if (
          approval.status === ApprovalStatus.EXPIRED ||
          (approval.status === ApprovalStatus.PENDING &&
            approval.expiresAt !== null &&
            approval.expiresAt <= new Date())
        ) {
          await this.prisma.$transaction(async (tx) => {
            if (approval.status === ApprovalStatus.PENDING) {
              await tx.approval.updateMany({
                where: { id: approval.id, status: ApprovalStatus.PENDING },
                data: { status: ApprovalStatus.EXPIRED },
              });
            }
            await tx.workflowStep.update({
              where: { id: step.id },
              data: { status: WorkflowStepStatus.BLOCKED, completedAt: new Date() },
            });
            await tx.workflow.update({
              where: { id: workflow.id },
              data: { status: WorkflowStatus.BLOCKED, completedAt: new Date() },
            });
            if (workflow.recoveryCaseId) {
              const caseResult = await tx.recoveryCase.updateMany({
                where: {
                  id: workflow.recoveryCaseId,
                  organizationId: workflow.organizationId,
                  status: RecoveryCaseStatus.WAITING_APPROVAL,
                },
                data: { status: RecoveryCaseStatus.BLOCKED },
              });
              if (caseResult.count !== 1) {
                throw new Error('Recovery case is not waiting for this approval graph');
              }
            }
          });
          step.status = WorkflowStepStatus.BLOCKED;
          workflow.status = WorkflowStatus.BLOCKED;
          result.blockedWorkflows++;
          return;
        }
      }
    }

    // Scheduler-side case resolution guard: if VERIFY step is SUCCEEDED, resolve linked RecoveryCase
    if (workflow.recoveryCaseId) {
      const verifyStep = steps.find((s) => s.key === 'VERIFY');
      if (
        verifyStep &&
        verifyStep.status === WorkflowStepStatus.SUCCEEDED &&
        verifyStep.output !== null &&
        typeof verifyStep.output === 'object'
      ) {
        const vOut = verifyStep.output as any;
        if (vOut.verified === true && vOut.invariantPassed) {
          try {
            await this.caseResolutionService.resolveCase({
              caseId: workflow.recoveryCaseId,
              organizationId: workflow.organizationId,
              workflowId: workflow.id,
              verifyStepKey: verifyStep.key,
              verificationOutput: vOut,
            });
          } catch (resErr: any) {
            console.warn(
              `[Reloop WorkflowCoordinator] Case resolution skipped for case ${workflow.recoveryCaseId}:`,
              resErr?.message || resErr,
            );
          }
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
        await this.createJobForReadyStep(workflow, stepRow, stepDef as any, stepMap);
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
      try {
        await this.readyStepAndCreateJob(workflow, stepRow, stepDef as any, stepMap);
        stepRow.status = WorkflowStepStatus.READY;
        result.readiedSteps++;
        result.createdJobs++;
        newlyActivated = true;
      } catch (stepErr: any) {
        if (stepErr.message && stepErr.message.includes('Ambiguous upstream output key')) {
          console.error(
            `[Reloop WorkflowCoordinator] Ambiguity error in step ${stepRow.key} for workflow ${workflow.id}:`,
            stepErr,
          );
          await this.prisma.workflowStep.update({
            where: { id: stepRow.id },
            data: {
              status: WorkflowStepStatus.FAILED,
              output: {
                code: 'AMBIGUOUS_DEPENDENCY_OUTPUTS',
                message: stepErr.message,
              },
              completedAt: new Date(),
            },
          });
          stepRow.status = WorkflowStepStatus.FAILED;
          stepRow.output = {
            code: 'AMBIGUOUS_DEPENDENCY_OUTPUTS',
            message: stepErr.message,
          } as any;
          await this.prisma.workflow.update({
            where: { id: workflow.id },
            data: { status: WorkflowStatus.FAILED, completedAt: new Date() },
          });
          result.failedWorkflows++;
          return;
        }
        throw stepErr;
      }
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

      if (workflow.recoveryCaseId) {
        const verifyStep = steps.find((s) => s.key === 'VERIFY');
        if (
          verifyStep &&
          verifyStep.status === WorkflowStepStatus.SUCCEEDED &&
          verifyStep.output !== null &&
          typeof verifyStep.output === 'object'
        ) {
          const vOut = verifyStep.output as any;
          if (vOut.verified === true && vOut.invariantPassed) {
            try {
              await this.caseResolutionService.resolveCase({
                caseId: workflow.recoveryCaseId,
                organizationId: workflow.organizationId,
                workflowId: workflow.id,
                verifyStepKey: verifyStep.key,
                verificationOutput: vOut,
              });
            } catch (resErr: any) {
              console.warn(
                `[Reloop WorkflowCoordinator] Case resolution skipped for case ${workflow.recoveryCaseId}:`,
                resErr?.message || resErr,
              );
            }
          }
        }
      }
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
   * Deterministically builds step job payload:
   * 1. Base immutable context from step.input
   * 2. Merged output from only declared completed dependencies (detecting ambiguity)
   * 3. Authoritative system metadata (cannot be overridden)
   */
  private buildStepJobPayload(
    workflow: Workflow,
    step: WorkflowStep,
    stepDef: { key: string; handlerKey: string; dependsOn?: string[] },
    stepMap: Map<string, StepWithJobsAndApprovals>,
  ): Record<string, unknown> {
    const baseInput =
      step.input !== null && typeof step.input === 'object' && !Array.isArray(step.input)
        ? (step.input as Record<string, unknown>)
        : {};

    const mergedDependencyOutputs: Record<string, unknown> = {};
    const seenKeys = new Map<string, string>();

    for (const depKey of stepDef.dependsOn ?? []) {
      const depRow = stepMap.get(depKey);
      if (
        depRow &&
        depRow.output !== null &&
        typeof depRow.output === 'object' &&
        !Array.isArray(depRow.output)
      ) {
        const depOutputObj = depRow.output as Record<string, unknown>;
        for (const [k, v] of Object.entries(depOutputObj)) {
          if (seenKeys.has(k) && seenKeys.get(k) !== depKey) {
            const previousVal = mergedDependencyOutputs[k];
            if (JSON.stringify(previousVal) !== JSON.stringify(v)) {
              throw new Error(
                `Ambiguous upstream output key "${k}" with conflicting values provided by dependencies "${seenKeys.get(k)}" and "${depKey}" for step "${step.key}".`,
              );
            }
          }
          seenKeys.set(k, depKey);
          mergedDependencyOutputs[k] = v;
        }
      }
    }

    return {
      ...baseInput,
      ...mergedDependencyOutputs,
      templateKey: workflow.templateKey,
      templateVersion: workflow.templateVersion,
      stepKey: step.key,
      handlerKey: stepDef.handlerKey,
      workflowId: workflow.id,
      workflowStepId: step.id,
      organizationId: workflow.organizationId,
    };
  }

  /**
   * Atomically transitions WorkflowStep from PENDING to READY and creates durable Job.
   * Uses ON CONFLICT (organization_id, idempotency_key) DO NOTHING for multi-coordinator race safety.
   */
  private async readyStepAndCreateJob(
    workflow: Workflow,
    step: WorkflowStep,
    stepDef: { key: string; handlerKey: string; priority?: number; maxAttempts?: number; dependsOn?: string[] },
    stepMap: Map<string, StepWithJobsAndApprovals>,
  ): Promise<void> {
    const idempotencyKey = `workflow-step:${workflow.id}:${step.key}:v${workflow.templateVersion}`;
    const payload = this.buildStepJobPayload(workflow, step, stepDef, stepMap);

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
    stepDef: { key: string; handlerKey: string; priority?: number; maxAttempts?: number; dependsOn?: string[] },
    stepMap: Map<string, StepWithJobsAndApprovals>,
  ): Promise<void> {
    const idempotencyKey = `workflow-step:${workflow.id}:${step.key}:v${workflow.templateVersion}`;
    const payload = this.buildStepJobPayload(workflow, step, stepDef, stepMap);

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
    stepDef: { key: string; preview?: any; dependsOn?: string[] },
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
    const dependencyKeys = stepDef.dependsOn ?? [];
    if (dependencyKeys.length !== 1) {
      throw new Error(
        `Approval step ${step.key} must have exactly one verified dependency`,
      );
    }
    const verifiedContext = stepOutputs?.[dependencyKeys[0]];
    if (
      verifiedContext === null ||
      typeof verifiedContext !== 'object' ||
      Array.isArray(verifiedContext)
    ) {
      throw new Error(
        `Approval step ${step.key} is missing verified dependency output`,
      );
    }
    const previewRecord =
      dynamicPreview !== null &&
      typeof dynamicPreview === 'object' &&
      !Array.isArray(dynamicPreview)
        ? dynamicPreview
        : dynamicPreview === undefined
          ? {}
          : { preview: dynamicPreview };
    const previewJson = JSON.stringify({
      ...previewRecord,
      verifiedContext,
    });

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
