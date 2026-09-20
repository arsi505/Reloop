import {
  NormalizedOrderSnapshot,
  MatchingResult,
} from './types';

/**
 * Deterministic Entity Matcher
 * Evaluates cross-system identifiers (Shopify, 3PL Warehouse, ShipStation)
 * using strict explainable rules. Zero fuzzy/AI heuristics.
 */
export class DeterministicMatcher {
  /**
   * Matches Shopify order representation against 3PL warehouse representation.
   */
  static matchShopifyToWarehouse(snapshot: NormalizedOrderSnapshot): MatchingResult {
    const { shopify, warehouse } = snapshot;

    if (!shopify || !warehouse) {
      return {
        status: 'NO_MATCH',
        matchedIdentifiers: [],
        conflictingIdentifiers: [],
        candidateCount: 0,
        candidateIds: [],
        details: 'Missing one or both system representations for comparison',
      };
    }

    // 1. Check for multiple candidate representations (Ambiguity)
    const candidateOrders = warehouse.candidateOrders || [];
    if (candidateOrders.length > 1) {
      return {
        status: 'AMBIGUOUS',
        matchedIdentifiers: [],
        conflictingIdentifiers: candidateOrders.map((c) => c.orderNumber),
        candidateCount: candidateOrders.length,
        candidateIds: candidateOrders.map((c) => c.id),
        details: `Multiple candidate warehouse orders (${candidateOrders.length}) found for logical order ${shopify.orderNumber}`,
      };
    }

    const matched: string[] = [];
    const conflicting: string[] = [];

    // 2. Order Number Agreement
    if (warehouse.orderNumber) {
      if (warehouse.orderNumber === shopify.orderNumber) {
        matched.push(`orderNumber:${shopify.orderNumber}`);
      } else {
        conflicting.push(`orderNumber: shopify=${shopify.orderNumber} vs warehouse=${warehouse.orderNumber}`);
      }
    }

    // 3. External Reference Agreement
    if (warehouse.externalReference) {
      if (warehouse.externalReference === shopify.id || warehouse.externalReference === shopify.orderNumber) {
        matched.push(`externalReference:${warehouse.externalReference}`);
      } else {
        conflicting.push(`externalReference: expected=${shopify.id} observed=${warehouse.externalReference}`);
      }
    }

    // 4. Line Items SKU & Quantity Verification
    if (shopify.lineItems.length > 0 && warehouse.lineItems.length > 0) {
      const shopifySkus = new Map(shopify.lineItems.map((i) => [i.sku, i.quantity]));
      const warehouseSkus = new Map(warehouse.lineItems.map((i) => [i.sku, i.quantity]));

      for (const [sku, qty] of shopifySkus.entries()) {
        const wQty = warehouseSkus.get(sku);
        if (wQty === undefined) {
          conflicting.push(`skuMissingInWarehouse:${sku}`);
        } else if (wQty !== qty) {
          conflicting.push(`skuQuantityMismatch:${sku}: shopify=${qty} vs warehouse=${wQty}`);
        } else {
          matched.push(`skuQuantity:${sku}=${qty}`);
        }
      }
    }

    // Determine status
    if (conflicting.length > 0) {
      return {
        status: 'CONFLICT',
        matchedIdentifiers: matched,
        conflictingIdentifiers: conflicting,
        candidateCount: 1,
        candidateIds: [warehouse.id],
        details: `Disagreements found between Shopify and warehouse: ${conflicting.join(', ')}`,
      };
    }

    if (matched.length > 0) {
      return {
        status: 'MATCH',
        matchedIdentifiers: matched,
        conflictingIdentifiers: [],
        candidateCount: 1,
        candidateIds: [warehouse.id],
        details: 'Configured identifiers matched and no conflicts detected',
      };
    }

    return {
      status: 'NO_MATCH',
      matchedIdentifiers: [],
      conflictingIdentifiers: [],
      candidateCount: 0,
      candidateIds: [],
      details: 'No shared identifiers found between Shopify and warehouse',
    };
  }

  /**
   * Matches Shopify order representation against ShipStation shipment representation.
   */
  static matchShopifyToShipping(snapshot: NormalizedOrderSnapshot): MatchingResult {
    const { shopify, shipstation, warehouse } = snapshot;

    if (!shopify || !shipstation) {
      return {
        status: 'NO_MATCH',
        matchedIdentifiers: [],
        conflictingIdentifiers: [],
        candidateCount: 0,
        candidateIds: [],
        details: 'Missing one or both system representations for comparison',
      };
    }

    // 1. Check for multiple candidate shipment representations (Ambiguity / Duplicate Risk)
    const candidateShipments = shipstation.candidateShipments || [];
    if (candidateShipments.length > 1) {
      const candidateTrackings = candidateShipments
        .map((s) => s.trackingNumber)
        .filter(Boolean) as string[];
      const uniqueCandidateTrackings = Array.from(new Set(candidateTrackings));

      // If candidates have conflicting tracking numbers under the same order/externalShipmentId:
      if (uniqueCandidateTrackings.length > 1) {
        return {
          status: 'CONFLICT',
          matchedIdentifiers: [],
          conflictingIdentifiers: uniqueCandidateTrackings.map((t) => `trackingConflict:${t}`),
          candidateCount: candidateShipments.length,
          candidateIds: candidateShipments.map((s) => s.id),
          details: `Conflicting tracking numbers (${uniqueCandidateTrackings.join(', ')}) across ${candidateShipments.length} candidate shipments for order ${shopify.orderNumber}`,
        };
      }

      return {
        status: 'AMBIGUOUS',
        matchedIdentifiers: [],
        conflictingIdentifiers: candidateShipments.map((s) => s.trackingNumber || s.id),
        candidateCount: candidateShipments.length,
        candidateIds: candidateShipments.map((s) => s.id),
        details: `Multiple candidate shipments (${candidateShipments.length}) found in shipping system for order ${shopify.orderNumber}`,
      };
    }

    // 2. Check for conflicting active labels on the single shipment (Split shipment / conflicting tracking)
    const activeLabels = (shipstation.labels || []).filter((l) => !l.voided && Boolean(l.trackingNumber));
    const uniqueTrackingNumbers = Array.from(new Set(activeLabels.map((l) => l.trackingNumber)));
    if (uniqueTrackingNumbers.length > 1) {
      return {
        status: 'CONFLICT',
        matchedIdentifiers: [],
        conflictingIdentifiers: uniqueTrackingNumbers.map((t) => `splitShipmentTrackingConflict:${t}`),
        candidateCount: 1,
        candidateIds: [shipstation.id],
        details: `Conflicting active tracking labels (${uniqueTrackingNumbers.join(', ')}) found for shipment ${shipstation.id}`,
      };
    }

    const matched: string[] = [];
    const conflicting: string[] = [];

    // 3. Order Number Agreement
    if (shipstation.orderNumber) {
      if (shipstation.orderNumber === shopify.orderNumber) {
        matched.push(`orderNumber:${shopify.orderNumber}`);
      } else {
        conflicting.push(`orderNumber: shopify=${shopify.orderNumber} vs shipping=${shipstation.orderNumber}`);
      }
    }

    // 4. External Shipment ID Agreement (when present)
    if (shipstation.externalShipmentId) {
      if (shipstation.externalShipmentId === shopify.id || shipstation.externalShipmentId === shopify.orderNumber) {
        matched.push(`externalShipmentId:${shipstation.externalShipmentId}`);
      }
    }

    // 5. Cross-system tracking consistency with 3PL
    const shippingTracking =
      shipstation.trackingNumber || (activeLabels.length === 1 ? activeLabels[0].trackingNumber : undefined);

    if (warehouse?.trackingNumber && shippingTracking) {
      if (warehouse.trackingNumber === shippingTracking) {
        matched.push(`trackingNumber:${shippingTracking}`);
      } else {
        conflicting.push(`trackingNumberConflict: warehouse=${warehouse.trackingNumber} vs shipping=${shippingTracking}`);
      }
    }

    if (conflicting.length > 0) {
      return {
        status: 'CONFLICT',
        matchedIdentifiers: matched,
        conflictingIdentifiers: conflicting,
        candidateCount: 1,
        candidateIds: [shipstation.id],
        details: `Disagreements found between Shopify and shipping: ${conflicting.join(', ')}`,
      };
    }

    if (matched.length > 0) {
      return {
        status: 'MATCH',
        matchedIdentifiers: matched,
        conflictingIdentifiers: [],
        candidateCount: 1,
        candidateIds: [shipstation.id],
        details: 'Configured identifiers matched and no conflicts detected',
      };
    }

    return {
      status: 'NO_MATCH',
      matchedIdentifiers: [],
      conflictingIdentifiers: [],
      candidateCount: 0,
      candidateIds: [],
      details: 'No shared identifiers found between Shopify and shipping system',
    };
  }
}
