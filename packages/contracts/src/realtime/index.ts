/**
 * Centralized Realtime Operations Event Contracts
 *
 * Strictly typed invalidation signals emitted after durable PostgreSQL commits.
 * Payloads carry only safe identifiers and high-level status changes.
 * Under NO circumstances should customer PII, raw evidence, credentials,
 * or full database payloads be sent over realtime channels.
 */

export type RealtimeEventType =
  | 'exception.created'
  | 'exception.updated'
  | 'recovery.created'
  | 'recovery.updated'
  | 'recovery.approval_requested'
  | 'recovery.approval_decided'
  | 'recovery.verification_updated'
  | 'integration.health_changed'
  | 'integration.sync_completed'
  | 'integration.sync_failed'
  | 'order.updated'
  | 'dashboard.changed';

export type RealtimeResourceType =
  | 'EXCEPTION'
  | 'RECOVERY'
  | 'APPROVAL'
  | 'INTEGRATION'
  | 'ORDER'
  | 'DASHBOARD';

export interface RealtimeNotification {
  /**
   * Target organization ID. Used strictly server-side for room fanout.
   */
  organizationId: string;

  /**
   * Specific event type being signalled.
   */
  eventType: RealtimeEventType;

  /**
   * Safe unique identifier of the changed entity (e.g. recoveryCaseId, exceptionId, integrationId).
   */
  resourceId?: string;

  /**
   * High-level resource classification.
   */
  resourceType?: RealtimeResourceType;

  /**
   * Safe optional order reference if the event directly affects an order.
   */
  orderId?: string;

  /**
   * Normalized status string if applicable (e.g. 'APPROVED', 'RUNNING', 'HEALTHY').
   */
  status?: string;

  /**
   * Associated provider if applicable (e.g. 'SHOPIFY', 'SHIPSTATION').
   */
  provider?: string;

  /**
   * Timestamp when the durable state change occurred (ISO-8601).
   */
  changedAt: string;

  /**
   * Optional safe human-readable category or summary for operator awareness.
   */
  reason?: string;
}

export type RealtimeConnectionStatus = 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';
