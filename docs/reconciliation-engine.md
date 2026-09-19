# Reloop Cross-System Reconciliation & Case Detection Engine

## 1. Overview & Core Mission

Reloop Day 12 establishes the deterministic cross-system reconciliation and `RecoveryCase` detection layer. The engine operates on normalized snapshots of e-commerce state across Shopify, generic 3PL warehouses, ShipStation, and inventory sources.

### Core Guarantees & Boundaries:
1. **Detection Only ("What is wrong?")**: The engine only identifies inconsistencies and registers structured incidents (`RecoveryCase`). It **never** executes recovery, updates fulfillment, creates shipments, alters inventory, cancels orders, or starts workflows.
2. **Zero Invariants Overhead**: Detection creates **ZERO** worker Jobs, **ZERO** JobAttempts, **ZERO** Approvals, and **ZERO** Workflows.
3. **Pure & Isolated Reconciliation**: The core logic in `@reloop/reconciliation-core` has zero database, zero Redis, zero HTTP, and zero network dependencies. It is 100% pure and deterministic.
4. **Safety-First Precedence**: Potentially hazardous conditions (such as duplicate risk or invalid data) take absolute priority, halting automated recovery assumptions.

---

## 2. Normalized Order Snapshot

Reconciliation receives an explainable snapshot aggregating representations across systems without exposing customer PII or credentials:

```typescript
export interface NormalizedOrderSnapshot {
  organizationId: string;
  orderNumber: string;
  externalOrderId?: string;
  shopify?: ShopifyOrderSnapshot;
  warehouse?: WarehouseOrderSnapshot;
  shipstation?: ShipStationShipmentSnapshot;
  inventory?: InventoryItemSnapshot[];
}
```

---

## 3. Deterministic Entity Matcher

Cross-system matching between Shopify and external representations (3PL and shipping) uses explicit, explainable identifier comparisons. No fuzzy or AI heuristics are employed.

The matcher returns one of four canonical match statuses:
- **`MATCH`**: Required identifiers agree (`orderNumber`, `externalReference`, line items) with zero conflicts and exactly one candidate.
- **`NO_MATCH`**: Target representation is absent.
- **`AMBIGUOUS`**: Multiple candidate representations exist (e.g. multiple warehouse orders for one Shopify order).
- **`CONFLICT`**: Identifiers explicitly disagree (e.g. external reference points to a different order, line item quantities mismatch, or conflicting tracking numbers exist).

---

## 4. Canonical Failure Categories & Policy Mapping

The 8 canonical categories in `RecoveryCaseType` map directly to the rules:

| Category | Enum (`RecoveryCaseType`) | Default Level (`RecoveryLevel`) | Matching / Safety Precedence Condition |
| :--- | :--- | :--- | :--- |
| **Duplicate Risk** | `DUPLICATE_RISK` | `BLOCK` | Multiple candidate warehouse/shipment orders for 1 order, conflicting external refs. **Highest precedence.** |
| **Invalid Data** | `INVALID_ORDER_DATA` | `BLOCK` | Unknown SKU, invalid shipping address, missing required order identifier. Blocks automated recovery. |
| **Temporary Failure** | `TEMPORARY_API_FAILURE` | `AUTO_RECOVER` | 429 rate limit, 503 unavailable, network timeout. Gates dependent missing/unfulfilled rules to avoid false positives. |
| **Inventory Mismatch** | `INVENTORY_MISMATCH` | `REQUIRE_APPROVAL` | Quantity disagreement between Shopify and warehouse. Always requires human decision. |
| **3PL Shipped / Unfulfilled** | `SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY` | `REQUIRE_APPROVAL` | Authoritative 3PL is `SHIPPED`, Shopify is `UNFULFILLED`. |
| **Missing Tracking** | `TRACKING_MISSING_IN_SHOPIFY` | `AUTO_RECOVER` | **Only** when deterministic match passes (`MATCH`), single candidate exists, and no conflicting identifier exists; otherwise `REQUIRE_APPROVAL`. |
| **Missing at 3PL** | `ORDER_MISSING_AT_3PL` | `REQUIRE_APPROVAL` | Shopify order exists, fulfillment window passed, but no warehouse order found (when 3PL is healthy). |
| **Stuck Order** | `STUCK_ORDER` | `AUTO_INVESTIGATE` | Non-terminal warehouse state (`PICKING`, `PENDING_FULFILLMENT`) exceeds deterministic operational threshold. |

---

## 5. Integration Health Gating

When an external integration encounters a transient failure (such as HTTP 503, HTTP 429, or network timeout):
- The engine flags `TEMPORARY_API_FAILURE`.
- **Gating Rule**: The engine does **not** infer missing orders or fulfillment inconsistencies from the unavailable system. For example, if a 3PL API times out, the order is **not** declared `ORDER_MISSING_AT_3PL`.

---

## 6. Deduplication & Concurrency Fencing

Repeated scans of the same unresolved issue must not flood the database with duplicate `RecoveryCase` rows.

### Deduplication Architecture:
1. **Dedupe Key**: Deterministically formulated as `${orderNumber || 'system'}:${category}`.
2. **PostgreSQL Advisory Lock**: Concurrency across racing scanner processes is serialized using:
   ```sql
   SELECT pg_advisory_xact_lock(hashtext('reloop:case:' || organizationId || ':' || dedupeKey));
   ```
3. **Active Case Reuse**: If an active (non-terminal) case already exists for this `(organizationId, dedupeKey)`, the service updates `evidence` and `summary` and returns the existing row.
4. **Incident Recurrence**: If a previously resolved or failed case recurs, it represents a new incident; a fresh `RecoveryCase` is created without mutating historical records.
5. **Tenant Isolation**: Every database operation is strictly scoped by `organizationId`.

---

## 7. Downstream Hand-off to Recovery Engine (Day 13)

Detected `RecoveryCase` rows created by the reconciliation engine are automatically discovered and scheduled by the Day 13 **Recovery Policy Router** (`RecoveryRouterScanner` and `RecoveryRouterService`):
- High-risk cases (`DUPLICATE_RISK`, `INVALID_ORDER_DATA`, `INVENTORY_MISMATCH`) transition to `BLOCKED`.
- Stuck orders transition to `INVESTIGATING` with a read-only investigation workflow.
- Missing tracking, missing orders, and unsynced fulfillments route to approval-gated or automated recovery workflows.
- Cases are only resolved upon successful post-execution verification (`VERIFY` step) confirming that authoritative state conforms to business invariants. See [recovery-engine.md](./recovery-engine.md).
