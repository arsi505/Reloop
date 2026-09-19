import * as crypto from 'crypto';
import {
  WebhookAdapter,
  WebhookEventIdentity,
  NormalizedWebhookEvent,
} from '@reloop/integration-sdk';

export class SimulatorWebhookAdapter implements WebhookAdapter {
  readonly provider = 'SIMULATOR';

  /**
   * Generates a deterministic HMAC-SHA256 signature for the given raw payload.
   */
  signPayload(rawBody: Buffer | string, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    if (Buffer.isBuffer(rawBody)) {
      hmac.update(rawBody);
    } else {
      hmac.update(rawBody, 'utf8');
    }
    return hmac.digest('hex');
  }

  /**
   * Cryptographically verifies the webhook signature using constant-time comparison.
   * Tolerates optional "sha256=" prefix.
   * Safe against wrong-length signatures, malformed encodings, and timing attacks.
   */
  verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
    if (!signature || !secret || !rawBody) {
      return false;
    }

    // Strip optional "sha256=" prefix
    const cleanedSig = signature.startsWith('sha256=')
      ? signature.slice(7).trim()
      : signature.trim();

    // HMAC-SHA256 hex is exactly 64 characters
    if (cleanedSig.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(cleanedSig)) {
      return false;
    }

    try {
      const expectedHex = this.signPayload(rawBody, secret);
      const expectedBuf = Buffer.from(expectedHex, 'utf8');
      const actualBuf = Buffer.from(cleanedSig.toLowerCase(), 'utf8');

      if (expectedBuf.length !== actualBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuf, actualBuf);
    } catch {
      return false;
    }
  }

  /**
   * Extracts the stable provider delivery identity from headers and payload.
   */
  identifyEvent(
    headers: Record<string, string | string[] | undefined>,
    payload: unknown,
  ): WebhookEventIdentity {
    const rawPayload = payload && typeof payload === 'object' ? (payload as Record<string, any>) : {};

    // Header values can be strings or array of strings
    const getHeader = (name: string): string | undefined => {
      const val = headers[name.toLowerCase()] || headers[name];
      if (Array.isArray(val)) return val[0];
      return val;
    };

    const providerEventId =
      getHeader('x-reloop-event-id') ||
      getHeader('x-simulator-event-id') ||
      rawPayload.providerEventId ||
      rawPayload.eventId ||
      rawPayload.id;

    const eventType =
      getHeader('x-reloop-event-type') ||
      getHeader('x-simulator-event-type') ||
      rawPayload.eventType ||
      rawPayload.type ||
      'UNKNOWN';

    const rawOccurredAt =
      getHeader('x-reloop-event-time') ||
      rawPayload.occurredAt ||
      rawPayload.timestamp ||
      rawPayload.created_at;

    const occurredAt = rawOccurredAt ? new Date(rawOccurredAt) : new Date();

    const orderNumber =
      rawPayload.orderNumber ||
      rawPayload.order_number ||
      rawPayload.data?.orderNumber ||
      rawPayload.data?.order_number;

    const externalOrderId =
      rawPayload.externalOrderId ||
      rawPayload.external_order_id ||
      rawPayload.data?.externalOrderId;

    return {
      providerEventId: String(providerEventId || ''),
      eventType: String(eventType),
      occurredAt: isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
      orderNumber: orderNumber ? String(orderNumber) : undefined,
      externalOrderId: externalOrderId ? String(externalOrderId) : undefined,
    };
  }

  /**
   * Normalizes the provider-specific payload into standard Reloop internal shapes.
   * Throws if the required structure is invalid (malformed payload).
   */
  normalize(payload: unknown, eventType: string): NormalizedWebhookEvent | null {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Malformed webhook payload: expected JSON object');
    }

    const data = payload as Record<string, any>;
    const identity = this.identifyEvent({}, data);
    identity.eventType = eventType;

    const normalizedType = eventType.toUpperCase().replace(/[./-]/g, '_');

    // 1. ORDER updates
    if (
      normalizedType === 'ORDER_CREATED' ||
      normalizedType === 'ORDER_UPDATED' ||
      normalizedType === 'ORDERS_CREATE' ||
      normalizedType === 'ORDERS_UPDATE'
    ) {
      const orderNumber =
        data.orderNumber || data.order_number || data.data?.orderNumber;
      if (!orderNumber || typeof orderNumber !== 'string') {
        throw new Error('Malformed order webhook payload: missing valid orderNumber');
      }

      return {
        identity,
        domain: {
          type: 'ORDER',
          data: {
            orderNumber,
            externalOrderId: data.externalOrderId || data.external_order_id || data.id,
            status: data.status || data.financial_status || 'PENDING',
            customerReference: data.customerReference || data.customer_reference || data.email,
            currency: data.currency || 'USD',
            totalAmount: data.totalAmount ? Number(data.totalAmount) : undefined,
            trackingNumber: data.trackingNumber || data.tracking_number,
            carrier: data.carrier,
            lineItems: Array.isArray(data.lineItems)
              ? data.lineItems.map((item: any) => ({
                  sku: item.sku || 'UNKNOWN-SKU',
                  quantity: Number(item.quantity) || 1,
                  name: item.name,
                }))
              : undefined,
            sourceCreatedAt: data.createdAt ? new Date(data.createdAt) : undefined,
            occurredAt: identity.occurredAt || new Date(),
          },
        },
      };
    }

    // 2. FULFILLMENT updates
    if (
      normalizedType === 'FULFILLMENT_UPDATED' ||
      normalizedType === 'FULFILLMENTS_UPDATE' ||
      normalizedType === 'FULFILLMENTS_CREATE'
    ) {
      const orderNumber =
        data.orderNumber || data.order_number || data.data?.orderNumber;
      if (!orderNumber || typeof orderNumber !== 'string') {
        throw new Error('Malformed fulfillment webhook payload: missing valid orderNumber');
      }

      return {
        identity,
        domain: {
          type: 'FULFILLMENT',
          data: {
            orderNumber,
            externalOrderId: data.externalOrderId || data.external_order_id,
            fulfillmentStatus: data.status || data.fulfillmentStatus || 'FULFILLED',
            trackingNumber: data.trackingNumber || data.tracking_number,
            carrier: data.carrier,
            occurredAt: identity.occurredAt || new Date(),
          },
        },
      };
    }

    // 3. SHIPMENT updates
    if (
      normalizedType === 'SHIPMENT_UPDATED' ||
      normalizedType === 'SHIPMENTS_UPDATE' ||
      normalizedType === 'SHIPMENTS_CREATE'
    ) {
      const orderNumber =
        data.orderNumber || data.order_number || data.data?.orderNumber;
      if (!orderNumber || typeof orderNumber !== 'string') {
        throw new Error('Malformed shipment webhook payload: missing valid orderNumber');
      }

      return {
        identity,
        domain: {
          type: 'SHIPMENT',
          data: {
            orderNumber,
            externalShipmentId: data.externalShipmentId || data.shipmentId || data.id,
            trackingNumber: data.trackingNumber || data.tracking_number || '',
            carrier: data.carrier || 'Standard',
            shipmentStatus: data.status || 'SHIPPED',
            occurredAt: identity.occurredAt || new Date(),
          },
        },
      };
    }

    // 4. INVENTORY updates
    if (
      normalizedType === 'INVENTORY_UPDATED' ||
      normalizedType === 'INVENTORY_LEVELS_SET'
    ) {
      const sku = data.sku || data.data?.sku;
      if (!sku || typeof sku !== 'string') {
        throw new Error('Malformed inventory webhook payload: missing valid sku');
      }

      return {
        identity,
        domain: {
          type: 'INVENTORY',
          data: {
            sku,
            quantity: Number(data.quantity) || 0,
            locationId: data.locationId || data.location_id,
            occurredAt: identity.occurredAt || new Date(),
          },
        },
      };
    }

    // Unsupported/ignored event types return null safely without throwing
    return null;
  }
}
