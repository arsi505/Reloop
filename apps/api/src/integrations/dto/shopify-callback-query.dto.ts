import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ShopifyCallbackQueryDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  hmac!: string;

  @IsString()
  @IsNotEmpty()
  shop!: string;

  @IsString()
  @IsNotEmpty()
  state!: string;

  @IsString()
  @IsOptional()
  timestamp?: string;

  [key: string]: string | undefined;
}
