import { IsNotEmpty, IsString } from 'class-validator';

export class ConnectShopifyDto {
  @IsString()
  @IsNotEmpty()
  shop!: string;
}
