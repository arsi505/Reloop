import { IsOptional, IsEnum } from 'class-validator';
import { ApprovalStatus } from '@reloop/database';

export class ApprovalQueryDto {
  @IsOptional()
  @IsEnum(ApprovalStatus, { message: 'Invalid approval status filter' })
  status?: ApprovalStatus;
}
