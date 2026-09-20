import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, RecoveryCaseStatus, WorkflowStatus } from '@reloop/database';
import {
  ExceptionsQueryDto,
  ExceptionListItemDto,
  ExceptionDetailDto,
} from '../dto/exceptions.dto';
import { PaginatedResponse } from '../dto/pagination.dto';

@Injectable()
export class ExceptionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves a paginated, filtered list of exceptions for the organization.
   */
  async listExceptions(
    organizationId: string,
    query: ExceptionsQueryDto,
  ): Promise<PaginatedResponse<ExceptionListItemDto>> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
    const skip = (page - 1) * pageSize;
    const sortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc';

    const where: Prisma.RecoveryCaseWhereInput = {
      organizationId,
    };

    if (query.status) {
      where.status = query.status;
    }

    if (query.recoveryLevel) {
      where.recoveryLevel = query.recoveryLevel;
    }

    if (query.type) {
      where.type = query.type;
    }

    if (query.provider) {
      where.sourceIntegration = {
        provider: query.provider,
      };
    }

    if (query.startDate || query.endDate) {
      where.detectedAt = {};
      if (query.startDate) {
        where.detectedAt.gte = new Date(query.startDate);
      }
      if (query.endDate) {
        where.detectedAt.lte = new Date(query.endDate);
      }
    }

    if (query.search && query.search.trim().length > 0) {
      const searchTerm = query.search.trim();
      where.OR = [
        { summary: { contains: searchTerm, mode: 'insensitive' } },
        {
          externalOrder: {
            externalOrderNumber: { contains: searchTerm, mode: 'insensitive' },
          },
        },
      ];
    }

    const [total, records] = await Promise.all([
      this.prisma.recoveryCase.count({ where }),
      this.prisma.recoveryCase.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { detectedAt: sortOrder },
        include: {
          externalOrder: {
            select: {
              id: true,
              externalOrderNumber: true,
            },
          },
          sourceIntegration: {
            select: {
              id: true,
              provider: true,
            },
          },
          workflows: {
            select: {
              id: true,
              status: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          approvals: {
            where: { status: 'PENDING' },
            select: { id: true },
          },
        },
      }),
    ]);

    const items: ExceptionListItemDto[] = records.map((rc) => {
      const latestWorkflow = rc.workflows[0] || null;
      const approvalWaiting =
        rc.approvals.length > 0 || rc.status === RecoveryCaseStatus.WAITING_APPROVAL;

      return {
        id: rc.id,
        type: rc.type,
        recoveryLevel: rc.recoveryLevel,
        status: rc.status,
        summary: rc.summary,
        detectedAt: rc.detectedAt,
        resolvedAt: rc.resolvedAt,
        order: rc.externalOrder
          ? {
              id: rc.externalOrder.id,
              orderNumber: rc.externalOrder.externalOrderNumber,
            }
          : null,
        provider: rc.sourceIntegration?.provider || null,
        hasActiveWorkflow: !!latestWorkflow && latestWorkflow.status === WorkflowStatus.RUNNING,
        workflowStatus: latestWorkflow?.status || null,
        approvalWaiting,
        createdAt: rc.createdAt,
        updatedAt: rc.updatedAt,
      };
    });

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
   * Retrieves sanitized detail for a single exception.
   * Scoped strictly to the tenant organization (returns 404 for cross-tenant IDs).
   */
  async getExceptionDetail(organizationId: string, id: string): Promise<ExceptionDetailDto> {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException(`Exception ${id} not found`);
    }

    const rc = await this.prisma.recoveryCase.findFirst({
      where: {
        id,
        organizationId,
      },
      include: {
        externalOrder: true,
        sourceIntegration: true,
        workflows: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            steps: {
              orderBy: { position: 'asc' },
            },
          },
        },
        approvals: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!rc) {
      throw new NotFoundException(`Exception ${id} not found`);
    }

    const latestWorkflow = rc.workflows[0] || null;
    const latestApproval = rc.approvals[0] || null;

    // Sanitize evidence: strip PII and redact any secrets
    const sanitizedEvidence = this.sanitizeEvidence(
      (rc.evidence as Record<string, any>) || {},
    );

    // Determine safe recovery result
    let recoveryResult: { outcome: string; details?: string } | null = null;
    if (rc.status === RecoveryCaseStatus.RESOLVED) {
      recoveryResult = { outcome: 'RESOLVED', details: 'Case successfully resolved and verified.' };
    } else if (rc.status === RecoveryCaseStatus.FAILED) {
      recoveryResult = { outcome: 'FAILED', details: 'Recovery workflow or verification failed.' };
    } else if (latestWorkflow?.status === WorkflowStatus.SUCCEEDED) {
      recoveryResult = { outcome: 'RECOVERED', details: 'Workflow completed successfully.' };
    }

    return {
      id: rc.id,
      type: rc.type,
      recoveryLevel: rc.recoveryLevel,
      status: rc.status,
      summary: rc.summary,
      detectedAt: rc.detectedAt,
      resolvedAt: rc.resolvedAt,
      dedupeKey: rc.dedupeKey,
      sanitizedEvidence,
      order: rc.externalOrder
        ? {
            id: rc.externalOrder.id,
            orderNumber: rc.externalOrder.externalOrderNumber,
            status: rc.externalOrder.status,
            currency: rc.externalOrder.currency,
            totalAmount: rc.externalOrder.totalAmount?.toString() || null,
            sourceCreatedAt: rc.externalOrder.sourceCreatedAt,
          }
        : null,
      integration: rc.sourceIntegration
        ? {
            id: rc.sourceIntegration.id,
            provider: rc.sourceIntegration.provider,
            name: rc.sourceIntegration.name,
            status: rc.sourceIntegration.status,
          }
        : null,
      workflow: latestWorkflow
        ? {
            id: latestWorkflow.id,
            templateKey: latestWorkflow.templateKey,
            templateVersion: latestWorkflow.templateVersion,
            status: latestWorkflow.status,
            startedAt: latestWorkflow.startedAt,
            completedAt: latestWorkflow.completedAt,
          }
        : null,
      workflowSteps: (latestWorkflow?.steps || []).map((s) => ({
        id: s.id,
        key: s.key,
        name: s.name,
        position: s.position,
        status: s.status,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        output: s.output ? this.sanitizeEvidence(s.output as Record<string, any>) : null,
      })),
      approval: latestApproval
        ? {
            id: latestApproval.id,
            status: latestApproval.status,
            reason: latestApproval.reason,
            requestedAt: latestApproval.requestedAt,
            decidedAt: latestApproval.decidedAt,
            expiresAt: latestApproval.expiresAt,
            previewSnapshot: (latestApproval.previewSnapshot as Record<string, any>) || null,
          }
        : null,
      recoveryResult,
      createdAt: rc.createdAt,
      updatedAt: rc.updatedAt,
    };
  }

  /**
   * Recursively strips customer PII and redacts secret tokens from evidence objects.
   */
  sanitizeEvidence(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizeEvidence(item));
    }

    const sanitized: Record<string, any> = {};
    const forbiddenPiiKeys = new Set([
      'name',
      'customername',
      'recipientname',
      'email',
      'customeremail',
      'phone',
      'telephone',
      'address',
      'street',
      'address1',
      'address2',
      'city',
      'zip',
      'postalcode',
      'shippingaddress',
      'billingaddress',
    ]);

    const secretKeys = new Set([
      'token',
      'accesstoken',
      'refreshtoken',
      'apikey',
      'clientsecret',
      'password',
      'passwordhash',
      'encryptedcredentials',
      'authorization',
    ]);

    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (
        forbiddenPiiKeys.has(lowerKey) ||
        lowerKey.includes('email') ||
        lowerKey.includes('phone') ||
        lowerKey.includes('address') ||
        lowerKey.includes('street') ||
        lowerKey.includes('postal') ||
        lowerKey.includes('zip')
      ) {
        // Exclude customer PII entirely from product response
        continue;
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeEvidence(value);
      } else if (
        secretKeys.has(lowerKey) ||
        lowerKey.includes('key') ||
        lowerKey.includes('token') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('password') ||
        lowerKey.includes('credential') ||
        lowerKey.includes('auth')
      ) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}
