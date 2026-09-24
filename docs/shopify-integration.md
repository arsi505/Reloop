# Reloop Shopify Integration (Read-Only Provider)

## 1. Architectural Overview

The Reloop Shopify Integration provides a hardened, tenant-isolated, and strictly **READ-ONLY** bridge between external Shopify merchant stores and the Reloop reliability orchestration platform. It is the first real external provider introduced into Reloop, operating under strict zero-mutation invariants.

```
       +-------------------------------------------------------+
       |                  Shopify Cloud                        |
       |  +--------------------+      +---------------------+  |
       |  | GraphQL Admin API  |      | Webhook Delivery    |  |
       |  | Version: 2026-07   |      | X-Shopify-Hmac-SHA256|  |
       |  +---------^----------+      +----------+----------+  |
       +------------|----------------------------|-------------+
                    | (HTTPS)                    | (HTTPS POST)
                    |                            v
+-------------------|----------------------------------------------------+
| Reloop Platform   |                                                    |
|                   |                                                    |
|  +----------------+----------------+   +----------------------------+  |
|  | @reloop/connector-shopify        |   | API / Webhooks Controller  |  |
|  | - ShopifyClient (Read Only)     |   | - ShopifyWebhookAdapter    |  |
|  | - ShopifyNormalizer (PII Safe)  |   | - Signature Verification   |  |
|  | - DomainValidator (SSRF Guard)  |   | - Event Deduplication      |  |
|  | - Aes256GcmCrypto               |   +--------------+-------------+  |
|  +----------------+----------------+                  |                |
|                   |                                   |                |
|  +----------------v----------------+                  |                |
|  | Integrations Module (NestJS)    |                  |                |
|  | - ShopifyOAuthService           |                  |                |
|  | - ShopifyTokenRefreshService    |                  |                |
|  |   (pg_advisory_xact_lock fence) |                  |                |
|  | - ShopifySyncService            |                  |                |
|  +----------------+----------------+                  |                |
|                   |                                   |                |
|  +----------------v-----------------------------------v-------------+  |
|  | Database Layer (PostgreSQL)                                      |  |
|  | - Integration (encrypted_credentials JSON, shop_domain UNIQUE)   |  |
|  | - OAuthState (state UNIQUE, single-use, 10m TTL)                |  |
|  | - Job (SHOPIFY_SYNC_ORDERS, durable background sync)            |  |
|  | - IntegrationEvent (idempotency key, provider event ID)          |  |
|  | - ExternalOrder & ExternalReference (normalized order mirror)   |  |
|  +------------------------------------------------------------------+  |
+------------------------------------------------------------------------+
```

---

## 2. Authentication & Credential Management Flow

### 2.1 OAuth 2.0 Authorization Code Grant
1. **Initiation (`POST /integrations/shopify/connect`)**:
   - Authorized roles: `OWNER`, `ADMIN` only (`OPERATOR` and `VIEWER` rejected with HTTP 403 Forbidden).
   - Validates shop domain format: strict canonical `[a-zA-Z0-9][a-zA-Z0-9\\-]*\\.myshopify\\.com`.
   - Normalizes schemes/slashes: `HTTPS://STORE.MYSHOPIFY.COM/` -> `store.myshopify.com`.
   - Rejects arbitrary custom merchant domains (`example.com`, `shop.example.com`) without guessing/mapping.
   - Rejects SSRF vectors: loopback (127.0.0.1), private CIDRs (RFC 1918), link-local metadata (169.254.169.254), ports, paths, userinfo (`@`).
   - Enforces cross-tenant store connection uniqueness and tenant ownership immutability: shop domains cannot be linked to multiple organizations. If an integration already exists for another organization (regardless of whether status is CONNECTED, DISCONNECTED, DEGRADED, or ERROR), initiation is rejected with HTTP 409 Conflict ('This Shopify store is already associated with another organization.').
   - Generates cryptographically secure 32-byte state parameter (`crypto.randomBytes(32).toString('hex')`).
   - Persists state in `OAuthState` with 10-minute expiry and links to initiating user and organization.
   - Returns authorization URL directed to Shopify Admin OAuth:
     `https://{shop}/admin/oauth/authorize?client_id={clientId}&scope={scopes}&redirect_uri={redirectUri}&state={state}`.

2. **Callback Handling (`GET /integrations/shopify/callback`)**:
   - Verifies Shopify callback HMAC parameter in constant time (`crypto.timingSafeEqual`) using client secret over lexicographically sorted query parameters.
   - Atomically consumes `OAuthState` (enforcing single-use replay protection via conditional update).
   - Validates state expiration (10-minute TTL) and shop domain match.
   - Exchanges authorization code with Shopify OAuth endpoint `https://{shop}/admin/oauth/access_token` explicitly sending `expiring=1` alongside `client_id`, `client_secret`, and `code`.
   - Validates that granted scopes satisfy required read scopes (minimized strictly to `read_orders`).
   - Invokes GraphQL Admin API `query { shop { id name myshopifyDomain primaryDomain { url } } }` to verify identity and match against expected domain.
   - Computes lifecycle timestamps from response metadata (`expires_in` -> `accessTokenExpiresAt`, `refresh_token_expires_in` -> `refreshTokenExpiresAt`).
   - Encrypts token envelope using AES-256-GCM before writing to PostgreSQL.
   - Enforces immutable tenant ownership: if an integration for the shop domain already exists under the same organization, it updates credentials and status to `CONNECTED` without modifying `organizationId`; if an integration exists under another organization, callback rejects with HTTP 409 Conflict; concurrent creation races are handled safely via database unique constraint (`shopDomain`).
   - Enqueues a durable `Job` (`type: 'SHOPIFY_SYNC_ORDERS'`, `status: 'QUEUED'`).
   - Records an immutable `AuditLog` entry for `SHOPIFY_INTEGRATION_CONNECTED`.
   - Returns HTTP 200 immediately without in-memory fire-and-forget promises.

### 2.2 Concurrency-Fenced Token Refresh
Shopify offline access tokens with expiration are refreshed automatically when within 5 minutes of expiration:
1. **PostgreSQL Transactional Advisory Lock (`pg_advisory_xact_lock`)**:
   - Refresh uses a 64-bit integer hash of the integration ID (`crc32(integrationId)`) passed to `pg_advisory_xact_lock($1)`.
   - Guarantees that even with multiple worker or API instances attempting refresh simultaneously, exactly one process executes the refresh network call.
2. **Double-Check Pattern**:
   - Once the advisory lock is acquired inside the transaction, the integration credentials are re-read from the database.
   - If another process already refreshed the token while this process was waiting for the lock, the freshly updated token is returned immediately without issuing a redundant Shopify exchange call.
3. **Error Classification & Safe Retries**:
   - Transient errors (HTTP 429, 500, 502, 503, 504, network timeouts) do NOT destroy the stored refresh token; retries with the existing refresh token remain safe.
   - Permanent errors (HTTP 400 with `invalid_grant`, HTTP 401 Unauthorized): integration status is automatically transitioned to `DEGRADED` (reconnect required), and an `AuditLog` entry is emitted.

---

## 3. Security Model

### 3.1 AES-256-GCM Envelope Encryption
- Master key is configured via `INTEGRATION_ENCRYPTION_KEY` as a 64-character hexadecimal string (32 bytes / 256 bits).
- Ciphertext format:
  ```json
  {
    "version": 1,
    "iv": "<base64 12-byte initialization vector>",
    "tag": "<base64 16-byte authentication tag>",
    "ciphertext": "<base64 ciphertext>",
    "keyId": "primary"
  }
  ```
- Uses a unique 12-byte IV for every single encryption operation (`crypto.randomBytes(12)`).
- Integrity and authenticity verified via 16-byte GCM authentication tag. Any tampering triggers immediate authentication error.

### 3.2 Zero Credential Exposure Guarantee
- Plaintext access tokens, refresh tokens, and encryption envelopes are NEVER stored unencrypted.
- Integration status endpoint (`GET /integrations/:id/status`) strictly strips `encryptedCredentials` and returns only public metadata (status, mode, shopDomain, scopes, lastSyncAt).
- Loggers, exception filters, and audit logs filter and sanitize all credential fields.
- Automated tests verify zero token leakage in API responses and database queries.

### 3.3 Strict Tenant Isolation & RBAC
- All integration queries enforce `organizationId: user.organizationId` filters.
- Initiating connection or disconnecting requires `OWNER` or `ADMIN` roles.
- Status inspection is permitted for `OWNER`, `ADMIN`, `OPERATOR`, `VIEWER` within their tenant boundary. Cross-tenant access is blocked with HTTP 404/403.

---

## 4. Read-Only Guarantees

Day 15 enforces an inviolable boundary: Shopify is strictly a **READ-ONLY** data provider.
1. **Client Hardcoding**:
   `ShopifyClient` exposes `readCapability: true` and `mutationCapability: false`. It exposes zero GraphQL mutation execution methods (`fulfillmentCreate`, `orderUpdate`, `inventoryAdjust`, etc. do not exist in the codebase).
2. **Day 13 Recovery Isolation**:
   Recovery workflows from Day 13 remain backed purely by the internal simulator (`@reloop/connector-simulator`). Real Shopify orders are never subjected to automated write operations or simulated write operations.
3. **Integration Mode**:
   Integration mode defaults to `OBSERVE`. Write execution flags are disabled.

---

## 5. Scope Minimization

Reloop requests strictly minimal scopes matching implemented features:
- `read_orders`: Required for reading order numbers, financial status, fulfillment status, line items, and fulfillment tracking info via GraphQL `orders` query.
- `read_inventory`: **REMOVED** (not requested, no inventory read endpoints in Day 15).
- `read_locations`: **REMOVED** (not requested, no location read endpoints in Day 15).
- `read_all_orders`: **NOT REQUESTED**.
- `write_*`: **ZERO write scopes requested**.

---

---

## 6. Durable Initial Sync & Crash-Recovery

Initial sync follows a durable, decoupled processing pipeline:
1. **Durable Job Enqueue (Producer)**: Upon successful OAuth callback, a `Job` with `type: 'SHOPIFY_SYNC_ORDERS'` and `status: 'QUEUED'` is committed to PostgreSQL in the same database transaction.
2. **Immediate Callback Return**: The OAuth HTTP request finishes in milliseconds and returns `{ success: true, initialSyncStatus: 'PENDING' }`. No in-memory `setImmediate`, `setTimeout`, or unbacked `Promise` is relied upon.
3. **Durable Worker Consumer**:
   - **Scheduler Scan**: The scheduler (`JobScanner`) scans PostgreSQL for `QUEUED` jobs and publishes dispatches to the Redis Stream (`reloop:jobs:stream`).
   - **Worker Claim & Execute**: The worker daemon (`WorkerService`) claims the job, creates a `JobAttempt`, transitions to `RUNNING`, and dispatches to `ShopifySyncJobExecutor`.
   - **Zero API Dependency**: The API process is **NOT** required for queued sync execution; the worker executes the job independently across process boundaries.
   - **Backup Sweep**: `ShopifySyncService.processPendingSyncJobs()` is available for administrative sweep or standalone processor recovery.
4. **Worker Crash Safety Boundaries**:
   - **Crash while CLAIMED (Before Execution)**: When a worker crashes while the job is `CLAIMED` before execution starts, after lease expiry a surviving recovery worker (`StaleMessageRecoveryService`) safely reclaims the job and executes it to completion with zero duplicate state.
   - **Crash while RUNNING**: When a worker crashes while a read sync is `RUNNING` and lease expires, generic Day 9 safety rules mark the attempt `ABANDONED` and Job `BLOCKED` to prevent ambiguous execution. Day 15 preserves this conservative safety boundary.
5. **Bounded Pagination & Truthful Completion Invariant**:
   - Work units are bounded (`maxOrders`, default 250). Reaching the cap indicates completion of the bounded work chunk, **NOT** completion of the provider sync.
   - `complete = true` is reported **ONLY IF** provider exhaustion is positively established (`hasNextPage === false`).
   - If provider records remain beyond the cap (`hasNextPage === true`), the executor enqueues a durable continuation `Job` in PostgreSQL keyed by `shopify_sync_continuation_${integration.id}_${cursor}`.
   - `integration.sync_completed` and `initialSyncStatus = 'COMPLETED'` are emitted strictly upon genuine provider exhaustion.
   - **Periodic Sync Limitation**: Reloop currently guarantees that triggered sync operations run to truthful provider exhaustion via durable continuation; automatic background cron/periodic re-sync is not yet implemented in V1 and remains an intentional current limitation.
6. **Idempotent Projection**: Orders and fulfillments are upserted idempotently by `(organizationId, externalOrderNumber)` and `(organizationId, integrationId, resourceType, externalId)`. Rereading, resuming, or replaying sync produces identical logical state without duplicates.
7. **Read-Only Capability Fence**: `ShopifySyncJobExecutor` uses GraphQL queries only, issues zero mutations, and has zero dependency or access to Day 13 simulator business mutation executor (`SimulatorRecoveryActionAdapter`).

---

## 7. Webhook Ingestion & Topic Strategy

### 7.1 Webhook Subscription Management Strategy
Shopify webhook subscriptions are **declaratively managed via Shopify App Configuration (`shopify.app.toml`)** and the Shopify Partner Dashboard.
- **Model Used**: App Configuration / `shopify.app.toml` managed.
- **Model NOT Used**: Programmatic GraphQL `webhookSubscriptionCreate` registration is intentionally not used in Day 15 to avoid dynamic runtime mutations and ensure uniform subscription across all merchant installs.

### 7.2 Exact Subscribed Topics
Reloop subscribes to and processes strictly these 6 operational topics:
- `orders/create`: Ingests newly created merchant orders into external projections.
- `orders/updated`: Updates order status, financial status, and fulfillment links.
- `fulfillments/create`: Ingests initial fulfillment creation and tracking assignment.
- `fulfillments/update`: Ingests fulfillment status changes and updated tracking numbers.
- `app/uninstalled`: Marks `Integration.status` as `DISCONNECTED` and sets `encryptedCredentials = NULL`. Late webhooks cannot reactivate.
- `app/scopes_update`: Evaluates updated granted scopes; if `read_orders` was revoked, marks `Integration.status` as `DEGRADED` and logs an audit incident.

### 7.3 Documented Shopify Webhook ACK Rules
- **At-Least-Once Delivery**: Webhook delivery is at-least-once, NOT exactly-once. Shopify will redeliver events upon network errors, timeouts, or non-2xx responses.
- **Signature Authenticity First**: All incoming webhook requests are verified via constant-time Base64 HMAC-SHA256 (`crypto.timingSafeEqual`) against the server-side Shopify App Client Secret. Invalid signatures are rejected with `401 Unauthorized` regardless of store connection status.
- **Deduplication Ordering**:
  1. Identify provider and shop domain safely.
  2. Verify raw-body HMAC signature.
  3. Extract `X-Shopify-Webhook-Id`.
  4. Check deduplication (`IntegrationEvent` lookup): If already ingested, immediately return HTTP 200 `{ status: "ignored_duplicate" }`.
  5. Check integration connection status: If `Integration.status === 'DISCONNECTED'`, safely return HTTP 200 `{ status: "ignored_disconnected" }`. No state projection, no RecoveryCase, no Workflow, no Approval, no Job, no business mutation, and no store reactivation occurs.
  6. Process lifecycle or commerce webhook: Disconnects on `app/uninstalled`, degrades on `app/scopes_update`, or enqueues targeted reconciliation on commerce events.
- **Retry Prevention**: Returning HTTP 200 `ignored_disconnected` prevents Shopify retry storms on uninstalled apps while maintaining an impenetrable disconnect fence.

---

## 8. Operational Playbooks

### 8.1 Connecting a Merchant Store
1. Merchant admin enters their canonical `store.myshopify.com` domain.
2. API validates domain, creates `OAuthState`, and returns authorization URL.
3. Merchant approves permissions (`read_orders`) in Shopify Admin.
4. Shopify redirects to `/integrations/shopify/callback`.
5. Callback validates HMAC, exchanges code with `expiring=1`, writes encrypted credentials, enqueues durable `SHOPIFY_SYNC_ORDERS` job, and returns HTTP 200 immediately.

### 8.2 Disconnecting a Store
1. Organization `OWNER` or `ADMIN` calls `POST /integrations/:id/disconnect` or merchant uninstalls the app in Shopify Admin (`app/uninstalled`).
2. API sets `Integration.status = DISCONNECTED` and overwrites `encryptedCredentials = NULL`.
3. Emits `SHOPIFY_INTEGRATION_UNINSTALLED` audit log.
4. Subsequent late webhooks from the disconnected store are verified for HMAC and safely acknowledged with HTTP 200 `{ status: "ignored_disconnected" }`, preventing retry storms while strictly preventing reactivation or state changes.
