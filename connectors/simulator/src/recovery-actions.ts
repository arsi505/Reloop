import { ShopifyOrder, WarehouseOrder } from './index';

export interface UpdateTrackingParams {
  organizationId: string;
  recoveryCaseId: string;
  orderNumber: string;
  trackingNumber: string;
  carrier?: string;
}

export interface Create3PLOrderParams {
  organizationId: string;
  recoveryCaseId: string;
  orderNumber: string;
  externalReference?: string;
  customer?: { name: string; email: string };
  shippingAddress?: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  lineItems?: Array<{ sku: string; name: string; quantity: number; price: number }>;
}

export interface MarkFulfilledParams {
  organizationId: string;
  recoveryCaseId: string;
  orderNumber: string;
  trackingNumber?: string;
  carrier?: string;
}

export interface RecoveryActionResult {
  success: boolean;
  operationKey: string;
  externalId?: string;
  ambiguous?: boolean;
  error?: string;
  data?: unknown;
}

export interface SimulatorMutationAuditEntry {
  timestamp: string;
  organizationId: string;
  recoveryCaseId: string;
  operationType: 'UPDATE_TRACKING' | 'CREATE_3PL_ORDER' | 'MARK_FULFILLED';
  operationKey: string;
  callCount: number;
  result: 'SUCCESS' | 'AMBIGUOUS_TIMEOUT' | 'ERROR';
  details?: Record<string, unknown>;
}

export interface AuthoritativeOrderState {
  orderNumber: string;
  shopify?: ShopifyOrder | null;
  warehouse?: WarehouseOrder | null;
}

export interface RecoveryActionExecutor {
  updateShopifyTracking(params: UpdateTrackingParams): Promise<RecoveryActionResult>;
  create3PLOrder(params: Create3PLOrderParams): Promise<RecoveryActionResult>;
  markShopifyFulfilled(params: MarkFulfilledParams): Promise<RecoveryActionResult>;
  fetchAuthoritativeOrderState(orderNumber: string): Promise<AuthoritativeOrderState>;
  getAuditLog(): SimulatorMutationAuditEntry[];
  getMutationCount(operationKey: string): number;
  clearAuditLog(): void;
}

/**
 * Builds a stable logical operation identity for business idempotency.
 * Rule: organization + integration + operationType + logicalOperationId.
 * Attempt number MUST NOT be part of this key.
 */
export function buildLogicalOperationKey(
  organizationId: string,
  integration: string,
  operationType: string,
  logicalOperationId: string,
): string {
  return `${organizationId}:${integration}:${operationType}:${logicalOperationId}`;
}

export class SimulatorRecoveryActionAdapter implements RecoveryActionExecutor {
  private auditLog: SimulatorMutationAuditEntry[] = [];
  private mutationCounts = new Map<string, number>();

  // In-memory store fallback when HTTP simulator URL is not running
  private inMemoryShopifyOrders = new Map<string, ShopifyOrder>();
  private inMemoryWarehouseOrders = new Map<string, WarehouseOrder>();

  // Optional ambiguity hook for testing commit-then-timeout
  public simulateCommitThenTimeoutForOperations = new Set<string>();

  constructor(private readonly baseUrl?: string) {}

  /**
   * Seeds in-memory state for testing without running HTTP simulator server.
   */
  seedShopifyOrder(order: ShopifyOrder): void {
    this.inMemoryShopifyOrders.set(order.orderNumber, { ...order });
    if (order.id) this.inMemoryShopifyOrders.set(order.id, { ...order });
  }

  seedWarehouseOrder(order: WarehouseOrder): void {
    this.inMemoryWarehouseOrders.set(order.orderNumber, { ...order });
    if (order.id) this.inMemoryWarehouseOrders.set(order.id, { ...order });
    if (order.externalReference) this.inMemoryWarehouseOrders.set(order.externalReference, { ...order });
  }

  getAuditLog(): SimulatorMutationAuditEntry[] {
    return [...this.auditLog];
  }

  getMutationCount(operationKey: string): number {
    return this.mutationCounts.get(operationKey) ?? 0;
  }

  clearAuditLog(): void {
    this.auditLog = [];
    this.mutationCounts.clear();
  }

  async fetchAuthoritativeOrderState(orderNumber: string): Promise<AuthoritativeOrderState> {
    if (this.baseUrl) {
      try {
        const [shpRes, whRes] = await Promise.all([
          fetch(`${this.baseUrl}/shopify/orders/${orderNumber}`).then((r) =>
            r.ok ? ((r.json() as unknown) as ShopifyOrder) : null,
          ),
          fetch(`${this.baseUrl}/3pl/orders/search?orderNumber=${orderNumber}`).then((r) =>
            r.ok ? ((r.json() as unknown) as WarehouseOrder) : null,
          ),
        ]);
        return {
          orderNumber,
          shopify: shpRes,
          warehouse: whRes,
        };
      } catch {
        // Fallback to in-memory if network error
      }
    }

    return {
      orderNumber,
      shopify: this.inMemoryShopifyOrders.get(orderNumber) || null,
      warehouse: this.inMemoryWarehouseOrders.get(orderNumber) || null,
    };
  }

  async updateShopifyTracking(params: UpdateTrackingParams): Promise<RecoveryActionResult> {
    const { organizationId, recoveryCaseId, orderNumber, trackingNumber, carrier } = params;
    const operationKey = buildLogicalOperationKey(
      organizationId,
      'shopify',
      'UPDATE_TRACKING',
      recoveryCaseId,
    );

    const callCount = (this.mutationCounts.get(operationKey) ?? 0) + 1;
    this.mutationCounts.set(operationKey, callCount);

    const shouldSimulateTimeout = this.simulateCommitThenTimeoutForOperations.has(operationKey);

    // Apply mutation
    let updatedOrder: ShopifyOrder | null = null;
    if (this.baseUrl) {
      try {
        const res = await fetch(`${this.baseUrl}/shopify/orders/${orderNumber}/fulfill`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': operationKey,
          },
          body: JSON.stringify({
            trackingNumber,
            carrier: carrier || 'FedEx',
            fulfillmentStatus: 'FULFILLED',
          }),
        });
        if (res.ok) {
          updatedOrder = (await res.json()) as ShopifyOrder;
        }
      } catch {
        // Fallback to in-memory
      }
    }

    // In-memory update
    const existing = this.inMemoryShopifyOrders.get(orderNumber);
    if (existing) {
      existing.trackingNumber = trackingNumber;
      if (carrier) existing.carrier = carrier;
      existing.fulfillmentStatus = 'FULFILLED';
      existing.updatedAt = new Date().toISOString();
      this.inMemoryShopifyOrders.set(orderNumber, existing);
      updatedOrder = existing;
    }

    if (shouldSimulateTimeout) {
      this.auditLog.push({
        timestamp: new Date().toISOString(),
        organizationId,
        recoveryCaseId,
        operationType: 'UPDATE_TRACKING',
        operationKey,
        callCount,
        result: 'AMBIGUOUS_TIMEOUT',
        details: { orderNumber, trackingNumber },
      });
      return {
        success: false,
        ambiguous: true,
        operationKey,
        error: 'Ambiguous commit-then-timeout received from simulator',
        data: updatedOrder,
      };
    }

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      organizationId,
      recoveryCaseId,
      operationType: 'UPDATE_TRACKING',
      operationKey,
      callCount,
      result: 'SUCCESS',
      details: { orderNumber, trackingNumber },
    });

    return {
      success: true,
      operationKey,
      externalId: updatedOrder?.id,
      data: updatedOrder,
    };
  }

  async create3PLOrder(params: Create3PLOrderParams): Promise<RecoveryActionResult> {
    const {
      organizationId,
      recoveryCaseId,
      orderNumber,
      externalReference,
      customer,
      shippingAddress,
      lineItems,
    } = params;

    const operationKey = buildLogicalOperationKey(
      organizationId,
      'generic-3pl',
      'CREATE_ORDER',
      recoveryCaseId,
    );

    const callCount = (this.mutationCounts.get(operationKey) ?? 0) + 1;
    this.mutationCounts.set(operationKey, callCount);

    const shouldSimulateTimeout = this.simulateCommitThenTimeoutForOperations.has(operationKey);

    // Apply mutation to 3PL
    let createdOrder: WarehouseOrder | null = null;
    const existingByRef = externalReference
      ? this.inMemoryWarehouseOrders.get(externalReference)
      : undefined;
    const existingByNum = this.inMemoryWarehouseOrders.get(orderNumber);

    if (existingByRef || existingByNum) {
      // Idempotent hit: already exists!
      createdOrder = existingByRef || existingByNum!;
    } else {
      createdOrder = {
        id: `wh_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        orderNumber,
        externalReference: externalReference || orderNumber,
        customer: customer || { name: 'Customer', email: 'cust@example.com' },
        shippingAddress: shippingAddress || {
          street: '123 Main St',
          city: 'Anytown',
          state: 'CA',
          postalCode: '90001',
          country: 'US',
        },
        lineItems: lineItems || [{ sku: 'SKU-DEFAULT', name: 'Item', quantity: 1, price: 10 }],
        status: 'RECEIVED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.seedWarehouseOrder(createdOrder);
    }

    if (shouldSimulateTimeout) {
      this.auditLog.push({
        timestamp: new Date().toISOString(),
        organizationId,
        recoveryCaseId,
        operationType: 'CREATE_3PL_ORDER',
        operationKey,
        callCount,
        result: 'AMBIGUOUS_TIMEOUT',
        details: { orderNumber, externalReference },
      });
      return {
        success: false,
        ambiguous: true,
        operationKey,
        error: 'Ambiguous commit-then-timeout from warehouse simulator',
        data: createdOrder,
      };
    }

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      organizationId,
      recoveryCaseId,
      operationType: 'CREATE_3PL_ORDER',
      operationKey,
      callCount,
      result: 'SUCCESS',
      details: { orderNumber, externalReference },
    });

    return {
      success: true,
      operationKey,
      externalId: createdOrder.id,
      data: createdOrder,
    };
  }

  async markShopifyFulfilled(params: MarkFulfilledParams): Promise<RecoveryActionResult> {
    const { organizationId, recoveryCaseId, orderNumber, trackingNumber, carrier } = params;
    const operationKey = buildLogicalOperationKey(
      organizationId,
      'shopify',
      'MARK_FULFILLED',
      recoveryCaseId,
    );

    const callCount = (this.mutationCounts.get(operationKey) ?? 0) + 1;
    this.mutationCounts.set(operationKey, callCount);

    const shouldSimulateTimeout = this.simulateCommitThenTimeoutForOperations.has(operationKey);

    const existing = this.inMemoryShopifyOrders.get(orderNumber);
    if (existing) {
      existing.fulfillmentStatus = 'FULFILLED';
      if (trackingNumber) existing.trackingNumber = trackingNumber;
      if (carrier) existing.carrier = carrier;
      existing.updatedAt = new Date().toISOString();
      this.inMemoryShopifyOrders.set(orderNumber, existing);
    }

    if (shouldSimulateTimeout) {
      this.auditLog.push({
        timestamp: new Date().toISOString(),
        organizationId,
        recoveryCaseId,
        operationType: 'MARK_FULFILLED',
        operationKey,
        callCount,
        result: 'AMBIGUOUS_TIMEOUT',
        details: { orderNumber, trackingNumber },
      });
      return {
        success: false,
        ambiguous: true,
        operationKey,
        error: 'Ambiguous commit-then-timeout from Shopify fulfillment',
        data: existing,
      };
    }

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      organizationId,
      recoveryCaseId,
      operationType: 'MARK_FULFILLED',
      operationKey,
      callCount,
      result: 'SUCCESS',
      details: { orderNumber, trackingNumber },
    });

    return {
      success: true,
      operationKey,
      externalId: existing?.id,
      data: existing,
    };
  }
}
