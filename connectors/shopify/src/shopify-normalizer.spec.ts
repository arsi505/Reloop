import {
  normalizeShopifyOrder,
  toNormalizedOrderUpdate,
  mapShopifyFulfillmentStatus,
} from './shopify-normalizer';
import { ShopifyOrderNode } from './shopify-client';

describe('Shopify Order & Fulfillment Normalizer', () => {
  it('maps fulfillment status correctly', () => {
    expect(mapShopifyFulfillmentStatus('FULFILLED', null)).toBe('SHIPPED');
    expect(mapShopifyFulfillmentStatus('PARTIALLY_FULFILLED', null)).toBe('FULFILLING');
    expect(mapShopifyFulfillmentStatus('UNFULFILLED', null)).toBe('READY_FOR_FULFILLMENT');
    expect(mapShopifyFulfillmentStatus(null, null)).toBe('PENDING');
    expect(mapShopifyFulfillmentStatus('FULFILLED', '2026-07-01T00:00:00Z')).toBe('CANCELLED');
  });

  it('normalizes order with multiple fulfillments deterministically', () => {
    const rawOrder: ShopifyOrderNode = {
      id: 'gid://shopify/Order/1001',
      name: '#1001',
      createdAt: '2026-07-01T10:00:00Z',
      updatedAt: '2026-07-01T12:00:00Z',
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
      displayFinancialStatus: 'PAID',
      cancelledAt: null,
      totalPriceSet: {
        shopMoney: {
          amount: '120.50',
          currencyCode: 'USD',
        },
      },
      lineItems: {
        edges: [
          { node: { id: 'gid://shopify/LineItem/1', sku: 'SKU-SHIRT-M', quantity: 2, title: 'Cotton Shirt' } },
          { node: { id: 'gid://shopify/LineItem/2', sku: null, quantity: 1, title: 'Sticker Pack' } },
        ],
      },
      fulfillments: [
        {
          id: 'gid://shopify/Fulfillment/101',
          status: 'SUCCESS',
          createdAt: '2026-07-01T11:00:00Z',
          updatedAt: '2026-07-01T11:05:00Z',
          trackingInfo: [{ number: 'TRACK-111', company: 'UPS', url: 'https://ups.com/track' }],
        },
        {
          id: 'gid://shopify/Fulfillment/102',
          status: 'SUCCESS',
          createdAt: '2026-07-01T12:00:00Z',
          updatedAt: '2026-07-01T12:05:00Z',
          trackingInfo: [{ number: 'TRACK-222', company: 'FedEx', url: 'https://fedex.com/track' }],
        },
      ],
    };

    const normalized = normalizeShopifyOrder(rawOrder);

    expect(normalized.orderNumber).toBe('1001');
    expect(normalized.externalOrderId).toBe('gid://shopify/Order/1001');
    expect(normalized.status).toBe('FULFILLING');
    expect(normalized.totalAmount).toBe(120.50);
    expect(normalized.currency).toBe('USD');

    // Line items
    expect(normalized.lineItems).toHaveLength(2);
    expect(normalized.lineItems[0].sku).toBe('SKU-SHIRT-M');
    expect(normalized.lineItems[1].sku).toBe('NOSKU-2'); // fallback for null SKU

    // Multiple fulfillments
    expect(normalized.fulfillments).toHaveLength(2);
    expect(normalized.fulfillments[0].trackingNumber).toBe('TRACK-111');
    expect(normalized.fulfillments[0].carrier).toBe('UPS');
    expect(normalized.fulfillments[1].trackingNumber).toBe('TRACK-222');
    expect(normalized.fulfillments[1].carrier).toBe('FedEx');

    // Primary tracking info
    expect(normalized.primaryTrackingNumber).toBe('TRACK-111');
    expect(normalized.primaryCarrier).toBe('UPS');

    const update = toNormalizedOrderUpdate(normalized, new Date('2026-07-01T12:30:00Z'));
    expect(update.orderNumber).toBe('1001');
    expect(update.trackingNumber).toBe('TRACK-111');
  });

  it('handles orders with zero fulfillments safely', () => {
    const rawOrder: ShopifyOrderNode = {
      id: 'gid://shopify/Order/1002',
      name: '#1002',
      createdAt: '2026-07-01T10:00:00Z',
      updatedAt: '2026-07-01T10:00:00Z',
      displayFulfillmentStatus: 'UNFULFILLED',
      displayFinancialStatus: 'PAID',
      cancelledAt: null,
      fulfillments: [],
    };

    const normalized = normalizeShopifyOrder(rawOrder);
    expect(normalized.status).toBe('READY_FOR_FULFILLMENT');
    expect(normalized.fulfillments).toEqual([]);
    expect(normalized.primaryTrackingNumber).toBeUndefined();
  });
});
