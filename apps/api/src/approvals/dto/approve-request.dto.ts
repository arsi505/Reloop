import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ApproveRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Note cannot exceed 1000 characters' })
  note?: string;
}
