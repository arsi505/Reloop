export type WebhookEventType =
  | 'ORDER_CREATED'
  | 'ORDER_UPDATED'
  | 'FULFILLMENT_UPDATED'
  | 'SHIPMENT_UPDATED'
  | 'INVENTORY_UPDATED'
  | 'UNKNOWN';

export interface WebhookEventIdentity {
  providerEventId: string;
  eventType: string;
  occurredAt?: Date;
  orderNumber?: string;
  externalOrderId?: string;
}

export interface NormalizedLineItem {
  sku: string;
  quantity: number;
  name?: string;
}

export interface NormalizedOrderUpdate {
  orderNumber: string;
  externalOrderId?: string;
  status?: string;
  customerReference?: string;
  currency?: string;
  totalAmount?: number;
  trackingNumber?: string;
  carrier?: string;
  lineItems?: NormalizedLineItem[];
  sourceCreatedAt?: Date;
  occurredAt: Date;
}

export interface NormalizedFulfillmentUpdate {
  orderNumber: string;
  externalOrderId?: string;
  fulfillmentStatus: 'UNFULFILLED' | 'PARTIAL' | 'FULFILLED' | 'CANCELLED';
  trackingNumber?: string;
  carrier?: string;
  occurredAt: Date;
}

export interface NormalizedShipmentUpdate {
  orderNumber: string;
  externalShipmentId?: string;
  trackingNumber: string;
  carrier: string;
  shipmentStatus: 'PENDING' | 'LABEL_CREATED' | 'IN_TRANSIT' | 'SHIPPED' | 'DELIVERED';
  occurredAt: Date;
}

export interface NormalizedInventoryUpdate {
  sku: string;
  quantity: number;
  locationId?: string;
  occurredAt: Date;
}

export type NormalizedWebhookPayload =
  | { type: 'ORDER'; data: NormalizedOrderUpdate }
  | { type: 'FULFILLMENT'; data: NormalizedFulfillmentUpdate }
  | { type: 'SHIPMENT'; data: NormalizedShipmentUpdate }
  | { type: 'INVENTORY'; data: NormalizedInventoryUpdate };

export interface NormalizedWebhookEvent {
  identity: WebhookEventIdentity;
  domain: NormalizedWebhookPayload;
}

export interface WebhookAdapter {
  readonly provider: string;

  /**
   * Cryptographically verifies the webhook signature against the raw request body bytes.
   * MUST use constant-time comparison.
   */
  verifySignature(rawBody: Buffer, signature: string, secret: string): boolean;

  /**
   * Extracts the stable provider delivery identity and event metadata from headers and parsed payload.
   */
  identifyEvent(
    headers: Record<string, string | string[] | undefined>,
    payload: unknown,
  ): WebhookEventIdentity;

  /**
   * Normalizes the provider-specific payload into a standard Reloop internal event representation.
   * Returns null if the event is valid but unhandled/ignored.
   * Throws if the payload is malformed.
   */
  normalize(payload: unknown, eventType: string): NormalizedWebhookEvent | null;
}
