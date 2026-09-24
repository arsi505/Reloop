import {
  PrismaClient,
  Prisma,
  Workflow,
  WorkflowStep,
  WorkflowStatus,
  WorkflowStepStatus,
} from '@prisma/client';
import { WorkflowTemplateRegistry } from '@reloop/workflow-core';
import { randomUUID } from 'crypto';

export interface CreateWorkflowParams {
  organizationId: string;
  templateKey: string;
  templateVersion: number;
  recoveryCaseId: string;
  workflowId?: string;
  input?: Record<string, unknown>;
}

export type WorkflowWithSteps = Workflow & { steps: WorkflowStep[] };

export class WorkflowCreationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly templateRegistry: WorkflowTemplateRegistry,
  ) {}

  /**
   * Idempotently and transactionally creates a Workflow instance along with all its WorkflowStep rows.
   * Both Workflow and WorkflowSteps initialize in the PENDING status.
   * If caller supplies a stable workflowId, an existing workflow with that ID is returned safely.
   */
  async createWorkflowInstance(params: CreateWorkflowParams): Promise<WorkflowWithSteps> {
    const { organizationId, templateKey, templateVersion, workflowId, input, recoveryCaseId } = params;

    // 1. recoveryCaseId is strictly required
    if (!recoveryCaseId || typeof recoveryCaseId !== 'string') {
      throw new Error('recoveryCaseId is required to create a workflow.');
    }

    // 2. Idempotency check on caller-supplied workflowId
    if (workflowId) {
      const existing = await this.prisma.workflow.findUnique({
        where: { id: workflowId },
        include: { steps: { orderBy: { position: 'asc' } } },
      });

      if (existing) {
        if (existing.organizationId !== organizationId) {
          throw new Error(
            `Tenant mismatch: workflow ${workflowId} belongs to org ${existing.organizationId}, not requested org ${organizationId}`,
          );
        }
        if (
          existing.recoveryCaseId !== recoveryCaseId ||
          existing.templateKey !== templateKey ||
          existing.templateVersion !== templateVersion
        ) {
          throw new Error(
            `Conflict: workflow ${workflowId} already exists with different parameters`,
          );
        }
        return existing;
      }
    }

    // 3. Verify RecoveryCase exists and belongs to the same organization
    const recoveryCase = await this.prisma.recoveryCase.findUnique({
      where: { id: recoveryCaseId },
    });
    if (!recoveryCase) {
      throw new Error(`RecoveryCase "${recoveryCaseId}" does not exist.`);
    }
    if (recoveryCase.organizationId !== organizationId) {
      throw new Error(
        `Tenant mismatch: RecoveryCase "${recoveryCaseId}" belongs to org "${recoveryCase.organizationId}", not requested org "${organizationId}".`,
      );
    }

    // 4. Validate template exists in registry
    const template = this.templateRegistry.get(templateKey, templateVersion);
    if (!template) {
      throw new Error(
        `Cannot create workflow: Template "${templateKey}" version ${templateVersion} is not registered.`,
      );
    }

    const assignedWorkflowId = workflowId ?? randomUUID();

    // 5. Transactional creation of Workflow + all WorkflowStep rows
    try {
      return await this.prisma.$transaction(async (tx) => {
        const workflow = await tx.workflow.create({
          data: {
            id: assignedWorkflowId,
            organizationId,
            recoveryCaseId,
            templateKey,
            templateVersion,
            status: WorkflowStatus.PENDING,
          },
        });

        // Precompute step IDs to wire single-parent dependsOnStepId if applicable
        const stepKeyToId = new Map<string, string>();
        for (const stepDef of template.steps) {
          stepKeyToId.set(stepDef.key, randomUUID());
        }

        const steps: WorkflowStep[] = [];
        for (let i = 0; i < template.steps.length; i++) {
          const stepDef = template.steps[i];
          const stepId = stepKeyToId.get(stepDef.key)!;

          // Wire primary parent if present for schema-level reference
          const primaryParentKey = stepDef.dependsOn && stepDef.dependsOn.length > 0 ? stepDef.dependsOn[0] : null;
          const dependsOnStepId = primaryParentKey ? stepKeyToId.get(primaryParentKey) ?? null : null;

          const step = await tx.workflowStep.create({
            data: {
              id: stepId,
              organizationId,
              workflowId: workflow.id,
              key: stepDef.key,
              name: stepDef.name,
              position: i + 1,
              status: WorkflowStepStatus.PENDING,
              input: input ? (input as Prisma.InputJsonValue) : undefined,
              dependsOnStepId,
            },
          });
          steps.push(step);
        }

        return {
          ...workflow,
          steps,
        };
      });
    } catch (err: any) {
      if (workflowId && (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
        const existing = await this.prisma.workflow.findUnique({
          where: { id: workflowId },
          include: { steps: { orderBy: { position: 'asc' } } },
        });
        if (existing) {
          if (
            existing.organizationId === organizationId &&
            existing.recoveryCaseId === recoveryCaseId &&
            existing.templateKey === templateKey &&
            existing.templateVersion === templateVersion
          ) {
            return existing;
          }
          throw new Error(
            `Conflict: workflow ${workflowId} already exists with different parameters`,
          );
        }
      }
      throw err;
    }
  }
}
