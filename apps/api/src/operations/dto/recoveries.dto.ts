import {
  IsOptional,
  IsEnum,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  WorkflowStatus,
  RecoveryLevel,
  RecoveryCaseType,
  ApprovalStatus,
} from '@reloop/database';
import { PaginationQueryDto } from './pagination.dto';

export class RecoveriesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(WorkflowStatus)
  status?: WorkflowStatus;

  @IsOptional()
  @IsEnum(RecoveryLevel)
  recoveryLevel?: RecoveryLevel;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export interface RecoveryListItemDto {
  id: string; // workflowId
  recoveryCaseId: string;
  caseType: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  caseSummary: string;
  templateKey: string;
  templateVersion: number;
  status: WorkflowStatus;
  orderNumber: string | null;
  approvalStatus: ApprovalStatus | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface TimelineActorDto {
  id: string;
  name: string;
}

export interface TimelineEntryDto {
  id: string;
  timestamp: Date;
  eventType: string;
  description: string;
  system: string;
  status: string;
  actor: TimelineActorDto | null;
  metadata: Record<string, any>;
}

export interface RecoveryDetailApprovalDto {
  id: string;
  status: ApprovalStatus;
  reason: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  previewSnapshot: Record<string, any> | null;
}

export interface RecoveryDetailDto {
  id: string; // workflowId
  recoveryCaseId: string;
  caseType: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  caseSummary: string;
  templateKey: string;
  templateVersion: number;
  status: WorkflowStatus;
  order: { id: string; orderNumber: string } | null;
  approval: RecoveryDetailApprovalDto | null;
  timeline: TimelineEntryDto[];
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
