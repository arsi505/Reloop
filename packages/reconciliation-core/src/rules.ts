import {
  NormalizedOrderSnapshot,
  ReconciliationFinding,
  ReconcileOptions,
  ProviderErrorSnapshot,
} from './types';
import { DeterministicMatcher } from './matcher';

export class ReconciliationRules {
  /**
   * Evaluates DUPLICATE_RISK
   * Precedence: Rank 1 (Highest safety blocker)
   */
  static evaluateDuplicateRisk(
    snapshot: NormalizedOrderSnapshot,
    nowIso: string,
  ): ReconciliationFinding | null {
    const { shopify, warehouse, shipstation } = snapshot;

    // Check for multiple candidates
    const warehouseCandidates = warehouse?.candidateOrders?.length || 0;
    const shippingCandidates = shipstation?.candidateShipments?.length || 0;

    const warehouseMatch = DeterministicMatcher.matchShopifyToWarehouse(snapshot);
    const shippingMatch = DeterministicMatcher.matchShopifyToShipping(snapshot);

    const hasMultipleCandidates = warehouseCandidates > 1 || shippingCandidates > 1;
    const isAmbiguous = warehouseMatch.status === 'AMBIGUOUS' || shippingMatch.status === 'AMBIGUOUS';
    const hasConflictingOrder =
      warehouseMatch.status === 'CONFLICT' &&
      warehouseMatch.conflictingIdentifiers.some((c) => c.startsWith('externalReference') || c.startsWith('orderNumber'));

    const isDuplicateSimulatorError =
      shopify?.error?.errorCode === 'DUPLICATE_ORDER' ||
      warehouse?.error?.errorCode === 'DUPLICATE_ORDER';

    if (hasMultipleCandidates || isAmbiguous || hasConflictingOrder || isDuplicateSimulatorError) {
      const conflictingIds = [
        ...warehouseMatch.conflictingIdentifiers,
        ...shippingMatch.conflictingIdentifiers,
      ];
      const candidateCount = Math.max(warehouseCandidates, shippingCandidates, warehouseMatch.candidateCount, shippingMatch.candidateCount);

      return {
        ruleKey: 'RULE_DUPLICATE_RISK',
        category: 'DUPLICATE_RISK',
        recoveryLevel: 'BLOCK',
        orderIdentity: {
          orderNumber: snapshot.orderNumber,
          externalOrderId: snapshot.externalOrderId,
        },
        summary: `Duplicate risk detected: multiple or conflicting orders exist for order ${snapshot.orderNumber}. Automated recovery is blocked.`,
        evidence: {
          evaluatedAt: nowIso,
          systemsCompared: ['Shopify', 'Generic3PL', 'ShipStation'].filter(
            (s) => (s === 'Shopify' && shopify) || (s === 'Generic3PL' && warehouse) || (s === 'ShipStation' && shipstation),
          ),
          invariantFailed: 'EXACTLY_ONE_REMOTE_ORDER_ALLOWED',
          disagreements: {
            candidateCount: { expected: 1, observed: candidateCount },
          },
          matchedIdentifiers: [...warehouseMatch.matchedIdentifiers, ...shippingMatch.matchedIdentifiers],
          conflictingIdentifiers: conflictingIds,
          candidateCount,
          blockingReason: 'Performing automated operations could create duplicate shipments or double fulfillment.',
        },
      };
    }

    return null;
  }

  /**
   * Evaluates INVALID_ORDER_DATA
   * Precedence: Rank 2
   */
  static evaluateInvalidData(
    snapshot: NormalizedOrderSnapshot,
    nowIso: string,
  ): ReconciliationFinding | null {
    const { shopify, warehouse } = snapshot;

    const reasons: string[] = [];

    if (shopify) {
      if (shopify.addressValid === false) {
        reasons.push('Invalid delivery address flagged by system');
      }

      if (shopify.lineItems.length === 0) {
        reasons.push('Order contains zero line items');
      }

      for (const item of shopify.lineItems) {
        if (!item.sku || item.sku.trim() === '') {
          reasons.push('Line item has empty SKU');
        } else if (item.sku === 'INVALID_SKU') {
          reasons.push(`Unknown or invalid SKU: ${item.sku}`);
        }
        if (item.quantity <= 0) {
          reasons.push(`Line item ${item.sku} has non-positive quantity: ${item.quantity}`);
        }
      }

      if (shopify.error?.errorCode === 'INVALID_SKU' || shopify.error?.errorCode === 'INVALID_ADDRESS') {
        reasons.push(`Simulator business validation failed: ${shopify.error.message}`);
      }
    }

    if (warehouse?.status === 'REJECTED') {
      reasons.push(`Warehouse rejected order: ${warehouse.rejectedReason || 'Unspecified reason'}`);
    }

    if (reasons.length > 0) {
      return {
        ruleKey: 'RULE_INVALID_DATA',
        category: 'INVALID_ORDER_DATA',
        recoveryLevel: 'BLOCK',
        orderIdentity: {
          orderNumber: snapshot.orderNumber,
          externalOrderId: snapshot.externalOrderId,
        },
        summary: `Authoritative order data is invalid: ${reasons.join('; ')}. Automated recovery is blocked.`,
        evidence: {
          evaluatedAt: nowIso,
          systemsCompared: ['Shopify', 'Generic3PL'].filter(
            (s) => (s === 'Shopify' && shopify) || (s === 'Generic3PL' && warehouse),
          ),
          invariantFailed: 'ORDER_DATA_INTEGRITY_REQUIRED',
          disagreements: {
            validationErrors: { expected: 'Valid SKU and address', observed: reasons },
          },
          matchedIdentifiers: [],
          conflictingIdentifiers: reasons,
          blockingReason: 'Authoritative order data requires human correction at source before operations can resume.',
        },
      };
    }

    return null;
  }

  /**
   * Evaluates TEMPORARY_API_FAILURE
   * Precedence: Rank 3
   */
  static evaluateTemporaryFailure(
    snapshot: NormalizedOrderSnapshot,
    nowIso: string,
  ): ReconciliationFinding | null {
    const errors: ProviderErrorSnapshot[] = [];

    if (snapshot.shopify?.error?.isTransient) errors.push(snapshot.shopify.error);
    if (snapshot.warehouse?.error?.isTransient) errors.push(snapshot.warehouse.error);
    if (snapshot.shipstation?.error?.isTransient) errors.push(snapshot.shipstation.error);

    if (snapshot.inventory) {
      for (const inv of snapshot.inventory) {
        if (inv.error?.isTransient) errors.push(inv.error);
      }
    }

    if (errors.length > 0) {
      const primary = errors[0];
      const providerNames = Array.from(new Set(errors.map((e) => e.provider)));

      return {
        ruleKey: 'RULE_TEMPORARY_API_FAILURE',
        category: 'TEMPORARY_API_FAILURE',
        recoveryLevel: 'AUTO_RECOVER',
        orderIdentity: {
          orderNumber: snapshot.orderNumber,
          externalOrderId: snapshot.externalOrderId,
        },
        summary: `Temporary integration failure observed from ${providerNames.join(', ')} (${primary.errorCode || primary.statusCode || 'Transient Error'}).`,
        evidence: {
          evaluatedAt: nowIso,
          systemsCompared: providerNames,
          invariantFailed: 'INTEGRATION_AVAILABILITY',
          disagreements: {
            httpStatus: { expected: 200, observed: primary.statusCode || primary.errorCode },
          },
          matchedIdentifiers: [],
          conflictingIdentifiers: [],
          transientReason: primary.message,
          details: { errors },
        },
      };
    }

    return null;
  }

  /**
   * Evaluates INVENTORY_MISMATCH
   * Precedence: Rank 4
   */
  static evaluateInventoryMismatch(
    snapshot: NormalizedOrderSnapshot,
    nowIso: string,
  ): ReconciliationFinding | null {
    if (!snapshot.inventory || snapshot.inventory.length === 0) {
      return null;
    }

    const mismatches: { sku: string; shopify: number; warehouse: number }[] = [];

    for (const item of snapshot.inventory) {
      // Ignore if either side was unavailable or errored
      if (item.error || item.shopifyQuantity === undefined || item.warehouseQuantity === undefined) {
        continue;
      }

      if (item.shopifyQuantity !== item.warehouseQuantity) {
        mismatches.push({
          sku: item.sku,
          shopify: item.shopifyQuantity,
          warehouse: item.warehouseQuantity,
        });
      }
    }

    if (mismatches.length > 0) {
      const summaryItems = mismatches.map((m) => `${m.sku} (Shopify: ${m.shopify}, 3PL: ${m.warehouse})`).join(', ');

      return {
        ruleKey: 'RULE_INVENTORY_MISMATCH',
        category: 'INVENTORY_MISMATCH',
        recoveryLevel: 'REQUIRE_APPROVAL',
        orderIdentity: {
          orderNumber: snapshot.orderNumber,
          externalOrderId: snapshot.externalOrderId,
        },
        summary: `Inventory quantity disagreement detected for: ${summaryItems}.`,
        evidence: {
          evaluatedAt: nowIso,
          systemsCompared: ['Shopify', 'Generic3PL'],
          invariantFailed: 'CROSS_SYSTEM_INVENTORY_PARITY',
          disagreements: {
            quantities: { expected: 'Parity', observed: mismatches },
          },
          matchedIdentifiers: [],
          conflictingIdentifiers: mismatches.map((m) => `SKU:${m.sku}`),
          details: { mismatches },
        },
      };
    }

    return null;
  }

  /**
   * Evaluates SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY
   * Precedence: Rank 5
   */
  static evaluateShippedUnfulfilled(
    snapshot: NormalizedOrderSnapshot,
    nowIso: string,
  ): ReconciliationFinding | null {
    const { shopify, warehouse } = snapshot;

    if (!shopify || !warehouse) {
      return null;
    }

    // 3PL has completed shipment
    const warehouseIsShipped = warehouse.status === 'SHIPPED' || warehouse.status === 'DELIVERED';
    // Shopify remains unfulfilled or partial
    const shopifyNotFulfilled = shopify.fulfillmentStatus === 'UNFULFILLED' || shopify.fulfillmentStatus === 'PARTIAL';

    if (warehouseIsShipped && shopifyNotFulfilled) {
      const warehouseMatch = DeterministicMatcher.matchShopifyToWarehouse(snapshot);

      return {
        ruleKey: 'RULE_SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY',
        category: 'SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY',
        recoveryLevel: 'REQUIRE_APPROVAL',
        orderIdentity: {
          orderNumber: snapshot.orderNumber,
          externalOrderId: snapshot.externalOrderId,
        },
        summary: `Shipment is marked ${warehouse.status} at 3PL, but Shopify order ${shopify.orderNumber} remains ${shopify.fulfillmentStatus}.`,
        evidence: {
          evaluatedAt: nowIso,
          systemsCompared: ['Shopify', 'Generic3PL'],
          invariantFailed: 'FULFILLMENT_STATE_CONSISTENCY',
          disagreements: {
            fulfillmentStatus: {
              expected: 'FULFILLED',
              observed: `Shopify=${shopify.fulfillmentStatus}, 3PL=${warehouse.status}`,
            },
          },
          matchedIdentifiers: warehouseMatch.matchedIdentifiers,
          conflictingIdentifiers: warehouseMatch.conflictingIdentifiers,
          details: {
            warehouseStatus: warehouse.status,
            shopifyFulfillmentStatus: shopify.fulfillmentStatus,
            trackingNumber: warehouse.trackingNumber || null,
          },
        },
      };
    }

    return null;
  }

  /**
   * Evaluates TRACKING_MISSING_IN_SHOPIFY
   * Precedence: Rank 6
   */
  static evaluateMissingTracking(
    snapshot: NormalizedOrderSnapshot,
    nowIso: string,
  ): ReconciliationFinding | null {
    const { shopify, warehouse, shipstation } = snapshot;

    if (!shopify) {
      return null;
    }

    // Is tracking missing in Shopify?
    const shopifyHasTracking = Boolean(shopify.trackingNumber && shopify.trackingNumber.trim().length > 0);
    if (shopifyHasTracking) {
      return null;
    }

    // Does external tracking exist?
    const externalTracking = warehouse?.trackingNumber || shipstation?.trackingNumber;
    if (!externalTracking) {
      return null;
    }

    // Safety rule for AUTO_RECOVER eligibility:
    // Requires exact deterministic matching, 1 candidate, and zero conflicts
    const warehouseMatch = DeterministicMatcher.matchShopifyToWarehouse(snapshot);
    const shippingMatch = DeterministicMatcher.matchShopifyToShipping(snapshot);

    const matchPassed =
      (warehouse && warehouseMatch.status === 'MATCH') ||
      (shipstation && shippingMatch.status === 'MATCH');

    const hasConflict =
      warehouseMatch.status === 'CONFLICT' ||
      shippingMatch.status === 'CONFLICT' ||
      warehouseMatch.conflictingIdentifiers.length > 0 ||
      shippingMatch.conflictingIdentifiers.length > 0;

    const singleCandidate =
      warehouseMatch.candidateCount <= 1 && shippingMatch.candidateCount <= 1;

    // AUTO_RECOVER only when all required criteria strictly pass
    const isAutoRecoverEligible = matchPassed && !hasConflict && singleCandidate;
    const recoveryLevel = isAutoRecoverEligible ? 'AUTO_RECOVER' : 'REQUIRE_APPROVAL';

    return {
      ruleKey: 'RULE_TRACKING_MISSING_IN_SHOPIFY',
      category: 'TRACKING_MISSING_IN_SHOPIFY',
      recoveryLevel,
      orderIdentity: {
        orderNumber: snapshot.orderNumber,
        externalOrderId: snapshot.externalOrderId,
      },
      summary: `Tracking number ${externalTracking} exists externally, but is missing in Shopify order ${shopify.orderNumber}.`,
      evidence: {
        evaluatedAt: nowIso,
        systemsCompared: ['Shopify', warehouse ? 'Generic3PL' : 'ShipStation'],
        invariantFailed: 'TRACKING_SYNCHRONIZATION_REQUIRED',
        disagreements: {
          trackingNumber: { expected: externalTracking, observed: shopify.trackingNumber || null },
        },
        matchedIdentifiers: [...warehouseMatch.matchedIdentifiers, ...shippingMatch.matchedIdentifiers],
        conflictingIdentifiers: [...warehouseMatch.conflictingIdentifiers, ...shippingMatch.conflictingIdentifiers],
        candidateCount: Math.max(warehouseMatch.candidateCount, shippingMatch.candidateCount, 1),
        details: {
          externalTracking,
          isAutoRecoverEligible,
          policyExplanation: isAutoRecoverEligible
            ? 'Deterministic matching passed with no conflicts and exactly one candidate.'
            : 'Match was ambiguous or contained conflicting identifiers; human approval required.',
        },
      },
    };
  }

  /**
   * Evaluates ORDER_MISSING_AT_3PL
   * Precedence: Rank 7
   */
  static evaluateOrderMissingAt3PL(
    snapshot: NormalizedOrderSnapshot,
    nowIso: string,
    options?: ReconcileOptions,
  ): ReconciliationFinding | null {
    const { shopify, warehouse } = snapshot;

    // Only triggers if Shopify order exists, 3PL is healthy, but warehouse order is missing
    if (!shopify) {
      return null;
    }

    // If 3PL had a transient error, DO NOT classify as missing order (Integration Health Gating)
    if (warehouse?.error?.isTransient) {
      return null;
    }

    // If warehouse order already exists, it is not missing
    if (warehouse && warehouse.status !== 'CANCELLED') {
      return null;
    }

    // If Shopify is cancelled, it's not missing
    if (shopify.fulfillmentStatus === 'CANCELLED') {
      return null;
    }

    // Check fulfillment grace period
    const gracePeriodMs = options?.fulfillmentGracePeriodMs ?? 3_600_000; // 1h default
    const nowTime = options?.evaluationTime ? new Date(options.evaluationTime).getTime() : Date.now();
    const orderCreatedTime = new Date(shopify.createdAt).getTime();

    if (nowTime - orderCreatedTime < gracePeriodMs) {
      // Still within normal grace period
      return null;
    }

    return {
      ruleKey: 'RULE_ORDER_MISSING_AT_3PL',
      category: 'ORDER_MISSING_AT_3PL',
      recoveryLevel: 'REQUIRE_APPROVAL',
      orderIdentity: {
        orderNumber: snapshot.orderNumber,
        externalOrderId: snapshot.externalOrderId,
      },
      summary: `Shopify order ${shopify.orderNumber} exists but no corresponding order was found at 3PL warehouse.`,
      evidence: {
        evaluatedAt: nowIso,
        systemsCompared: ['Shopify', 'Generic3PL'],
        invariantFailed: 'WAREHOUSE_FULFILLMENT_PRESENCE',
        disagreements: {
          warehouseOrder: { expected: 'Active 3PL Warehouse Order', observed: null },
        },
        matchedIdentifiers: [`shopifyOrderNumber:${shopify.orderNumber}`],
        conflictingIdentifiers: [],
        details: {
          orderAgeHours: Number(((nowTime - orderCreatedTime) / 3_600_000).toFixed(2)),
          gracePeriodHours: Number((gracePeriodMs / 3_600_000).toFixed(2)),
        },
      },
    };
  }

  /**
   * Evaluates STUCK_ORDER
   * Precedence: Rank 8
   */
  static evaluateStuckOrder(
    snapshot: NormalizedOrderSnapshot,
    nowIso: string,
    options?: ReconcileOptions,
  ): ReconciliationFinding | null {
    const { warehouse } = snapshot;

    if (!warehouse) {
      return null;
    }

    // Non-terminal operational warehouse states
    const operationalStatuses = ['RECEIVED', 'PENDING_FULFILLMENT', 'PICKING', 'PACKED'];
    if (!operationalStatuses.includes(warehouse.status)) {
      return null;
    }

    const stuckThresholdMs = options?.stuckOrderThresholdMs ?? 86_400_000; // 24h default
    const nowTime = options?.evaluationTime ? new Date(options.evaluationTime).getTime() : Date.now();
    const stateUpdatedTime = new Date(warehouse.updatedAt || warehouse.createdAt).getTime();

    const elapsedMs = nowTime - stateUpdatedTime;

    if (elapsedMs > stuckThresholdMs) {
      return {
        ruleKey: 'RULE_STUCK_ORDER',
        category: 'STUCK_ORDER',
        recoveryLevel: 'AUTO_INVESTIGATE',
        orderIdentity: {
          orderNumber: snapshot.orderNumber,
          externalOrderId: snapshot.externalOrderId,
        },
        summary: `Warehouse order ${warehouse.orderNumber} has remained in status ${warehouse.status} for ${Number((elapsedMs / 3_600_000).toFixed(1))}h (threshold: ${Number((stuckThresholdMs / 3_600_000).toFixed(1))}h).`,
        evidence: {
          evaluatedAt: nowIso,
          systemsCompared: ['Generic3PL'],
          invariantFailed: 'TIMELY_ORDER_PROGRESSION',
          disagreements: {
            durationInStatusMs: { expected: `< ${stuckThresholdMs}`, observed: elapsedMs },
          },
          matchedIdentifiers: [`warehouseOrderNumber:${warehouse.orderNumber}`],
          conflictingIdentifiers: [],
          details: {
            currentStatus: warehouse.status,
            elapsedHours: Number((elapsedMs / 3_600_000).toFixed(2)),
            thresholdHours: Number((stuckThresholdMs / 3_600_000).toFixed(2)),
          },
        },
      };
    }

    return null;
  }
}
