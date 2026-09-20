# Reloop Operations API & Integration Health Read Model

## 1. Architectural Overview

The Reloop Operations API provides a clean, tenant-isolated, product-facing **READ MODEL** that serves frontend operational surfaces (Dashboard, Exceptions, Orders, Recoveries, Integrations) without exposing internal Prisma models, durable Job internals, provider credentials, or customer PII.

```
+-------------------------------------------------------------------------+
|                         PostgreSQL Reloop State                         |
|  [RecoveryCase] [ExternalOrder] [ExternalReference] [Workflow] [Job]    |
|  [WorkflowStep] [Approval]     [Integration]       [JobAttempt]         |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                  Product Read & Query Services (NestJS)                 |
|  - DashboardService: DB count & aggregation (zero unbounded loads)      |
|  - ExceptionsService: Filter, pagination & recursive PII sanitization   |
|  - OrdersService: Cross-system state & factual discrepancy projection   |
|  - RecoveriesService: Factual flight recorder chronological timeline    |
|  - IntegrationHealthService: Deterministic health & sync derivation     |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                     Tenant-Safe DTO Contracts                           |
|  - Zero Prisma model leakage                                            |
|  - Zero credentials, tokens, or API keys                                |
|  - Zero customer emails, phones, or street addresses                    |
|  - Consistent pagination: { items, page, pageSize, total, totalPages }  |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                    REST API Endpoints (All Strict GET)                  |
|  - GET /dashboard/summary                                               |
|  - GET /exceptions          & GET /exceptions/:id                       |
|  - GET /orders              & GET /orders/:id                           |
|  - GET /recoveries          & GET /recoveries/:id                       |
|  - GET /integrations        & GET /integrations/:id                     |
+-------------------------------------------------------------------------+
```

---

## 2. API Endpoints & Contracts

### 2.1 Dashboard Summary (`GET /dashboard/summary`)
Returns tenant-scoped aggregate metrics for the operational dashboard:
- **`openExceptionsCount`**: Total open cases (`OPEN`, `INVESTIGATING`, `READY_FOR_RECOVERY`, `AUTO_RECOVERING`, `WAITING_APPROVAL`, `RECOVERING`, `VERIFYING`).
- **`casesRequiringApprovalCount`**: Open cases requiring human review (`recoveryLevel: REQUIRE_APPROVAL` or `WAITING_APPROVAL`).
- **`blockedCasesCount`**: Cases marked `BLOCKED` or `recoveryLevel: BLOCK`.
- **`autoInvestigateCasesCount`**: Cases undergoing automated root-cause investigation.
- **`autoRecoveryCasesCount`**: Cases eligible for safe autonomous recovery.
- **`resolvedCasesCount`**: Total resolved cases.
- **`failedCasesCount`**: Terminal failed cases.
- **`recentExceptions`**: Top 5 recent exceptions with order number and problem summary.
- **`integrationHealthSummary`**: Rollup of provider health (`total`, `healthy`, `degraded`, `disconnected`, `syncing`).
- **`recentRecoveryActivity`**: Top 5 recent workflows with template and status.

### 2.2 Exceptions (`GET /exceptions` & `GET /exceptions/:id`)
- **`GET /exceptions`**:
  - Query parameters: `page`, `pageSize` (max 100), `status`, `recoveryLevel`, `type`, `provider`, `startDate`, `endDate`, `search`, `sortOrder`.
  - Consistent pagination response: `{ items: ExceptionListItemDto[], page, pageSize, total, totalPages }`.
- **`GET /exceptions/:id`**:
  - Scoped strictly to the tenant organization (returns HTTP 404 for cross-tenant IDs).
  - Sanitized evidence: Customer PII (name, email, phone, street address) is stripped; secret tokens are redacted to `[REDACTED]`.
  - Includes related order reference, source integration, latest workflow steps, and operator approval snapshot.

### 2.3 Orders (`GET /orders` & `GET /orders/:id`)
- **`GET /orders`**:
  - Unified logical order rows built from projected external orders.
  - Query parameters: `page`, `pageSize`, `status`, `provider`, `hasException`, `search`.
  - Displays order number, status, currency, total amount, connected providers, and open exception indicators.
- **`GET /orders/:id`**:
  - Presents one business order across all connected systems without flattening away disagreements:
    - **`shopifyState`**: Fulfillment status, tracking numbers, last observed timestamp.
    - **`shipstationState`**: Shipment status, tracking numbers, carrier codes, active and voided label counts.
    - **`generic3plState`**: Warehouse status and 3PL tracking.
    - **`crossSystemDiscrepancy`**: Highlights factual disagreements (e.g. `TRACKING_MISSING_IN_SHOPIFY`).

### 2.4 Recoveries (`GET /recoveries` & `GET /recoveries/:id`)
- **`GET /recoveries`**:
  - List of recovery workflows with case metadata, template key, version, status, and approval state.
- **`GET /recoveries/:id` (Flight Recorder)**:
  - Produces a 100% factual chronological timeline derived strictly from durable database records:
    1. `CASE_DETECTED` (from `RecoveryCase.detectedAt`)
    2. `WORKFLOW_CREATED` (from `Workflow.createdAt`)
    3. `WORKFLOW_STARTED` (from `Workflow.startedAt`)
    4. `STEP_STARTED` & `STEP_SUCCEEDED`/`STEP_FAILED` (from `WorkflowStep`)
    5. `APPROVAL_REQUESTED` & `APPROVAL_GRANTED`/`APPROVAL_REJECTED` (from `Approval`)
    6. `JOB_ATTEMPT_STARTED` & `JOB_ATTEMPT_SUCCEEDED`/`JOB_ATTEMPT_FAILED` (from `JobAttempt`)
    7. `WORKFLOW_SUCCEEDED`/`WORKFLOW_FAILED` (from `Workflow.completedAt`)
    8. `CASE_RESOLVED` (from `RecoveryCase.resolvedAt`)

### 2.5 Integrations (`GET /integrations` & `GET /integrations/:id`)
- **`GET /integrations`**:
  - Returns tenant-safe provider cards with provider name, status, derived health, safe identifier, and sync timestamps.
- **`GET /integrations/:id`**:
  - Returns operational detail including top 5 recent sync jobs, recent event counts, associated case counts, and safe configuration.
  - Strictly excludes credentials, access tokens, API keys, and ciphertext.

---

## 3. Deterministic Integration Health Derivation

Health is deterministically computed from authoritative durable data:

| Condition | Derived Health | Rationale |
|---|---|---|
| `Integration.status === 'DISCONNECTED'` | **`DISCONNECTED`** | User explicitly severed connection. |
| `Integration.status === 'DEGRADED'` or `'ERROR'` | **`DEGRADED`** | Credentials invalid or fatal auth error. |
| Active sync job is `RUNNING` or `CLAIMED` | **`SYNCING`** | Background worker is currently processing a sync window. |
| Latest sync job is `DEAD_LETTERED` or `FAILED` | **`DEGRADED`** | **Rule 18/19 Guard**: Connected-but-failing sync is never shown healthy. |
| `CONNECTED` and latest sync job `SUCCEEDED` (or watermark exists) | **`HEALTHY`** | Sync pipeline is functioning normally. |

### Safe Error Normalization
Errors are mapped into safe categories without exposing stack traces or provider internal payloads:
- `RATE_LIMITED`: Provider HTTP 429 backoff encountered.
- `AUTHENTICATION`: HTTP 401/403 or invalid grant.
- `PROVIDER_UNAVAILABLE`: HTTP 503/504 temporary server failure.
- `SYNC_FAILED`: General synchronization failure.

---

## 4. Security & Tenant Isolation Invariants

1. **Read-Only Scope**:
   - All operations endpoints are `GET`. Zero mutations against Shopify, ShipStation, or local business state.
   - Approvals and rejections remain strictly guarded on existing Day 11 endpoints.
2. **Strict Tenant Isolation**:
   - Every query filters by `organizationId: user.organizationId`.
   - Cross-tenant ID lookups immediately throw HTTP 404 (NotFoundException), preventing ID enumeration or existence leakage.
3. **Zero Credential Exposure**:
   - `encryptedCredentials`, `accessToken`, `refreshToken`, `apiKey`, and `passwordHash` are excluded from all DTO schemas.
   - Recursive assertions in automated E2E tests guarantee zero presence of secret markers.
4. **PII Minimization**:
   - Customer name, email, phone, and physical address are stripped from all API outputs.
5. **Role-Based Access Control (RBAC)**:
   - `OWNER`, `ADMIN`, `OPERATOR`, and `VIEWER` roles possess read access to all operations read endpoints.
