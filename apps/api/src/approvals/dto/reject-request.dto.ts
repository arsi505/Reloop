import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class RejectRequestDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Reason must be a string' })
  @IsNotEmpty({ message: 'Reason must not be empty' })
  @MaxLength(1000, { message: 'Reason cannot exceed 1000 characters' })
  reason!: string;
}
