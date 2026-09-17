import { IsOptional, IsString, MinLength, MaxLength } from 'class-validator';

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Organization name must be at least 2 characters long' })
  @MaxLength(100, { message: 'Organization name cannot exceed 100 characters' })
  name?: string;
}