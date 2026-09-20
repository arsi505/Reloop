import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ConnectShipStationDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'apiKey must be at least 8 characters' })
  apiKey!: string;
}
