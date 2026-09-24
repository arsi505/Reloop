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
  customer: { name: string; email: string };
  shippingAddress: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  lineItems: Array<{ sku: string; name: string; quantity: number; price: number }>;
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

  // Explicit in-memory store for unit tests that construct the adapter without a URL.
  private inMemoryShopifyOrders = new Map<string, ShopifyOrder>();
  private inMemoryWarehouseOrders = new Map<string, WarehouseOrder>();

  // Optional ambiguity hook for testing commit-then-timeout
  public simulateCommitThenTimeoutForOperations = new Set<string>();

  private readonly baseUrl?: string;

  constructor(baseUrl?: string) {
    if (baseUrl) {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
          `Invalid simulator recovery URL protocol "${parsed.protocol}"; expected http: or https:`,
        );
      }
      this.baseUrl = parsed.toString().replace(/\/$/, '');
    }
  }

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
      const encodedOrderNumber = encodeURIComponent(orderNumber);
      const [shopify, warehouse] = await Promise.all([
        this.fetchOptional<ShopifyOrder>(
          `/shopify/orders/${encodedOrderNumber}`,
        ),
        this.fetchOptional<WarehouseOrder>(
          `/3pl/orders/search?orderNumber=${encodedOrderNumber}`,
        ),
      ]);
      return { orderNumber, shopify, warehouse };
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
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/shopify/orders/${encodeURIComponent(orderNumber)}/fulfill`, {
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
      } catch (error: unknown) {
        return this.recordError(
          params,
          'UPDATE_TRACKING',
          operationKey,
          callCount,
          `Simulator Shopify update request failed: ${this.errorMessage(error)}`,
        );
      }

      if (!response.ok) {
        const code = await this.readErrorCode(response);
        if (code === 'COMMIT_THEN_TIMEOUT') {
          return this.recordAmbiguous(
            params,
            'UPDATE_TRACKING',
            operationKey,
            callCount,
            'Ambiguous commit-then-timeout received from simulator',
          );
        }
        return this.recordError(
          params,
          'UPDATE_TRACKING',
          operationKey,
          callCount,
          `Simulator Shopify update failed with HTTP ${response.status}`,
        );
      }

      updatedOrder = (await response.json()) as ShopifyOrder;
    } else {
      // Explicit unit-test-only in-memory mode.
      const existing = this.inMemoryShopifyOrders.get(orderNumber);
      if (existing) {
        existing.trackingNumber = trackingNumber;
        if (carrier) existing.carrier = carrier;
        existing.fulfillmentStatus = 'FULFILLED';
        existing.updatedAt = new Date().toISOString();
        this.inMemoryShopifyOrders.set(orderNumber, existing);
        updatedOrder = existing;
      }
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
    if (this.baseUrl) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/3pl/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': operationKey,
          },
          body: JSON.stringify({
            orderNumber,
            externalReference,
            customer,
            shippingAddress,
            lineItems,
          }),
        });
      } catch (error: unknown) {
        return this.recordError(
          params,
          'CREATE_3PL_ORDER',
          operationKey,
          callCount,
          `Simulator 3PL create request failed: ${this.errorMessage(error)}`,
        );
      }

      if (!response.ok) {
        const code = await this.readErrorCode(response);
        if (code === 'COMMIT_THEN_TIMEOUT') {
          return this.recordAmbiguous(
            params,
            'CREATE_3PL_ORDER',
            operationKey,
            callCount,
            'Ambiguous commit-then-timeout from warehouse simulator',
          );
        }
        return this.recordError(
          params,
          'CREATE_3PL_ORDER',
          operationKey,
          callCount,
          `Simulator 3PL create failed with HTTP ${response.status}`,
        );
      }

      createdOrder = (await response.json()) as WarehouseOrder;
    } else {
      const existingByRef = externalReference
        ? this.inMemoryWarehouseOrders.get(externalReference)
        : undefined;
      const existingByNum = this.inMemoryWarehouseOrders.get(orderNumber);

      if (existingByRef || existingByNum) {
        createdOrder = existingByRef || existingByNum!;
      } else {
        createdOrder = {
          id: `wh_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          orderNumber,
          externalReference: externalReference || orderNumber,
          customer,
          shippingAddress,
          lineItems,
          status: 'RECEIVED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.seedWarehouseOrder(createdOrder);
      }
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
      externalId: createdOrder?.id,
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

    let updatedOrder: ShopifyOrder | null = null;
    if (this.baseUrl) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/shopify/orders/${encodeURIComponent(orderNumber)}/fulfill`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': operationKey,
          },
          body: JSON.stringify({
            trackingNumber,
            carrier,
            fulfillmentStatus: 'FULFILLED',
          }),
        });
      } catch (error: unknown) {
        return this.recordError(
          params,
          'MARK_FULFILLED',
          operationKey,
          callCount,
          `Simulator Shopify fulfillment request failed: ${this.errorMessage(error)}`,
        );
      }

      if (!response.ok) {
        const code = await this.readErrorCode(response);
        if (code === 'COMMIT_THEN_TIMEOUT') {
          return this.recordAmbiguous(
            params,
            'MARK_FULFILLED',
            operationKey,
            callCount,
            'Ambiguous commit-then-timeout from Shopify fulfillment',
          );
        }
        return this.recordError(
          params,
          'MARK_FULFILLED',
          operationKey,
          callCount,
          `Simulator Shopify fulfillment failed with HTTP ${response.status}`,
        );
      }

      updatedOrder = (await response.json()) as ShopifyOrder;
    } else {
      const existing = this.inMemoryShopifyOrders.get(orderNumber);
      if (existing) {
        existing.fulfillmentStatus = 'FULFILLED';
        if (trackingNumber) existing.trackingNumber = trackingNumber;
        if (carrier) existing.carrier = carrier;
        existing.updatedAt = new Date().toISOString();
        this.inMemoryShopifyOrders.set(orderNumber, existing);
        updatedOrder = existing;
      }
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
        data: updatedOrder,
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
      externalId: updatedOrder?.id,
      data: updatedOrder,
    };
  }

  private async fetchOptional<T>(path: string): Promise<T | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`);
    } catch (error: unknown) {
      throw new Error(
        `Simulator authoritative-state request failed for ${path}: ${this.errorMessage(error)}`,
      );
    }

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `Simulator authoritative-state request failed for ${path}: HTTP ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }

  private async readErrorCode(response: Response): Promise<string | undefined> {
    try {
      const body = (await response.json()) as {
        error?: { code?: string };
      };
      return body.error?.code;
    } catch {
      return undefined;
    }
  }

  private recordError(
    params: UpdateTrackingParams | Create3PLOrderParams | MarkFulfilledParams,
    operationType: SimulatorMutationAuditEntry['operationType'],
    operationKey: string,
    callCount: number,
    error: string,
  ): RecoveryActionResult {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      organizationId: params.organizationId,
      recoveryCaseId: params.recoveryCaseId,
      operationType,
      operationKey,
      callCount,
      result: 'ERROR',
      details: { orderNumber: params.orderNumber },
    });
    return { success: false, operationKey, error };
  }

  private recordAmbiguous(
    params: UpdateTrackingParams | Create3PLOrderParams | MarkFulfilledParams,
    operationType: SimulatorMutationAuditEntry['operationType'],
    operationKey: string,
    callCount: number,
    error: string,
  ): RecoveryActionResult {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      organizationId: params.organizationId,
      recoveryCaseId: params.recoveryCaseId,
      operationType,
      operationKey,
      callCount,
      result: 'AMBIGUOUS_TIMEOUT',
      details: { orderNumber: params.orderNumber },
    });
    return { success: false, ambiguous: true, operationKey, error };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
