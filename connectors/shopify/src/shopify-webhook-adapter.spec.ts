import * as crypto from 'crypto';
import { ShopifyWebhookAdapter } from './shopify-webhook-adapter';

describe('Shopify Webhook Adapter (Base64 HMAC & Deduplication)', () => {
  const adapter = new ShopifyWebhookAdapter();
  const secret = 'shpss_my_shopify_app_secret_12345';
  const payload = JSON.stringify({
    id: 99887766,
    order_number: 1050,
    admin_graphql_api_id: 'gid://shopify/Order/99887766',
    fulfillment_status: 'fulfilled',
    line_items: [{ id: 1, sku: 'SKU-HOODIE-L', quantity: 1 }],
    fulfillments: [{ tracking_number: '1Z9999999999999999', tracking_company: 'UPS' }],
  });
  const rawBody = Buffer.from(payload, 'utf8');

  it('verifies valid Base64 encoded HMAC signature', () => {
    const validSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    expect(adapter.verifySignature(rawBody, validSignature, secret)).toBe(true);
  });

  it('rejects invalid signature', () => {
    const invalidSignature = Buffer.from(crypto.randomBytes(32)).toString('base64');
    expect(adapter.verifySignature(rawBody, invalidSignature, secret)).toBe(false);
  });

  it('rejects missing or wrong secret', () => {
    const validSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    expect(adapter.verifySignature(rawBody, validSignature, 'wrong_secret')).toBe(false);
    expect(adapter.verifySignature(rawBody, validSignature, '')).toBe(false);
  });

  it('rejects malformed signature safely without throwing', () => {
    expect(adapter.verifySignature(rawBody, 'not_base64!@#$', secret)).toBe(false);
    expect(adapter.verifySignature(rawBody, 'dG9vX3Nob3J0', secret)).toBe(false); // decoded length != 32
    expect(adapter.verifySignature(rawBody, '', secret)).toBe(false);
  });

  it('extracts stable deduplication identity from headers', () => {
    const headers = {
      'x-shopify-webhook-id': 'e8d19760-4966-4a69-a35a-9de78a2e57b8',
      'x-shopify-topic': 'orders/updated',
      'x-shopify-shop-domain': 'test.myshopify.com',
      'x-shopify-triggered-at': '2026-07-01T12:00:00Z',
    };

    const identity = adapter.identifyEvent(headers, JSON.parse(payload));
    expect(identity.providerEventId).toBe('e8d19760-4966-4a69-a35a-9de78a2e57b8');
    expect(identity.eventType).toBe('orders/updated');
    expect(identity.orderNumber).toBe('1050');
    expect(identity.externalOrderId).toBe('gid://shopify/Order/99887766');
  });

  it('normalizes order webhook into Reloop standard order structure', () => {
    const event = adapter.normalize(JSON.parse(payload), 'orders/updated');
    expect(event).not.toBeNull();
    expect(event?.domain.type).toBe('ORDER');
    if (event?.domain.type === 'ORDER') {
      expect(event.domain.data.orderNumber).toBe('1050');
      expect(event.domain.data.status).toBe('SHIPPED');
      expect(event.domain.data.trackingNumber).toBe('1Z9999999999999999');
      expect(event.domain.data.carrier).toBe('UPS');
      expect(event.domain.data.lineItems?.[0].sku).toBe('SKU-HOODIE-L');
    }
  });

  it('normalizes fulfillment webhook into standard fulfillment structure', () => {
    const fulfillmentPayload = {
      id: 554433,
      order_id: 99887766,
      order_number: 1050,
      status: 'success',
      tracking_number: 'TRACK-FULFILL-99',
      tracking_company: 'DHL',
    };

    const event = adapter.normalize(fulfillmentPayload, 'fulfillments/create');
    expect(event).not.toBeNull();
    expect(event?.domain.type).toBe('FULFILLMENT');
    if (event?.domain.type === 'FULFILLMENT') {
      expect(event.domain.data.orderNumber).toBe('1050');
      expect(event.domain.data.fulfillmentStatus).toBe('FULFILLED');
      expect(event.domain.data.trackingNumber).toBe('TRACK-FULFILL-99');
      expect(event.domain.data.carrier).toBe('DHL');
    }
  });
});
