import { PrismaClient, WorkflowStatus, WorkflowStepStatus } from '@prisma/client';
import { JobContext } from './executor';
import { WorkflowStepHandlerRegistry, WorkflowStepContext } from './workflow-step-registry';

export interface WorkflowStepPayload {
  templateKey?: string;
  templateVersion?: number;
  stepKey?: string;
  handlerKey?: string;
  [key: string]: unknown;
}

export class WorkflowStepExecutor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly handlerRegistry: WorkflowStepHandlerRegistry,
  ) {}

  async execute(context: JobContext): Promise<unknown> {
    const { jobId, workflowId, workflowStepId, organizationId, attemptNumber, workerId } = context;

    if (!workflowId || !workflowStepId) {
      throw new Error(
        `Job ${jobId} is of type WORKFLOW_STEP but lacks authoritative workflowId or workflowStepId relation.`,
      );
    }

    // 1. Tenant Safety: Verify Workflow belongs to organizationId
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
    });

    if (!workflow || workflow.organizationId !== organizationId) {
      throw new Error(
        `Tenant mismatch: Workflow ${workflowId} does not belong to organization ${organizationId}`,
      );
    }

    // 2. Tenant Safety: Verify WorkflowStep belongs to organizationId and workflowId
    const step = await this.prisma.workflowStep.findUnique({
      where: { id: workflowStepId },
    });

    if (!step || step.organizationId !== organizationId || step.workflowId !== workflowId) {
      throw new Error(
        `Tenant mismatch: WorkflowStep ${workflowStepId} does not belong to workflow ${workflowId} in org ${organizationId}`,
      );
    }

    // 3. Rule 32: Terminal Workflow Execution Fence
    // If Workflow is already terminal (FAILED, BLOCKED, CANCELLED, SUCCEEDED), do not execute step
    const terminalStatuses: WorkflowStatus[] = [
      WorkflowStatus.FAILED,
      WorkflowStatus.BLOCKED,
      WorkflowStatus.CANCELLED,
      WorkflowStatus.SUCCEEDED,
    ];

    if (terminalStatuses.includes(workflow.status)) {
      console.warn(
        `[Reloop WorkflowStepExecutor] Workflow ${workflowId} is in terminal state "${workflow.status}". Fencing execution of step ${step.key} (Job ${jobId}).`,
      );
      return {
        fenced: true,
        workflowStatus: workflow.status,
        stepKey: step.key,
      };
    }

    // 4. Rule 21: Step Start Fence
    // Only READY or RUNNING may execute. Reject forbidden states.
    const forbiddenStatuses: WorkflowStepStatus[] = [
      WorkflowStepStatus.PENDING,
      WorkflowStepStatus.SKIPPED,
      WorkflowStepStatus.SUCCEEDED,
      WorkflowStepStatus.FAILED,
      WorkflowStepStatus.BLOCKED,
    ];

    if (forbiddenStatuses.includes(step.status)) {
      throw new Error(
        `Step execution fenced: WorkflowStep ${step.id} (${step.key}) has invalid status "${step.status}". Expected READY or RUNNING.`,
      );
    }

    if (step.status === WorkflowStepStatus.READY) {
      const updated = await this.prisma.$executeRaw`
        UPDATE workflow_steps
        SET
          status = 'RUNNING'::"WorkflowStepStatus",
          started_at = COALESCE(started_at, NOW()),
          updated_at = NOW()
        WHERE
          id = ${step.id}::uuid
          AND status = 'READY'::"WorkflowStepStatus"
      `;

      if (updated === 0) {
        // CAS failed: check if another worker already transitioned it to RUNNING
        const current = await this.prisma.workflowStep.findUnique({
          where: { id: step.id },
        });
        if (!current || current.status !== WorkflowStepStatus.RUNNING) {
          throw new Error(
            `Step start fence CAS failed: WorkflowStep ${step.id} could not transition READY -> RUNNING (current status: ${current?.status})`,
          );
        }
      }
    }

    // 5. Parse payload and resolve handler
    const payload = (context.payload ?? {}) as WorkflowStepPayload;
    const handlerKey = payload.handlerKey ?? 'OUTPUT';
    const templateKey = payload.templateKey ?? workflow.templateKey;
    const templateVersion = payload.templateVersion ?? workflow.templateVersion;

    const stepContext: WorkflowStepContext = {
      workflowId,
      workflowStepId,
      stepKey: step.key,
      templateKey,
      templateVersion,
      attemptNumber,
      payload: context.payload,
      organizationId,
      workerId,
    };

    // 6. Execute step handler
    // Authoritative durable execution: Do NOT mark WorkflowStep SUCCEEDED or FAILED here.
    // The worker's job lease must first durably commit the Job completion in PostgreSQL.
    // WorkerService updates WorkflowStep upon successful Job commit;
    // WorkflowCoordinator reconciles any crash between Job commit and Step update.
    const result = await this.handlerRegistry.execute(handlerKey, stepContext);
    return result;
  }
}
