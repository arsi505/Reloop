import {
  NormalizedLineItem,
  NormalizedOrderUpdate,
} from '@reloop/integration-sdk';
import { ShopifyOrderNode } from './shopify-client';

export interface NormalizedShopifyFulfillment {
  fulfillmentId: string;
  status: 'UNFULFILLED' | 'PARTIAL' | 'FULFILLED' | 'CANCELLED';
  trackingNumber?: string;
  carrier?: string;
  trackingUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NormalizedShopifyOrder {
  orderNumber: string;
  externalOrderId: string;
  status: 'PENDING' | 'READY_FOR_FULFILLMENT' | 'FULFILLING' | 'SHIPPED' | 'CANCELLED' | 'UNKNOWN';
  currency?: string;
  totalAmount?: number;
  sourceCreatedAt: Date;
  lineItems: NormalizedLineItem[];
  fulfillments: NormalizedShopifyFulfillment[];
  primaryTrackingNumber?: string;
  primaryCarrier?: string;
}

/**
 * Normalizes Shopify displayFulfillmentStatus to Reloop status.
 */
export function mapShopifyFulfillmentStatus(
  displayStatus: string | null,
  cancelledAt: string | null,
): 'PENDING' | 'READY_FOR_FULFILLMENT' | 'FULFILLING' | 'SHIPPED' | 'CANCELLED' | 'UNKNOWN' {
  if (cancelledAt) {
    return 'CANCELLED';
  }

  if (!displayStatus) {
    return 'PENDING';
  }

  const normalized = displayStatus.toUpperCase();
  switch (normalized) {
    case 'FULFILLED':
      return 'SHIPPED';
    case 'PARTIALLY_FULFILLED':
    case 'IN_PROGRESS':
      return 'FULFILLING';
    case 'UNFULFILLED':
      return 'READY_FOR_FULFILLMENT';
    case 'RESTOCKED':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Normalizes individual Shopify fulfillment status.
 */
export function mapSingleFulfillmentStatus(
  status: string,
): 'UNFULFILLED' | 'PARTIAL' | 'FULFILLED' | 'CANCELLED' {
  const s = status.toUpperCase();
  switch (s) {
    case 'SUCCESS':
    case 'FULFILLED':
      return 'FULFILLED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'OPEN':
    case 'PENDING':
      return 'PARTIAL';
    default:
      return 'PARTIAL';
  }
}

/**
 * Normalizes a raw Shopify GraphQL Order into Reloop normalized order structures.
 * Enforces PII minimization (no customer email, address, phone stored).
 */
export function normalizeShopifyOrder(order: ShopifyOrderNode): NormalizedShopifyOrder {
  // Strip leading '#' from order name if present to get clean order number
  const orderNumber = order.name.replace(/^#/, '').trim();
  const externalOrderId = order.id;
  const status = mapShopifyFulfillmentStatus(order.displayFulfillmentStatus, order.cancelledAt);
  const sourceCreatedAt = new Date(order.createdAt);

  let totalAmount: number | undefined;
  let currency: string | undefined;
  if (order.totalPriceSet?.shopMoney) {
    totalAmount = parseFloat(order.totalPriceSet.shopMoney.amount);
    currency = order.totalPriceSet.shopMoney.currencyCode;
  }

  // Normalize Line Items
  const lineItems: NormalizedLineItem[] = [];
  if (order.lineItems?.edges) {
    for (const edge of order.lineItems.edges) {
      const node = edge.node;
      lineItems.push({
        sku: node.sku || `NOSKU-${node.id.split('/').pop()}`,
        quantity: node.quantity,
        name: node.title,
      });
    }
  }

  // Normalize Fulfillments
  const fulfillments: NormalizedShopifyFulfillment[] = [];
  let primaryTrackingNumber: string | undefined;
  let primaryCarrier: string | undefined;

  if (order.fulfillments && Array.isArray(order.fulfillments)) {
    for (const f of order.fulfillments) {
      const tracking = f.trackingInfo && f.trackingInfo.length > 0 ? f.trackingInfo[0] : null;
      const trackingNumber = tracking?.number || undefined;
      const carrier = tracking?.company || undefined;
      const trackingUrl = tracking?.url || undefined;

      fulfillments.push({
        fulfillmentId: f.id,
        status: mapSingleFulfillmentStatus(f.status),
        trackingNumber,
        carrier,
        trackingUrl,
        createdAt: new Date(f.createdAt),
        updatedAt: new Date(f.updatedAt),
      });

      if (!primaryTrackingNumber && trackingNumber) {
        primaryTrackingNumber = trackingNumber;
        primaryCarrier = carrier;
      }
    }
  }

  return {
    orderNumber,
    externalOrderId,
    status,
    currency,
    totalAmount,
    sourceCreatedAt,
    lineItems,
    fulfillments,
    primaryTrackingNumber,
    primaryCarrier,
  };
}

/**
 * Converts a NormalizedShopifyOrder into NormalizedOrderUpdate for reconciliation projection.
 */
export function toNormalizedOrderUpdate(order: NormalizedShopifyOrder, occurredAt: Date): NormalizedOrderUpdate {
  return {
    orderNumber: order.orderNumber,
    externalOrderId: order.externalOrderId,
    status: order.status,
    currency: order.currency,
    totalAmount: order.totalAmount,
    trackingNumber: order.primaryTrackingNumber,
    carrier: order.primaryCarrier,
    lineItems: order.lineItems,
    sourceCreatedAt: order.sourceCreatedAt,
    occurredAt,
  };
}
