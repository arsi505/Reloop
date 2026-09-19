export type CanonicalRecoveryCaseType =
  | 'TEMPORARY_API_FAILURE'
  | 'TRACKING_MISSING_IN_SHOPIFY'
  | 'STUCK_ORDER'
  | 'ORDER_MISSING_AT_3PL'
  | 'SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY'
  | 'INVENTORY_MISMATCH'
  | 'DUPLICATE_RISK'
  | 'INVALID_ORDER_DATA';

export type CanonicalRecoveryLevel =
  | 'AUTO_RECOVER'
  | 'AUTO_INVESTIGATE'
  | 'REQUIRE_APPROVAL'
  | 'BLOCK';

export type MatchStatus = 'MATCH' | 'NO_MATCH' | 'AMBIGUOUS' | 'CONFLICT';

export interface ProviderErrorSnapshot {
  provider: 'Shopify' | 'ShipStation' | 'Generic3PL';
  statusCode?: number;
  errorCode?: string;
  message: string;
  isTransient: boolean;
}

export interface LineItemSnapshot {
  sku: string;
  name?: string;
  quantity: number;
}

export interface ShopifyOrderSnapshot {
  id: string;
  orderNumber: string;
  fulfillmentStatus: 'UNFULFILLED' | 'PARTIAL' | 'FULFILLED' | 'CANCELLED';
  trackingNumber?: string;
  carrier?: string;
  lineItems: LineItemSnapshot[];
  addressValid?: boolean;
  paymentStatus?: string;
  createdAt: string;
  updatedAt: string;
  error?: ProviderErrorSnapshot;
}

export interface WarehouseCandidateOrder {
  id: string;
  orderNumber: string;
  status: string;
  externalReference?: string;
}

export interface WarehouseOrderSnapshot {
  id: string;
  orderNumber: string;
  externalReference?: string;
  status:
    | 'RECEIVED'
    | 'PENDING_FULFILLMENT'
    | 'PICKING'
    | 'PACKED'
    | 'SHIPPED'
    | 'DELIVERED'
    | 'REJECTED'
    | 'CANCELLED';
  trackingNumber?: string;
  carrier?: string;
  lineItems: LineItemSnapshot[];
  rejectedReason?: string;
  candidateOrders?: WarehouseCandidateOrder[];
  createdAt: string;
  updatedAt: string;
  error?: ProviderErrorSnapshot;
}

export interface ShipStationCandidateShipment {
  id: string;
  orderNumber: string;
  trackingNumber: string;
  carrier: string;
  status: string;
}

export interface ShipStationShipmentSnapshot {
  id: string;
  orderNumber: string;
  carrier: string;
  trackingNumber: string;
  status: 'PENDING' | 'LABEL_CREATED' | 'IN_TRANSIT' | 'DELIVERED';
  candidateShipments?: ShipStationCandidateShipment[];
  createdAt: string;
  updatedAt: string;
  error?: ProviderErrorSnapshot;
}

export interface InventoryItemSnapshot {
  sku: string;
  shopifyQuantity?: number;
  warehouseQuantity?: number;
  error?: ProviderErrorSnapshot;
}

export interface NormalizedOrderSnapshot {
  organizationId: string;
  orderNumber: string;
  externalOrderId?: string;
  shopify?: ShopifyOrderSnapshot;
  warehouse?: WarehouseOrderSnapshot;
  shipstation?: ShipStationShipmentSnapshot;
  inventory?: InventoryItemSnapshot[];
}

export interface MatchingResult {
  status: MatchStatus;
  matchedIdentifiers: string[];
  conflictingIdentifiers: string[];
  candidateCount: number;
  candidateIds: string[];
  details: string;
}

export interface SafeEvidence {
  evaluatedAt: string;
  systemsCompared: string[];
  invariantFailed: string;
  disagreements: Record<string, { expected?: unknown; observed?: unknown }>;
  matchedIdentifiers: string[];
  conflictingIdentifiers: string[];
  candidateCount?: number;
  blockingReason?: string;
  transientReason?: string;
  details?: Record<string, unknown>;
}

export interface ReconciliationFinding {
  ruleKey: string;
  category: CanonicalRecoveryCaseType;
  recoveryLevel: CanonicalRecoveryLevel;
  orderIdentity: {
    orderNumber: string;
    externalOrderId?: string;
  };
  summary: string;
  evidence: SafeEvidence;
}

export interface ReconcileOptions {
  evaluationTime?: Date | string;
  stuckOrderThresholdMs?: number;
  fulfillmentGracePeriodMs?: number;
}
