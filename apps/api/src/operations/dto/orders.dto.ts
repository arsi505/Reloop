import {
  IsOptional,
  IsEnum,
  IsString,
  MaxLength,
  IsBoolean,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import {
  ExternalOrderStatus,
  IntegrationProvider,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
} from '@reloop/database';
import { PaginationQueryDto } from './pagination.dto';

export class OrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ExternalOrderStatus)
  status?: ExternalOrderStatus;

  @IsOptional()
  @IsEnum(IntegrationProvider)
  provider?: IntegrationProvider;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean()
  hasException?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export interface OrderListItemDto {
  id: string;
  externalOrderNumber: string;
  customerReference: string | null;
  status: ExternalOrderStatus;
  currency: string | null;
  totalAmount: string | null;
  sourceCreatedAt: Date | null;
  lastObservedAt: Date;
  primaryProvider: IntegrationProvider | null;
  connectedProviders: IntegrationProvider[];
  activeExceptionCount: number;
  hasOpenException: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShopifyCrossSystemStateDto {
  fulfillmentStatus: string | null;
  financialStatus?: string | null;
  trackingNumbers: string[];
  lastObservedAt: Date | null;
}

export interface ShipStationCrossSystemStateDto {
  shipmentStatus: string | null;
  trackingNumbers: string[];
  carrierCodes: string[];
  labelCount: number;
  voidedLabelCount: number;
  lastObservedAt: Date | null;
}

export interface Generic3plCrossSystemStateDto {
  warehouseStatus: string | null;
  trackingNumber: string | null;
  lastObservedAt: Date | null;
}

export interface OrderExternalReferenceDto {
  id: string;
  provider: IntegrationProvider;
  resourceType: string;
  externalId: string;
  externalReference: string | null;
  createdAt: Date;
}

export interface OrderRelatedExceptionDto {
  id: string;
  type: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  status: RecoveryCaseStatus;
  summary: string;
  detectedAt: Date;
}

export interface CrossSystemDiscrepancyDto {
  hasDiscrepancy: boolean;
  summary: string | null;
  details: Record<string, any>;
}

export interface OrderDetailDto {
  id: string;
  externalOrderNumber: string;
  customerReference: string | null;
  status: ExternalOrderStatus;
  currency: string | null;
  totalAmount: string | null;
  sourceCreatedAt: Date | null;
  lastObservedAt: Date;
  shopifyState: ShopifyCrossSystemStateDto | null;
  shipstationState: ShipStationCrossSystemStateDto | null;
  generic3plState: Generic3plCrossSystemStateDto | null;
  trackingNumbers: string[];
  externalReferences: OrderExternalReferenceDto[];
  relatedExceptions: OrderRelatedExceptionDto[];
  crossSystemDiscrepancy: CrossSystemDiscrepancyDto | null;
  createdAt: Date;
  updatedAt: Date;
}
