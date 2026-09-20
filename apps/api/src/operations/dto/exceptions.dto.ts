import {
  IsOptional,
  IsEnum,
  IsString,
  MaxLength,
  IsDateString,
} from 'class-validator';
import {
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
  IntegrationProvider,
  WorkflowStatus,
} from '@reloop/database';
import { PaginationQueryDto } from './pagination.dto';

export class ExceptionsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(RecoveryCaseStatus)
  status?: RecoveryCaseStatus;

  @IsOptional()
  @IsEnum(RecoveryLevel)
  recoveryLevel?: RecoveryLevel;

  @IsOptional()
  @IsEnum(RecoveryCaseType)
  type?: RecoveryCaseType;

  @IsOptional()
  @IsEnum(IntegrationProvider)
  provider?: IntegrationProvider;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export interface ExceptionOrderReferenceDto {
  id: string;
  orderNumber: string;
}

export interface ExceptionListItemDto {
  id: string;
  type: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  status: RecoveryCaseStatus;
  summary: string;
  detectedAt: Date;
  resolvedAt: Date | null;
  order: ExceptionOrderReferenceDto | null;
  provider: IntegrationProvider | null;
  hasActiveWorkflow: boolean;
  workflowStatus: WorkflowStatus | null;
  approvalWaiting: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExceptionDetailOrderDto {
  id: string;
  orderNumber: string;
  status: string;
  currency: string | null;
  totalAmount: string | null;
  sourceCreatedAt: Date | null;
}

export interface ExceptionDetailIntegrationDto {
  id: string;
  provider: IntegrationProvider;
  name: string;
  status: string;
}

export interface ExceptionDetailWorkflowStepDto {
  id: string;
  key: string;
  name: string;
  position: number;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  output?: Record<string, any> | null;
}

export interface ExceptionDetailWorkflowDto {
  id: string;
  templateKey: string;
  templateVersion: number;
  status: WorkflowStatus;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface ExceptionDetailApprovalDto {
  id: string;
  status: string;
  reason: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  expiresAt: Date | null;
  previewSnapshot: Record<string, any> | null;
}

export interface ExceptionDetailDto {
  id: string;
  type: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  status: RecoveryCaseStatus;
  summary: string;
  detectedAt: Date;
  resolvedAt: Date | null;
  dedupeKey: string | null;
  sanitizedEvidence: Record<string, any>;
  order: ExceptionDetailOrderDto | null;
  integration: ExceptionDetailIntegrationDto | null;
  workflow: ExceptionDetailWorkflowDto | null;
  workflowSteps: ExceptionDetailWorkflowStepDto[];
  approval: ExceptionDetailApprovalDto | null;
  recoveryResult: { outcome: string; details?: string } | null;
  createdAt: Date;
  updatedAt: Date;
}
