import * as crypto from 'crypto';
import {
  WebhookAdapter,
  WebhookEventIdentity,
  NormalizedWebhookEvent,
  NormalizedOrderUpdate,
  NormalizedFulfillmentUpdate,
} from '@reloop/integration-sdk';

export class ShopifyWebhookAdapter implements WebhookAdapter {
  readonly provider = 'SHOPIFY';

  /**
   * Cryptographically verifies the Shopify HMAC-SHA256 signature against the raw request body.
   * Shopify encodes the signature in Base64.
   * Uses constant-time comparison.
   */
  verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
    if (!signature || typeof signature !== 'string' || !secret || !rawBody) {
      return false;
    }

    try {
      const trimmedSignature = signature.trim();
      const signatureBuffer = Buffer.from(trimmedSignature, 'base64');

      // SHA-256 digest is exactly 32 bytes
      if (signatureBuffer.length !== 32) {
        return false;
      }

      const expectedBuffer = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest();

      return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    target: string,
  ): string | undefined {
    const lower = target.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) {
        const val = headers[key];
        return Array.isArray(val) ? val[0] : val;
      }
    }
    return undefined;
  }

  /**
   * Identifies event metadata from Shopify webhook headers.
   */
  identifyEvent(
    headers: Record<string, string | string[] | undefined>,
    payload: unknown,
  ): WebhookEventIdentity {
    const webhookId = this.getHeader(headers, 'x-shopify-webhook-id');
    const topic = this.getHeader(headers, 'x-shopify-topic');
    const triggeredAtHeader = this.getHeader(headers, 'x-shopify-triggered-at');

    const p = (payload as Record<string, unknown>) || {};
    const providerEventId =
      webhookId ||
      (p.admin_graphql_api_id as string) ||
      (p.id !== undefined ? String(p.id) : undefined) ||
      crypto.randomUUID();
    const eventType = topic || 'UNKNOWN';
    const occurredAt = triggeredAtHeader ? new Date(triggeredAtHeader) : new Date();

    const orderNumber =
      (p.order_number !== undefined ? String(p.order_number) : undefined) ||
      (typeof p.name === 'string' ? p.name.replace(/^#/, '') : undefined) ||
      undefined;
    const externalOrderId =
      (p.admin_graphql_api_id as string) || (p.id ? `gid://shopify/Order/${p.id}` : undefined);

    return {
      providerEventId,
      eventType,
      occurredAt,
      orderNumber,
      externalOrderId,
    };
  }

  /**
   * Normalizes Shopify webhook payload into standard Reloop events.
   */
  normalize(payload: unknown, eventType: string): NormalizedWebhookEvent | null {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Malformed Shopify webhook payload: expected JSON object');
    }

    const p = payload as Record<string, unknown>;
    const occurredAt = new Date();

    const normalizedTopic = (eventType || '').toLowerCase();

    // 1. Orders topics
    if (normalizedTopic === 'orders/create' || normalizedTopic === 'orders/updated') {
      const orderNumber =
        (p.order_number !== undefined ? String(p.order_number) : undefined) ||
        (typeof p.name === 'string' ? p.name.replace(/^#/, '') : undefined) ||
        `${p.id}`;
      const externalOrderId = (p.admin_graphql_api_id as string) || `gid://shopify/Order/${p.id}`;

      let fulfillmentStatus: 'PENDING' | 'READY_FOR_FULFILLMENT' | 'FULFILLING' | 'SHIPPED' | 'CANCELLED' = 'PENDING';
      if (p.cancelled_at) {
        fulfillmentStatus = 'CANCELLED';
      } else if (p.fulfillment_status === 'fulfilled') {
        fulfillmentStatus = 'SHIPPED';
      } else if (p.fulfillment_status === 'partial') {
        fulfillmentStatus = 'FULFILLING';
      } else {
        fulfillmentStatus = 'READY_FOR_FULFILLMENT';
      }

      // Tracking info from fulfillments array if present
      let trackingNumber: string | undefined;
      let carrier: string | undefined;
      const fulfillments = p.fulfillments as Array<Record<string, unknown>> | undefined;
      if (fulfillments && Array.isArray(fulfillments) && fulfillments.length > 0) {
        const lastFulfillment = fulfillments[fulfillments.length - 1];
        const trackingNumbers = lastFulfillment.tracking_numbers as string[] | undefined;
        trackingNumber = (lastFulfillment.tracking_number as string) || (trackingNumbers && trackingNumbers[0]);
        carrier = lastFulfillment.tracking_company as string | undefined;
      }

      const rawLineItems = (p.line_items as Array<Record<string, unknown>>) || [];
      const lineItems = rawLineItems.map((item) => ({
        sku: (item.sku as string) || `NOSKU-${item.id}`,
        quantity: (item.quantity as number) || 1,
        name: (item.name as string) || (item.title as string) || undefined,
      }));

      const orderData: NormalizedOrderUpdate = {
        orderNumber,
        externalOrderId,
        status: fulfillmentStatus,
        customerReference: p.email ? 'REDACTED' : undefined,
        currency: p.currency as string | undefined,
        totalAmount: p.total_price ? parseFloat(String(p.total_price)) : undefined,
        trackingNumber,
        carrier,
        lineItems,
        sourceCreatedAt: p.created_at ? new Date(p.created_at as string) : undefined,
        occurredAt: p.updated_at ? new Date(p.updated_at as string) : occurredAt,
      };

      const providerEventId =
        (p.admin_graphql_api_id as string) || (p.id !== undefined ? String(p.id) : crypto.randomUUID());

      return {
        identity: {
          providerEventId,
          eventType,
          occurredAt: orderData.occurredAt,
          orderNumber,
          externalOrderId,
        },
        domain: {
          type: 'ORDER',
          data: orderData,
        },
      };
    }

    // 2. Fulfillments topics
    if (normalizedTopic === 'fulfillments/create' || normalizedTopic === 'fulfillments/update') {
      const orderId = p.order_id;
      const orderNumber =
        (p.order_number !== undefined ? String(p.order_number) : undefined) ||
        (orderId !== undefined ? String(orderId) : 'UNKNOWN');
      const externalOrderId = orderId ? `gid://shopify/Order/${orderId}` : undefined;

      let status: 'UNFULFILLED' | 'PARTIAL' | 'FULFILLED' | 'CANCELLED' = 'FULFILLED';
      if (p.status === 'cancelled') {
        status = 'CANCELLED';
      } else if (p.status === 'success') {
        status = 'FULFILLED';
      } else {
        status = 'PARTIAL';
      }

      const trackingNumbers = p.tracking_numbers as string[] | undefined;
      const fulfillmentData: NormalizedFulfillmentUpdate = {
        orderNumber,
        externalOrderId,
        fulfillmentStatus: status,
        trackingNumber: (p.tracking_number as string) || (trackingNumbers && trackingNumbers[0]),
        carrier: p.tracking_company as string | undefined,
        occurredAt: p.updated_at ? new Date(p.updated_at as string) : occurredAt,
      };

      return {
        identity: {
          providerEventId: (p.admin_graphql_api_id as string) || `${p.id}`,
          eventType,
          occurredAt: fulfillmentData.occurredAt,
          orderNumber,
          externalOrderId,
        },
        domain: {
          type: 'FULFILLMENT',
          data: fulfillmentData,
        },
      };
    }

    // 3. App Uninstalled or Scopes Update (handled at lifecycle layer)
    if (normalizedTopic === 'app/uninstalled' || normalizedTopic === 'app/scopes_update') {
      return null;
    }

    return null;
  }
}
