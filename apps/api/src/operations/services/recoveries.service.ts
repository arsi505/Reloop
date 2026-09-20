import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, WorkflowStatus } from '@reloop/database';
import {
  RecoveriesQueryDto,
  RecoveryListItemDto,
  RecoveryDetailDto,
  TimelineEntryDto,
} from '../dto/recoveries.dto';
import { PaginatedResponse } from '../dto/pagination.dto';

@Injectable()
export class RecoveriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lists recovery workflows with associated RecoveryCase metadata.
   */
  async listRecoveries(
    organizationId: string,
    query: RecoveriesQueryDto,
  ): Promise<PaginatedResponse<RecoveryListItemDto>> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
    const skip = (page - 1) * pageSize;
    const sortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc';

    const where: Prisma.WorkflowWhereInput = {
      organizationId,
    };

    if (query.status) {
      where.status = query.status;
    }

    if (query.recoveryLevel) {
      where.recoveryCase = {
        recoveryLevel: query.recoveryLevel,
      };
    }

    if (query.search && query.search.trim().length > 0) {
      const searchTerm = query.search.trim();
      where.OR = [
        { templateKey: { contains: searchTerm, mode: 'insensitive' } },
        { recoveryCase: { summary: { contains: searchTerm, mode: 'insensitive' } } },
      ];
    }

    const [total, records] = await Promise.all([
      this.prisma.workflow.count({ where }),
      this.prisma.workflow.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: sortOrder },
        include: {
          recoveryCase: {
            select: {
              id: true,
              type: true,
              recoveryLevel: true,
              summary: true,
              externalOrder: {
                select: {
                  externalOrderNumber: true,
                },
              },
            },
          },
          approvals: {
            select: {
              status: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
    ]);

    const items: RecoveryListItemDto[] = records.map((w) => ({
      id: w.id,
      recoveryCaseId: w.recoveryCaseId,
      caseType: w.recoveryCase.type,
      recoveryLevel: w.recoveryCase.recoveryLevel,
      caseSummary: w.recoveryCase.summary,
      templateKey: w.templateKey,
      templateVersion: w.templateVersion,
      status: w.status,
      orderNumber: w.recoveryCase.externalOrder?.externalOrderNumber || null,
      approvalStatus: w.approvals[0]?.status || null,
      startedAt: w.startedAt,
      completedAt: w.completedAt,
      createdAt: w.createdAt,
    }));

    const totalPages = Math.ceil(total / pageSize) || 1;

    return {
      items,
      page,
      pageSize,
      total,
      totalPages,
    };
  }

  /**
   * Retrieves flight recorder detail and chronological factual timeline for a recovery workflow.
   * Scoped strictly to the tenant organization (returns 404 for cross-tenant lookups).
   */
  async getRecoveryDetail(organizationId: string, id: string): Promise<RecoveryDetailDto> {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException(`Recovery workflow ${id} not found`);
    }

    const workflow = await this.prisma.workflow.findFirst({
      where: {
        id,
        organizationId,
      },
      include: {
        recoveryCase: {
          include: {
            externalOrder: true,
          },
        },
        steps: {
          orderBy: { position: 'asc' },
        },
        approvals: {
          include: {
            requestedByUser: { select: { id: true, name: true } },
            decidedByUser: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        jobs: {
          include: {
            attempts: {
              orderBy: { attemptNumber: 'asc' },
            },
          },
        },
      },
    });

    if (!workflow) {
      throw new NotFoundException(`Recovery workflow ${id} not found`);
    }

    const latestApproval = workflow.approvals[0] || null;

    // Construct 100% durable factual timeline
    const timeline: TimelineEntryDto[] = [];
    const rc = workflow.recoveryCase;

    // 1. Exception Detected
    timeline.push({
      id: `case-detected-${rc.id}`,
      timestamp: rc.detectedAt,
      eventType: 'CASE_DETECTED',
      description: `Exception ${rc.type} detected by reliability engine: ${rc.summary}`,
      system: 'Reloop Engine',
      status: rc.status,
      actor: { id: 'system', name: 'Reliability Engine' },
      metadata: {
        recoveryLevel: rc.recoveryLevel,
        caseType: rc.type,
      },
    });

    // 2. Workflow Created
    timeline.push({
      id: `wf-created-${workflow.id}`,
      timestamp: workflow.createdAt,
      eventType: 'WORKFLOW_CREATED',
      description: `Workflow plan created for template "${workflow.templateKey}" (v${workflow.templateVersion})`,
      system: 'Workflow Coordinator',
      status: 'INITIALIZED',
      actor: { id: 'system', name: 'Workflow Coordinator' },
      metadata: {
        templateKey: workflow.templateKey,
        templateVersion: workflow.templateVersion,
      },
    });

    // 3. Workflow Started
    if (workflow.startedAt) {
      timeline.push({
        id: `wf-started-${workflow.id}`,
        timestamp: workflow.startedAt,
        eventType: 'WORKFLOW_STARTED',
        description: `Workflow execution started`,
        system: 'Workflow Coordinator',
        status: 'RUNNING',
        actor: { id: 'system', name: 'Workflow Coordinator' },
        metadata: {},
      });
    }

    // 4. Workflow Steps
    for (const step of workflow.steps) {
      if (step.startedAt) {
        timeline.push({
          id: `step-start-${step.id}`,
          timestamp: step.startedAt,
          eventType: 'STEP_STARTED',
          description: `Step "${step.name}" (${step.key}) started`,
          system: 'Reloop Worker',
          status: step.status,
          actor: { id: 'system', name: 'Worker Executor' },
          metadata: {
            stepKey: step.key,
            position: step.position,
          },
        });
      }

      if (step.completedAt) {
        timeline.push({
          id: `step-complete-${step.id}`,
          timestamp: step.completedAt,
          eventType: step.status === 'SUCCEEDED' ? 'STEP_SUCCEEDED' : 'STEP_FAILED',
          description: `Step "${step.name}" (${step.key}) finished with status ${step.status}`,
          system: 'Reloop Worker',
          status: step.status,
          actor: { id: 'system', name: 'Worker Executor' },
          metadata: {
            stepKey: step.key,
          },
        });
      }
    }

    // 5. Approvals
    if (latestApproval) {
      timeline.push({
        id: `app-req-${latestApproval.id}`,
        timestamp: latestApproval.requestedAt,
        eventType: 'APPROVAL_REQUESTED',
        description: `Operator approval requested before executing recovery actions`,
        system: 'Workflow Engine',
        status: 'PENDING',
        actor: latestApproval.requestedByUser
          ? { id: latestApproval.requestedByUser.id, name: latestApproval.requestedByUser.name }
          : { id: 'system', name: 'Workflow Engine' },
        metadata: {},
      });

      if (latestApproval.decidedAt) {
        const isApproved = latestApproval.status === 'APPROVED';
        timeline.push({
          id: `app-dec-${latestApproval.id}`,
          timestamp: latestApproval.decidedAt,
          eventType: isApproved ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
          description: isApproved
            ? `Recovery execution approved by operator`
            : `Recovery execution rejected by operator: ${latestApproval.reason || 'No reason specified'}`,
          system: 'Operator',
          status: latestApproval.status,
          actor: latestApproval.decidedByUser
            ? { id: latestApproval.decidedByUser.id, name: latestApproval.decidedByUser.name }
            : null,
          metadata: {
            reason: latestApproval.reason,
          },
        });
      }
    }

    // 6. Job Attempts
    for (const job of workflow.jobs) {
      for (const attempt of job.attempts) {
        timeline.push({
          id: `job-att-start-${attempt.id}`,
          timestamp: attempt.startedAt,
          eventType: 'JOB_ATTEMPT_STARTED',
          description: `Durable job attempt #${attempt.attemptNumber} for "${job.type}" started`,
          system: 'Reloop Worker',
          status: attempt.status,
          actor: { id: 'worker', name: attempt.workerId || 'Reloop Worker' },
          metadata: {
            jobType: job.type,
            attemptNumber: attempt.attemptNumber,
          },
        });

        if (attempt.finishedAt) {
          timeline.push({
            id: `job-att-end-${attempt.id}`,
            timestamp: attempt.finishedAt,
            eventType: attempt.status === 'SUCCEEDED' ? 'JOB_ATTEMPT_SUCCEEDED' : 'JOB_ATTEMPT_FAILED',
            description: `Job attempt #${attempt.attemptNumber} finished (${attempt.status})${
              attempt.errorMessage ? ': ' + attempt.errorMessage.slice(0, 100) : ''
            }`,
            system: 'Reloop Worker',
            status: attempt.status,
            actor: { id: 'worker', name: attempt.workerId || 'Reloop Worker' },
            metadata: {
              durationMs: attempt.durationMs,
              errorCategory: attempt.errorCategory,
            },
          });
        }
      }
    }

    // 7. Workflow Completed
    if (workflow.completedAt) {
      timeline.push({
        id: `wf-complete-${workflow.id}`,
        timestamp: workflow.completedAt,
        eventType: workflow.status === WorkflowStatus.SUCCEEDED ? 'WORKFLOW_SUCCEEDED' : 'WORKFLOW_FAILED',
        description: `Recovery workflow finished with status ${workflow.status}`,
        system: 'Workflow Coordinator',
        status: workflow.status,
        actor: { id: 'system', name: 'Workflow Coordinator' },
        metadata: {},
      });
    }

    // 8. Case Resolved
    if (rc.resolvedAt) {
      timeline.push({
        id: `case-resolved-${rc.id}`,
        timestamp: rc.resolvedAt,
        eventType: 'CASE_RESOLVED',
        description: `Recovery case marked RESOLVED`,
        system: 'Reloop Engine',
        status: 'RESOLVED',
        actor: { id: 'system', name: 'Reliability Engine' },
        metadata: {},
      });
    }

    // Sort chronologically ascending
    timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return {
      id: workflow.id,
      recoveryCaseId: workflow.recoveryCaseId,
      caseType: rc.type,
      recoveryLevel: rc.recoveryLevel,
      caseSummary: rc.summary,
      templateKey: workflow.templateKey,
      templateVersion: workflow.templateVersion,
      status: workflow.status,
      order: rc.externalOrder
        ? {
            id: rc.externalOrder.id,
            orderNumber: rc.externalOrder.externalOrderNumber,
          }
        : null,
      approval: latestApproval
        ? {
            id: latestApproval.id,
            status: latestApproval.status,
            reason: latestApproval.reason,
            requestedAt: latestApproval.requestedAt,
            decidedAt: latestApproval.decidedAt,
            previewSnapshot: (latestApproval.previewSnapshot as Record<string, any>) || null,
          }
        : null,
      timeline,
      startedAt: workflow.startedAt,
      completedAt: workflow.completedAt,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    };
  }
}
