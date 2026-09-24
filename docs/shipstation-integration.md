# Reloop ShipStation V2 Integration (Read-Only Provider)

## 1. Architectural Overview

The Reloop ShipStation Integration provides a secure, tenant-isolated, and strictly **READ-ONLY** bridge between external ShipStation accounts (API V2) and the Reloop reliability orchestration platform.

With ShipStation integrated alongside Shopify, Reloop achieves its first **two-real-provider cross-system reconciliation capability**: comparing real external commerce orders against real external fulfillment shipments.

```
       +-------------------------------------------------------+
       |                ShipStation Cloud                      |
       |  +-------------------------------------------------+  |
       |  | REST API V2: https://api.shipstation.com/v2     |  |
       |  | Auth: api-key header                            |  |
       |  +------------------------^------------------------+  |
       +---------------------------|---------------------------+
                                   | (HTTPS GET Only)
+----------------------------------|------------------------------------+
| Reloop Platform                  |                                    |
|                                  |                                    |
|  +-------------------------------+---------------------------------+  |
|  | @reloop/connector-shipstation                                    |  |
|  | - ShipStationClient (Read-Only Fence, Hardcoded Base URL)        |  |
|  | - ShipStationNormalizer (PII Safe, label_purchased!=SHIPPED)     |  |
|  | - Aes256GcmCrypto (Credential Encryption)                       |  |
|  +-------------------------------+---------------------------------+  |
|                                  |                                    |
|  +-------------------------------v---------------------------------+  |
|  | Integrations Module (NestJS)                                    |  |
|  | - POST /integrations/shipstation/connect (OWNER/ADMIN only)     |  |
|  | - POST /integrations/shipstation/:id/credentials/replace        |  |
|  | - GET  /integrations/:id/status (Safe metadata, zero secrets)  |  |
|  | - POST /integrations/:id/disconnect (Blanks stored key)        |  |
|  +-------------------------------+---------------------------------+  |
|                                  |                                    |
|  +-------------------------------v---------------------------------+  |
|  | Reloop Worker (Durable Job Processing)                          |  |
|  | - Job: SHIPSTATION_SYNC_SHIPMENTS                               |  |
|  | - Decrypts credentials in execution boundary                    |  |
|  | - Projects ExternalReference (SHIPMENT, TRACKING)               |  |
|  +-------------------------------+---------------------------------+  |
|                                  |                                    |
|  +-------------------------------v---------------------------------+  |
|  | Cross-System Reconciliation Engine                              |  |
|  | - Real Shopify Order <---> Real ShipStation Shipment            |  |
|  | - MATCH, NO_MATCH, AMBIGUOUS, CONFLICT                         |  |
|  | - Detects TRACKING_MISSING_IN_SHOPIFY authoritative tracking    |  |
|  +-----------------------------------------------------------------+  |
+-----------------------------------------------------------------------+
```

---

## 2. Authentication & Credential Management

### 2.1 API Key Header Authentication
- ShipStation API V2 uses a single HTTP request header:
  ```http
  api-key: <api_key>
  Accept: application/json
  ```
- No Basic Auth, Bearer tokens, or OAuth authorization grant flows are used for ShipStation API V2.

### 2.2 Connection Lifecycle (`POST /integrations/shipstation/connect`)
1. **RBAC Guarded**: Restricted to `OWNER` and `ADMIN` roles (`OPERATOR` and `VIEWER` receive HTTP 403 Forbidden).
2. **Pre-flight Validation**: Before persisting any data, Reloop performs a harmless read test:
   ```http
   GET https://api.shipstation.com/v2/v2/shipments?page=1&page_size=1
   ```
   - HTTP 200: Key is verified valid.
   - HTTP 401: Rejected with `UnauthorizedException('Invalid ShipStation API key')`.
   - HTTP 403: Rejected with `ForbiddenException('ShipStation API key has insufficient permissions')`.
   - HTTP 429 / 5xx: Rejected as transient failure without storing invalid state.
3. **AES-256-GCM Encryption at Rest**:
   - The verified API key is packaged into a `StoredShipStationCredential` envelope:
     ```typescript
     export interface StoredShipStationCredential {
       apiKey: string;
       keyId?: string;
       validatedAt?: string;
     }
     ```
   - Encrypted with AES-256-GCM using `INTEGRATION_ENCRYPTION_KEY` (32-byte secret) with a random 12-byte IV and 16-byte authentication tag.
   - Stored in `Integration.encryptedCredentials`. Plaintext keys are never stored in the database.
4. **Audit Logging**: Emits `SHIPSTATION_INTEGRATION_CONNECTED`.
5. **Initial Sync Enqueued**: Durable job `SHIPSTATION_SYNC_SHIPMENTS` is upserted with idempotency key `shipstation_initial_sync_${integration.id}`.

### 2.3 Safe Credential Replacement (`POST /integrations/shipstation/:id/credentials/replace`)
- Restricted to `OWNER` and `ADMIN`.
- The new API key is pre-validated against ShipStation V2 before any database changes.
- If the new key is invalid, the operation aborts immediately, leaving the existing working key intact.
- If valid, the new key is encrypted and replaces the old credential, logging `SHIPSTATION_CREDENTIALS_REPLACED`.

### 2.4 Safe Disconnect (`POST /integrations/:id/disconnect`)
- Restricted to `OWNER` and `ADMIN`.
- Sets `status: 'DISCONNECTED'`.
- Overwrites `encryptedCredentials: null`.
- Emits `SHIPSTATION_INTEGRATION_DISCONNECTED`.
- Historical recovery cases, orders, and references are retained for audit integrity.

---

## 3. Strict Read-Only Safety Boundary

Day 16 strictly adheres to zero mutations against ShipStation:
- `readCapability = true`
- `mutationCapability = false`
- Hardcoded server base URL: `https://api.shipstation.com/v2`. Arbitrary host overrides are strictly forbidden to prevent SSRF vulnerabilities.
- Explicit safety blockers on `ShipStationClient`:
  - `createShipment()` -> throws `ShipStationSafetyError`
  - `updateShipment()` -> throws `ShipStationSafetyError`
  - `voidLabel()` -> throws `ShipStationSafetyError`
  - `purchaseLabel()` -> throws `ShipStationSafetyError`
  - `cancelShipment()` -> throws `ShipStationSafetyError`
- Secret Redaction: Client automatically redacts API keys from error messages, stack traces, and logged HTTP failures.

---

## 4. Normalization & Semantic Invariants

### 4.1 `label_purchased` is NOT `SHIPPED`
A critical real-world e-commerce distinction:
- When ShipStation reports `shipment_status: 'label_purchased'`, it only means a shipping label was generated/purchased in ShipStation.
- It does **NOT** guarantee that the warehouse has packed the box, handed it to the courier, or that the carrier has scanned it.
- **Reloop Invariant**: `label_purchased` maps to `LABEL_CREATED`, strictly avoiding `SHIPPED`.
- Related `ExternalOrder` status is set to `FULFILLING`, never prematurely `SHIPPED`.

### 4.2 Status Mapping Table
| ShipStation V2 Status | Reloop Normalized Status | Order Status Impact |
|-----------------------|--------------------------|---------------------|
| `pending`             | `PENDING`                | `READY_FOR_FULFILLMENT` |
| `processing`          | `PROCESSING`             | `READY_FOR_FULFILLMENT` |
| `label_purchased`     | `LABEL_CREATED`          | `FULFILLING`        |
| `cancelled` / `voided`| `CANCELLED`              | `CANCELLED`         |
| other                 | `UNKNOWN`                | `READY_FOR_FULFILLMENT` |

### 4.3 PII Minimization
The normalizer strictly discards:
- Recipient name, company name
- Street addresses, city, postal code
- Phone numbers, email addresses
Only operational shipping metadata (order number reference, carrier code, service code, tracking number, timestamps) is preserved.

### 4.4 Authoritative Tracking Truth on Label Resources (ShipStation V2)
In ShipStation API V2:
- **Shipment (`/v2/shipments`)**: Represents order and shipping intent.
- **Label (`/v2/labels`)**: Represents the purchased shipping label.
- **Critical Semantic Invariant**: Authoritative tracking numbers originate on `Label` resources (and their `packages` array), **never** inferred merely from `shipment_status = label_purchased`.
- **Voided Label Guard**: A voided label (`voided === true` or `status === 'voided'`) must **never** supply active tracking evidence.
- **Split-Shipment & Non-Unique External Shipment ID**: In ShipStation V2, `external_shipment_id` can be shared across multiple shipments or split packages.
  - Exactly 1 logical order + exactly 1 shipment + exactly 1 non-voided tracking label -> eligible for `AUTO_RECOVER`.
  - Split shipment (multiple active tracking labels) -> strictly `REQUIRE_APPROVAL` (never `AUTO_RECOVER`).
  - Multiple shipment candidates -> strictly `DUPLICATE_RISK / BLOCK`.

---

## 5. Durable Background Sync (`SHIPSTATION_SYNC_SHIPMENTS`) & Rate Coordination

### 5.1 Provider-Wide Rate Coordination (`ShipStationRateLimiter`)
ShipStation enforces rate limits across API keys (default: ~200 requests/minute). To prevent thundering-herd spikes and repeated 429 throttling:
- **Centralized Coordination**: All HTTP read requests within a process pass through `ShipStationRateLimiter` (default singleton shared across client instances).
- **Bounded Concurrency**: Maximum concurrent requests are capped (default: 5 concurrent requests) with inter-request pacing.
- **Process-Wide 429 Backoff**: When any request receives an HTTP 429 with `Retry-After`, `rateLimiter.recordRateLimit(retryAfterSeconds)` blocks all pending and upcoming requests across the entire process until the backoff window elapses.
- **Thundering-Herd Defense**: Once the 429 backoff expires, queued callers drain in a controlled, pace-limited queue rather than overwhelming the provider with simultaneous retries.

### 5.2 Batched Label Pagination & N+1 Request Elimination
Querying labels on a per-shipment basis (`listLabels({ shipmentId })` for $N$ shipments) produces an $O(N)$ HTTP request pattern that risks 429 throttling during large sync windows (e.g. 250 shipments requiring 250 individual label calls).
- **Preferred Bulk Pre-fetch**: The sync executor pre-queries labels in bulk pages (`client.listLabels({ page, pageSize: 50, createdAtStart, createdAtEnd })`) using the sync window.
- **In-Memory Grouping by Authoritative `shipmentId`**: Retrieved labels are indexed strictly by `label.shipmentId === shipment.id`. Unrelated labels are discarded and never projected.
- **Targeted Fallback Only When Necessary**: If a shipment status indicates `LABEL_CREATED` (`label_purchased`) and no labels were present in the window pre-fetch, targeted fallback `listLabels({ shipmentId })` is queried. For `pending`, `processing`, or `cancelled` shipments, no fallback call is ever made.
- **Efficiency Gain**: For 250 shipments, provider HTTP calls drop from 255 (5 shipment pages + 250 label calls) to just 10 (5 shipment pages + 5 bulk label pages) — a 96.1% request reduction.

### 5.3 Sync Execution Lifecycle
The `ShipStationSyncJobExecutor` executes within the worker process:
1. **Tenant Verification**: Verifies `integration.organizationId === job.organizationId` and `provider === 'SHIPSTATION'`.
2. **Status Check**: Cancels gracefully if the integration is `DISCONNECTED`.
3. **Decryption**: Decrypts API key inside execution boundary.
4. **Bounded Windowing**: Queries shipments using `[modified_at_start, modified_at_end]` with a 5-minute safety overlap buffer before the durable watermark to prevent boundary misses.
5. **Bulk Label Pre-fetch**: Queries paginated labels across the time window and groups them by authoritative `shipmentId`.
6. **Out-of-Order State Fencing**: Compares `normalized.updatedAt` against `externalOrder.lastObservedAt`. Older modified timestamps never regress order status.
7. **Idempotent Projection**:
   - `ExternalReference` (`resourceType: 'SHIPMENT'`, `externalId: shipment.id`, `externalReference: shipmentNumber`).
   - `ExternalReference` (`resourceType: 'LABEL'`, `externalId: label.id`, `externalReference: JSON.stringify(...)`).
   - `ExternalReference` (`resourceType: 'TRACKING'`, `externalId: trackingNumber`, `externalReference: carrierCode`) — projected **only** when an active, non-voided label with valid tracking is present!
8. **Durable Watermark Checkpoint**:
   - Checkpoint watermark (`lastSuccessfulSyncWatermark`) is persisted in PostgreSQL `Integration.configuration`.
   - Advances **only** after successful durable processing of the window. If any step fails, the watermark is not advanced, allowing safe replay on restart.
9. **Bounded Work Units & Truthful Completion Invariant**:
   - Work units are bounded (`maxShipments`, default 250). Reaching `maxShipments` represents bounded chunk execution, **NEVER** completion of provider sync. Unconditional completion expressions (such as `|| true`) are strictly forbidden.
   - `complete = true` is reported **ONLY IF** provider reports no further pages (`page >= pages`).
   - When more provider pages remain, the executor creates a durable continuation `Job` in PostgreSQL (`shipstation_sync_continuation_${integration.id}_page_${nextPage}`).
   - Final completion (`integration.sync_completed` and `initialSyncStatus = 'COMPLETED'`) is emitted strictly on provider exhaustion.
   - **Periodic Sync Limitation**: Triggered syncs run durably to provider exhaustion via continuation jobs; periodic background cron re-sync is not yet implemented in V1 and remains an intentional current limitation.
10. **Error Classification & Rate Limiting**:
   - HTTP 429: Re-throws `JobExecutionError` with `RATE_LIMITED`, respects `Retry-After` header.
   - HTTP 5xx: Re-throws `JobExecutionError` with `TRANSIENT`, enabling automatic exponential backoff.
   - HTTP 401: Marks integration `DEGRADED`, writes `SHIPSTATION_INTEGRATION_REAUTH_REQUIRED` audit log, throws non-retryable error.

---

## 6. Cross-System Reconciliation: Real Shopify + Real ShipStation

Reloop deterministically reconciles real Shopify orders with real ShipStation shipments:

```
Real Shopify Order                           Real ShipStation Shipment + Label
  - orderNumber: "1055"                        - order_number: "1055"
  - fulfillmentStatus: "UNFULFILLED"           - shipment_status: "label_purchased"
  - trackingNumber: null                       - label: { tracking: "9400111899562537624123", voided: false }
           \                                            /
            \                                          /
             +--------------------+-------------------+
                                  |
                                  v
                    Deterministic Entity Matcher
                                  |
                   [status: MATCH, 1 candidate, 0 conflicts]
                                  |
                                  v
                    Reconciliation Rule Evaluator
                                  |
             Finding: TRACKING_MISSING_IN_SHOPIFY
             Level:   AUTO_RECOVER
             Summary: Tracking 9400111899562537624123 exists in ShipStation
                      but is missing in Shopify order 1055.
```

### 6.1 Supported Matching Scenarios
1. **`MATCH`**: Identifiers align, exactly one candidate exists, exactly one active non-voided label exists, zero conflicts. Emits `TRACKING_MISSING_IN_SHOPIFY` with `AUTO_RECOVER` eligibility.
2. **`NO_MATCH`**: Disjoint order/shipment sets.
3. **`AMBIGUOUS`**: Multiple candidate shipments found in shipping system. Emits `DUPLICATE_RISK` with `recoveryLevel: 'BLOCK'`.
4. **`CONFLICT`**: Tracking numbers between systems disagree (e.g. 3PL tracking vs ShipStation tracking) or conflicting active labels exist. Emits `CONFLICT` / `REQUIRE_APPROVAL`.
5. **Split Shipment**: Multiple active tracking labels for a single order emit `REQUIRE_APPROVAL`, never `AUTO_RECOVER`.
6. **Voided Label**: Voided labels are discarded and never supply active tracking truth.

### 6.2 Key Safety Fences
1. **ShipStation is NOT a 3PL Warehouse**:
   - `ORDER_MISSING_AT_3PL` checks inventory fulfillment systems, NOT shipping label software.
   - ShipStation orders never trigger `ORDER_MISSING_AT_3PL`.
2. **No False Shipped Alarms**:
   - `SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY` requires authoritative `SHIPPED` status.
   - ShipStation's `LABEL_CREATED` status never triggers this rule.
3. **Simulator Recovery Fence**:
   - Real ShipStation and Shopify integrations are strictly forbidden from executing simulator recovery actions. Day 13 recovery action executor refuses real providers.
