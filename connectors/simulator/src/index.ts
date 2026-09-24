export const SIMULATOR_CONNECTOR_VERSION = '0.1.0';

export type PaymentStatus = 'PAID' | 'PENDING' | 'REFUNDED';
export type FulfillmentStatus = 'UNFULFILLED' | 'PARTIAL' | 'FULFILLED' | 'CANCELLED';
export type ShippingStatus = 'PENDING' | 'LABEL_CREATED' | 'IN_TRANSIT' | 'DELIVERED';
export type WarehouseStatus =
  | 'RECEIVED'
  | 'PENDING_FULFILLMENT'
  | 'PICKING'
  | 'PACKED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'REJECTED'
  | 'CANCELLED';

export const CANONICAL_WAREHOUSE_STATUSES: readonly WarehouseStatus[] = [
  'RECEIVED',
  'PENDING_FULFILLMENT',
  'PICKING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'REJECTED',
] as const;

export interface CustomerInfo {
  name: string;
  email: string;
  phone?: string;
}

export interface AddressInfo {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface LineItemInfo {
  sku: string;
  name: string;
  quantity: number;
  price: number;
}

export interface ShopifyOrder {
  id: string;
  orderNumber: string;
  customer: CustomerInfo;
  shippingAddress: AddressInfo;
  lineItems: LineItemInfo[];
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  trackingNumber?: string;
  carrier?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShipStationShipment {
  id: string;
  orderNumber: string;
  carrier: string;
  trackingNumber: string;
  status: ShippingStatus;
  shippingAddress: AddressInfo;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseOrder {
  id: string;
  orderNumber: string;
  externalReference?: string;
  customer: CustomerInfo;
  shippingAddress: AddressInfo;
  lineItems: LineItemInfo[];
  status: WarehouseStatus;
  trackingNumber?: string;
  carrier?: string;
  rejectedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type FaultType =
  | 'RETURN_429'
  | 'RETURN_503'
  | 'TIMEOUT'
  | 'SLOW_RESPONSE'
  | 'INVALID_SKU'
  | 'INVALID_ADDRESS'
  | 'ORDER_NOT_FOUND'
  | 'DUPLICATE_ORDER'
  | 'INVENTORY_MISMATCH'
  | 'COMMIT_THEN_TIMEOUT'
  | 'SUCCESS_WITHOUT_COMMIT'
  | 'SUCCESS';

export interface FaultRule {
  id?: string;
  fault: FaultType;
  provider?: 'shopify' | 'shipstation' | '3pl' | 'all';
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'ALL';
  pathPattern?: string;
  remainingCount: number;
  retryAfterSeconds?: number;
  delayMs?: number;
}

export type ScenarioName =
  | 'HEALTHY_ORDER'
  | 'TEMPORARY_3PL_FAILURE'
  | 'TRACKING_MISSING_IN_SHOPIFY'
  | 'STUCK_ORDER'
  | 'MISSING_AT_3PL'
  | 'SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY'
  | 'INVENTORY_MISMATCH'
  | 'DUPLICATE_RISK'
  | 'INVALID_ORDER_DATA'
  | 'AMBIGUOUS_TIMEOUT';

export interface SimulatorErrorResponse {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    details?: any;
  };
}

export interface SimulatorHealthResponse {
  status: 'ok';
  service: 'simulator';
  providers: {
    shopify: 'ok' | 'degraded';
    shipstation: 'ok' | 'degraded';
    '3pl': 'ok' | 'degraded';
  };
}

export * from './recovery-actions';
export * from './simulator-webhook-adapter';
