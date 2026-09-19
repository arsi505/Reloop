import * as crypto from 'crypto';
import { SimulatorWebhookAdapter } from '@reloop/connector-simulator';

describe('Day 14: Webhook Signature Verification & Adapter Unit Tests', () => {
  const adapter = new SimulatorWebhookAdapter();
  const testSecret = 'reloop_test_webhook_signing_secret_xyz123';

  describe('HMAC-SHA256 Signature Verification', () => {
    it('accepts valid HMAC-SHA256 signature', () => {
      const rawBody = Buffer.from(JSON.stringify({ test: 'hello world', count: 42 }), 'utf8');
      const signature = adapter.signPayload(rawBody, testSecret);

      const isValid = adapter.verifySignature(rawBody, signature, testSecret);
      expect(isValid).toBe(true);
    });

    it('accepts valid signature with "sha256=" prefix', () => {
      const rawBody = Buffer.from(JSON.stringify({ test: 'prefixed' }), 'utf8');
      const signature = `sha256=${adapter.signPayload(rawBody, testSecret)}`;

      const isValid = adapter.verifySignature(rawBody, signature, testSecret);
      expect(isValid).toBe(true);
    });

    it('rejects invalid signature bytes', () => {
      const rawBody = Buffer.from(JSON.stringify({ test: 'tampered payload' }), 'utf8');
      const fakeSig = crypto.randomBytes(32).toString('hex');

      const isValid = adapter.verifySignature(rawBody, fakeSig, testSecret);
      expect(isValid).toBe(false);
    });

    it('rejects empty or missing signature safely', () => {
      const rawBody = Buffer.from(JSON.stringify({ test: 'empty sig' }), 'utf8');

      expect(adapter.verifySignature(rawBody, '', testSecret)).toBe(false);
      expect(adapter.verifySignature(rawBody, null as any, testSecret)).toBe(false);
      expect(adapter.verifySignature(rawBody, undefined as any, testSecret)).toBe(false);
    });

    it('rejects wrong-length signature safely without throwing RangeError', () => {
      const rawBody = Buffer.from(JSON.stringify({ test: 'length check' }), 'utf8');

      expect(adapter.verifySignature(rawBody, 'short', testSecret)).toBe(false);
      expect(adapter.verifySignature(rawBody, 'a'.repeat(63), testSecret)).toBe(false);
      expect(adapter.verifySignature(rawBody, 'a'.repeat(65), testSecret)).toBe(false);
      expect(adapter.verifySignature(rawBody, '1234567890abcdef', testSecret)).toBe(false);
    });

    it('rejects non-hex malformed signature safely', () => {
      const rawBody = Buffer.from(JSON.stringify({ test: 'malformed hex' }), 'utf8');
      const invalidHex = 'g'.repeat(64); // 'g' is not hex

      expect(adapter.verifySignature(rawBody, invalidHex, testSecret)).toBe(false);
    });

    it('rejects signature when raw body has been altered by even one byte', () => {
      const rawBody = Buffer.from(JSON.stringify({ orderNumber: 'ORD-100', amount: 100 }), 'utf8');
      const signature = adapter.signPayload(rawBody, testSecret);

      const alteredBody = Buffer.from(JSON.stringify({ orderNumber: 'ORD-100', amount: 101 }), 'utf8');
      expect(adapter.verifySignature(alteredBody, signature, testSecret)).toBe(false);
    });
  });

  describe('Event Identification', () => {
    it('extracts identity from headers when available', () => {
      const headers = {
        'x-reloop-event-id': 'evt_hdr_123',
        'x-reloop-event-type': 'ORDER_UPDATED',
        'x-reloop-event-time': '2026-09-19T12:00:00.000Z',
      };
      const payload = {
        orderNumber: 'ORD-HDR-1',
      };

      const identity = adapter.identifyEvent(headers, payload);
      expect(identity.providerEventId).toBe('evt_hdr_123');
      expect(identity.eventType).toBe('ORDER_UPDATED');
      expect(identity.occurredAt?.toISOString()).toBe('2026-09-19T12:00:00.000Z');
      expect(identity.orderNumber).toBe('ORD-HDR-1');
    });

    it('extracts identity from payload fallback when headers missing', () => {
      const headers = {};
      const payload = {
        id: 'evt_body_456',
        type: 'SHIPMENT_UPDATED',
        orderNumber: 'ORD-BODY-2',
        timestamp: '2026-09-19T14:30:00.000Z',
      };

      const identity = adapter.identifyEvent(headers, payload);
      expect(identity.providerEventId).toBe('evt_body_456');
      expect(identity.eventType).toBe('SHIPMENT_UPDATED');
      expect(identity.occurredAt?.toISOString()).toBe('2026-09-19T14:30:00.000Z');
      expect(identity.orderNumber).toBe('ORD-BODY-2');
    });
  });

  describe('Event Normalization', () => {
    it('normalizes ORDER_CREATED payload', () => {
      const payload = {
        orderNumber: 'ORD-NORM-100',
        externalOrderId: 'ext_ord_100',
        status: 'PAID',
        currency: 'USD',
        totalAmount: 150.5,
        customerReference: 'cust@example.com',
        lineItems: [{ sku: 'SKU-A', quantity: 2, name: 'Item A' }],
      };

      const normalized = adapter.normalize(payload, 'ORDER_CREATED');
      expect(normalized).not.toBeNull();
      expect(normalized?.domain.type).toBe('ORDER');
      if (normalized?.domain.type === 'ORDER') {
        expect(normalized.domain.data.orderNumber).toBe('ORD-NORM-100');
        expect(normalized.domain.data.totalAmount).toBe(150.5);
        expect(normalized.domain.data.lineItems?.length).toBe(1);
      }
    });

    it('normalizes SHIPMENT_UPDATED payload', () => {
      const payload = {
        orderNumber: 'ORD-SHIP-200',
        externalShipmentId: 'ship_200',
        trackingNumber: 'TRK-SHIP-200',
        carrier: 'FedEx',
        status: 'SHIPPED',
      };

      const normalized = adapter.normalize(payload, 'SHIPMENT_UPDATED');
      expect(normalized).not.toBeNull();
      expect(normalized?.domain.type).toBe('SHIPMENT');
      if (normalized?.domain.type === 'SHIPMENT') {
        expect(normalized.domain.data.orderNumber).toBe('ORD-SHIP-200');
        expect(normalized.domain.data.trackingNumber).toBe('TRK-SHIP-200');
        expect(normalized.domain.data.carrier).toBe('FedEx');
      }
    });

    it('normalizes FULFILLMENT_UPDATED payload', () => {
      const payload = {
        orderNumber: 'ORD-FUL-300',
        status: 'FULFILLED',
        trackingNumber: 'TRK-FUL-300',
        carrier: 'UPS',
      };

      const normalized = adapter.normalize(payload, 'FULFILLMENT_UPDATED');
      expect(normalized).not.toBeNull();
      expect(normalized?.domain.type).toBe('FULFILLMENT');
      if (normalized?.domain.type === 'FULFILLMENT') {
        expect(normalized.domain.data.orderNumber).toBe('ORD-FUL-300');
        expect(normalized.domain.data.fulfillmentStatus).toBe('FULFILLED');
      }
    });

    it('normalizes INVENTORY_UPDATED payload', () => {
      const payload = {
        sku: 'SKU-INV-400',
        quantity: 50,
      };

      const normalized = adapter.normalize(payload, 'INVENTORY_UPDATED');
      expect(normalized).not.toBeNull();
      expect(normalized?.domain.type).toBe('INVENTORY');
      if (normalized?.domain.type === 'INVENTORY') {
        expect(normalized.domain.data.sku).toBe('SKU-INV-400');
        expect(normalized.domain.data.quantity).toBe(50);
      }
    });

    it('returns null safely for unsupported event types without throwing', () => {
      const payload = { foo: 'bar' };
      const normalized = adapter.normalize(payload, 'CUSTOM_UNSUPPORTED_EVENT');
      expect(normalized).toBeNull();
    });

    it('throws Error when order webhook missing required orderNumber (malformed payload)', () => {
      const malformed = {
        status: 'PAID',
        // missing orderNumber!
      };

      expect(() => adapter.normalize(malformed, 'ORDER_CREATED')).toThrow(/missing valid orderNumber/);
    });

    it('throws Error when payload is not an object', () => {
      expect(() => adapter.normalize(null, 'ORDER_CREATED')).toThrow(/expected JSON object/);
      expect(() => adapter.normalize('not-an-object', 'ORDER_CREATED')).toThrow(/expected JSON object/);
    });
  });
});
