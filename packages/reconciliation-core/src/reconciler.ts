import {
  NormalizedOrderSnapshot,
  ReconciliationFinding,
  ReconcileOptions,
} from './types';
import { ReconciliationRules } from './rules';

/**
 * Pure Deterministic Order Reconciler
 * Evaluates a normalized order snapshot against all 8 canonical failure rules
 * with strict safety precedence.
 * Zero database, zero redis, zero HTTP calls, zero randomness.
 */
export function reconcileOrder(
  snapshot: NormalizedOrderSnapshot,
  options?: ReconcileOptions,
): ReconciliationFinding[] {
  const nowIso = options?.evaluationTime
    ? new Date(options.evaluationTime).toISOString()
    : new Date().toISOString();

  const findings: ReconciliationFinding[] = [];

  // =========================================================================
  // RULE PRECEDENCE EVALUATION (SAFETY-FIRST PRINCIPLE)
  // =========================================================================

  // 1. DUPLICATE_RISK (BLOCK) - Highest precedence
  const duplicateRisk = ReconciliationRules.evaluateDuplicateRisk(snapshot, nowIso);
  if (duplicateRisk) {
    findings.push(duplicateRisk);
    // Duplicate risk halts further action-oriented inferences
    return findings;
  }

  // 2. INVALID_ORDER_DATA (BLOCK)
  const invalidData = ReconciliationRules.evaluateInvalidData(snapshot, nowIso);
  if (invalidData) {
    findings.push(invalidData);
    // Invalid data requires correction before operational rules can evaluate
    return findings;
  }

  // 3. TEMPORARY_API_FAILURE (AUTO_RECOVER)
  // Integration Health Gating: If an integration is transiently unavailable,
  // we record the temporary failure and DO NOT infer missing orders or fulfillment mismatches.
  const tempFailure = ReconciliationRules.evaluateTemporaryFailure(snapshot, nowIso);
  if (tempFailure) {
    findings.push(tempFailure);
    return findings;
  }

  // 4. INVENTORY_MISMATCH (REQUIRE_APPROVAL)
  const inventoryMismatch = ReconciliationRules.evaluateInventoryMismatch(snapshot, nowIso);
  if (inventoryMismatch) {
    findings.push(inventoryMismatch);
  }

  // 5. SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY (REQUIRE_APPROVAL)
  const shippedUnfulfilled = ReconciliationRules.evaluateShippedUnfulfilled(snapshot, nowIso);
  if (shippedUnfulfilled) {
    findings.push(shippedUnfulfilled);
  }

  // 6. TRACKING_MISSING_IN_SHOPIFY (AUTO_RECOVER or REQUIRE_APPROVAL)
  // Only evaluate if not already flagged as shipped-but-unfulfilled
  if (!shippedUnfulfilled) {
    const missingTracking = ReconciliationRules.evaluateMissingTracking(snapshot, nowIso);
    if (missingTracking) {
      findings.push(missingTracking);
    }
  }

  // 7. ORDER_MISSING_AT_3PL (REQUIRE_APPROVAL)
  const missingAt3pl = ReconciliationRules.evaluateOrderMissingAt3PL(snapshot, nowIso, options);
  if (missingAt3pl) {
    findings.push(missingAt3pl);
  }

  // 8. STUCK_ORDER (AUTO_INVESTIGATE)
  const stuckOrder = ReconciliationRules.evaluateStuckOrder(snapshot, nowIso, options);
  if (stuckOrder) {
    findings.push(stuckOrder);
  }

  return findings;
}
