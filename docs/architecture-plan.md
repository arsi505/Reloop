# Reloop Architecture Plan

> **Note**: This document defines the technical architecture for Reloop. Core authentication, multi-tenant isolation, the deterministic external simulator, the durable PostgreSQL core reliability data model, the Redis Streams job dispatch scheduler, the distributed worker engine (canonical CLAIMED -> RUNNING lifecycle, atomic claims, lease management, and execution tracing), retry classification/backoff/dead-lettering, worker crash recovery via Redis XAUTOCLAIM and PostgreSQL lease fencing, and the versioned workflow / DAG orchestration engine are fully implemented and verified.

---

## 1. Architectural Philosophy & Core Tenets

1. **Durable Source of Truth**:
   - **PostgreSQL is the durable source of truth.**
   - All business entities (Organizations, Users, Integrations, ExternalOrders, ExternalReferences, IntegrationEvents, RecoveryCases, Workflows, WorkflowSteps, Jobs, JobAttempts, Approvals, AuditLogs) are durably persisted in PostgreSQL via Prisma ORM.
2. **Coordination vs. Persistence**:
   - **Redis will be coordination infrastructure, not the authoritative business database.**
   - Redis manages ephemeral distributed locks, pub/sub communication, rate-limit counters, caching, and stream-based task dispatching. Loss of Redis cache never corrupts business state.
3. **Verified Convergence Engine**:
   - Every recovery pipeline follows strict deterministic steps:
     $$\text{CHECK} \longrightarrow \text{EXECUTE} \longrightarrow \text{VERIFY} \longrightarrow \text{RESOLVED}$$
   - HTTP 200 responses from external systems do not constitute resolution; verification read queries against the target system must confirm state convergence.
4. **Idempotency and Duplicate-Risk Controls**:
   - A logical external mutation receives a stable idempotency key derived from the organization + target integration + business operation + logical resource/action (conceptual form: `organizationId + integrationId + operationType + logicalOperationId`). The exact hash/string encoding will be decided during implementation.
   - `JobAttempt` number MUST NOT be part of the logical idempotency identity. Multiple JobAttempts for the same logical action must reuse the same idempotency key.
   - Provider idempotency headers are used when the provider supports them.
   - Reloop maintains its own durable idempotency records and checks in PostgreSQL.
   - Before retrying after an ambiguous timeout or crash, Reloop checks external state to verify whether the operation already succeeded remotely.
   - The architecture targets at-least-once job delivery with idempotent business effects (no claim of exactly-once execution).

---

## 2. Planned Technology Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend Application** | **Next.js (App Router) + TypeScript** | Server-side rendering, operational dashboard, exception triage inbox, recovery preview drawer, responsive UI. |
| **Styling & Components** | **Tailwind CSS + Lucide Icons** | Design-system compliant UI tokens, high-density data tables, accessible status badges. |
| **Backend API Service** | **NestJS + TypeScript** | Structured modular REST & WebSocket service handling domain logic, validation, authentication, and webhooks. |
| **Database & ORM** | **PostgreSQL + Prisma** | ACID-compliant relational storage, strict schema migrations, relational integrity for complex order audits. |
| **Distributed Coordination**| **Redis** | In-memory distributed locking (Redlock pattern), queue buffering, and ephemeral coordination. |
| **Distributed Execution** | **Redis Streams + Workers** | Event-driven recovery task queuing, consumer groups, worker concurrency, and resilient retry pacing. |
| **Job Scheduling** | **Dedicated Scheduler** | Cron polling for periodic state reconciliation, heartbeat probes, and stuck order sweeps. |
| **Realtime Updates** | **Socket.IO** | Bi-directional event emission to update the UI instantly when exception states or verifications progress. |
| **Automated Testing** | **Jest + Supertest** | Unit tests for recovery state machines; end-to-end API and verification tests. |
| **Containerization** | **Docker Compose** | Multi-container local orchestration (PostgreSQL, Redis, API, Web, Scheduler, Worker). |

---

## 3. Planned Monorepo Structure

The repository will be structured as a modular TypeScript monorepo:

```
Reloop/
â”œâ”€â”€ apps/
â”?  â”œâ”€â”€ web/                     # Next.js web application (Dashboard, Exception Inbox, Previews)
â”?  â”œâ”€â”€ api/                     # NestJS core backend API & Webhook Ingestion
â”?  â”œâ”€â”€ scheduler/               # Scheduled cron engine (reconciliation pollers, heartbeat sweeps)
â”?  â””â”€â”€ worker/                  # Background worker daemon consuming recovery execution jobs
â”?â”œâ”€â”€ packages/
â”?  â”œâ”€â”€ database/                # Prisma schema, client, migrations, and database seeders
â”?  â”œâ”€â”€ contracts/               # Shared TypeScript DTOs, API contracts, and event schemas
â”?  â”œâ”€â”€ workflow-core/           # Recovery state machines, verification logic, and safety rules
â”?  â””â”€â”€ integration-sdk/         # Connector interfaces, rate-limiters, and normalized order models
â”?â”œâ”€â”€ connectors/
â”?  â”œâ”€â”€ simulator/               # Mock 3PL and carrier simulator for robust local development & testing
â”?  â”œâ”€â”€ shopify/                 # Shopify Admin GraphQL/REST connector
â”?  â”œâ”€â”€ shipstation/             # ShipStation v1/v2 REST connector
â”?  â””â”€â”€ generic-3pl/             # Standardized REST/Webhook connector for 3PL warehouse systems
â”?â”œâ”€â”€ docker/
â”?  â”œâ”€â”€ docker-compose.yml       # Local development services (Postgres, Redis, app services)
â”?  â””â”€â”€ Dockerfile.*             # Individual production container definitions
â”?â”œâ”€â”€ docs/                        # Specifications, UX journeys, design system, architecture plans
â”œâ”€â”€ .gitignore                   # Repository ignore specifications
â”œâ”€â”€ LICENSE                      # MIT License
â””â”€â”€ README.md                    # Project overview and status
```

---

## 4. Execution & Data Flow Architecture

### Ingestion Flow
1. **Webhooks**: Shopify, ShipStation, or 3PL warehouse fires order/shipment webhooks to `apps/api`.
2. **Scheduled Polling**: `apps/scheduler` triggers periodic reconciliation scans via `packages/integration-sdk` to detect silent drops and stuck states.
3. **State Evaluation**: Incoming state is compared against the database. If a discrepancy matches one of the 8 canonical failure cases, an Exception record is created in PostgreSQL with status `OPEN` and assigned a Recovery Level (`AUTO_RECOVER`, `AUTO_INVESTIGATE`, `REQUIRE_APPROVAL`, `BLOCK`).

### Recovery Execution Flow
```
[Event Trigger] â”€â”€â”€â”€â”€â”€â”€â”€â–?[Ingestion / Poller]
                                â”?                                â–?                       [Exception Created]
                                â”?        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”?        â–?                                              â–?[AUTO_RECOVER / INVESTIGATE]                  [REQUIRE_APPROVAL / BLOCK]
Queued to Redis Stream worker                 UI shows Recovery Preview
        â”?                                              â”?        â–?                                              â–?[Execute Idempotent Payload]                  [Human Operator Approves]
        â”?                                              â”?        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”?                                â”?                                â–?                     [State: VERIFYING]
                                â”?                     (Independent GET query
                      across both platforms)
                                â”?               â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”?               â–?                                â–?       [State Converged]                 [State Divergent]
      State -> RESOLVED                   Retry / Escalate
```

---

## 5. Security, Tenancy & Resilience

- **Idempotency Controls**: External mutations use a stable logical idempotency key across retries to control duplicate fulfillment risk. Provider-native idempotency headers are passed when supported, durable idempotency records are maintained in PostgreSQL, and external state is checked prior to retry after ambiguous timeouts.
- **Tenant Isolation**: All queries in Prisma are scoped to `organizationId`.
- **Integration Outage Handling**: When external APIs encounter repeated 5xx errors or timeouts, Reloop marks the connector as `DEGRADED` or `DOWN`, suppresses aggressive retries across the affected connector, applies connector-wide backoff/rate limiting, periodically performs non-mutating background health checks, and resumes queued work gradually after health is restored.
- **Strict Verification Timeout**: Verification poller attempts verification with exponential intervals up to a maximum duration (e.g., 10 minutes). If state fails to converge within the window, the case transitions to `FAILED` or remains `BLOCKED` with operator notification.

---

## 6. Distributed Job Execution & Retry Engine

- **Job Dispatching**: The scheduler (`apps/scheduler`) scans eligible jobs (`QUEUED` or `RETRY_WAITING` with `next_run_at <= NOW()`) and dispatches minimal notifications (`jobId`) to Redis Streams (`reloop:jobs:ready`).
- **Atomic Claiming & Leases**: Distributed workers (`apps/worker`) claim jobs atomically via conditional PostgreSQL `UPDATE ... WHERE ... RETURNING` queries, transitioning jobs from `QUEUED` / `RETRY_WAITING` to `CLAIMED` and then `RUNNING` with an active heartbeat lease.
- **Classification & Exponential Backoff**: Failures are classified into `JobErrorCategory` types. Transient and rate-limited failures receive exponential backoff (`[30s, 2m, 10m, 30m]`) with $\pm 15\%$ uniform jitter and provider `Retry-After` precedence.
- **Dead-Letter Discipline**: When `attemptCount >= maxAttempts`, jobs transition to `DEAD_LETTERED` in PostgreSQL and Redis messages are acknowledged (`XACK`), preventing infinite reprocessing. Non-retryable permanent errors transition immediately to `FAILED`.
- **Fenced Transactions**: All failure state transitions enforce active worker ownership and unexpired lease fences, rolling back completely if ownership was lost.

---

## 7. Distributed Worker Crash & Stale PEL Recovery

- **Redis `XAUTOCLAIM` Engine**: Stale messages remaining in the consumer group Pending Entries List (PEL) past `WORKER_PEL_MIN_IDLE_MS` are discovered using Redis 7 `XAUTOCLAIM`.
- **PostgreSQL Authoritative Fencing**: Redis PEL membership conveys zero execution authority. The recovering worker rereads PostgreSQL status with row-level locks (`SELECT ... FOR UPDATE`).
- **Safe vs. Ambiguous Crash Boundary**:
  - **Expired `CLAIMED`**: Handler never began; previous attempt marked `ABANDONED` (`WORKER_LEASE_EXPIRED_BEFORE_EXECUTION`), claim transferred to recovering worker with new `STARTED` attempt, executed through pipeline to completion (or `DEAD_LETTERED` if attempts exhausted).
  - **Expired `RUNNING`**: Ambiguous crash boundary; previous attempt marked `ABANDONED` (`AMBIGUOUS_WORKER_CRASH`), job transitioned to `BLOCKED` (`completedAt = NULL`), zero re-execution, message XACKed to clean PEL.
  - **Active Leases**: Left untouched.
  - **Terminal / RETRY_WAITING**: Obsolete PEL signals are XACKed without execution.
  - **Transaction Ordering**: PostgreSQL commit is executed before Redis `XACK`. See [crash-recovery.md](./crash-recovery.md).

---

## 8. Versioned Workflow & DAG Orchestration Engine

- **Fixed Versioned Templates**: Defined in `@reloop/workflow-core`, templates are immutable definitions referenced by `(templateKey, templateVersion)`. Validated with DAG cycle detection.
- **Durable Step Execution**: Each workflow step corresponds to exactly one durable PostgreSQL `Job` (`type = 'WORKFLOW_STEP'`). Retries reuse the same Job and same `WorkflowStep`, tracking attempts via `JobAttempt`.
- **Workflow Coordinator**: Background poller in `apps/scheduler` that evaluates DAG completion, reconciles step job states, evaluates safe declarative conditions, atomicity via `ON CONFLICT DO NOTHING`, and progresses workflow state.
- **Worker Execution & Fencing**: `WorkflowStepExecutor` in `apps/worker` enforces tenant isolation, terminal workflow execution fences, and safe step state transitions (`READY -> RUNNING -> SUCCEEDED / FAILED`). See [workflow-engine.md](./workflow-engine.md).

---

## 9. Human Approval / HITL & Recovery Preview

- **Human-in-the-Loop (HITL) Execution**: Workflows support non-job \APPROVAL\ steps that halt automated progression and transition workflow and step to \WAITING\ status.
- **Zero-Job Invariant**: Approval steps NEVER create a PostgreSQL \Job\ or Redis Stream dispatch. They function strictly as database-orchestrated gates.
- **Immutable Preview Snapshot**: Paused approval steps persist a frozen \RecoveryPreview\ JSON snapshot in \Approval.previewSnapshot\ explaining the problem, proposed action, changes, non-changes, risks, and verification criteria.
- **Optimistic Fenced CAS**: Approval decisions (\APPROVED\ or \REJECTED\) execute in an atomic transaction with row locks (\SELECT FOR UPDATE\) asserting current \WAITING\ and \PENDING\ states, preventing concurrent decision races and stale revival of terminal workflows.
- **Atomic Audit Trail**: \APPROVAL_APPROVED\ or \APPROVAL_REJECTED\ audit events are persisted in the exact same transaction as the approval decision. See [approval-engine.md](./approval-engine.md).

---

## 10. Cross-System Reconciliation & Recovery Case Detection

- **Reconciliation Scope**: Evaluates normalized state snapshots across Shopify, generic 3PL, and ShipStation systems to detect operational failures without executing recovery.
- **Pure Core Engine**: Implemented in \@reloop/reconciliation-core\ with zero database, Redis, or HTTP dependencies. 100% deterministic and explainable.
- **Canonical Failure Rules**: Enforces all 8 canonical \RecoveryCaseType\ categories: \TEMPORARY_API_FAILURE\, \TRACKING_MISSING_IN_SHOPIFY\, \STUCK_ORDER\, \ORDER_MISSING_AT_3PL\, \SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY\, \INVENTORY_MISMATCH\, \DUPLICATE_RISK\, and \INVALID_ORDER_DATA\.
- **Safety Precedence & Integration Health Gating**: High-risk conditions (\DUPLICATE_RISK\, \INVALID_ORDER_DATA\) halt automated recovery. Transient API errors gate downstream rules to avoid false-positive missing order detections.
- **Deduplication & Concurrency**: Uses `dedupeKey` and PostgreSQL advisory locks to guarantee that racing detector processes resolve to exactly one active `RecoveryCase`. Reuses open cases and records distinct incidents for recurrences. See [reconciliation-engine.md](./reconciliation-engine.md).

---

## 11. Recovery Policy Router & Simulator-Backed Verified Recovery

- **Deterministic Routing**: Pure policy router evaluates detected `RecoveryCase` categories (`BLOCK`, `AUTO_INVESTIGATE`, `AUTO_RECOVER`, `REQUIRE_APPROVAL`).
- **Canonical Lifecycle Invariant**: `CHECK -> (optional APPROVAL) -> EXECUTE -> VERIFY -> RESOLVED`. No case is resolved without independent verification of authoritative state.
- **Simulator Action Adapter**: Executes safe, idempotent compensations against deterministic simulator endpoints using stable idempotency keys. Zero calls to real external APIs. Zero inventory mutations.
- **Case Resolution Guard**: `CaseResolutionService` atomically transitions cases to `RESOLVED` only when linked `VERIFY` step succeeds and confirms invariant satisfaction, preserving original detection evidence. See [recovery-engine.md](./recovery-engine.md).

---

## 12. Secure Webhook Ingestion & Event Deduplication

- **Cryptographic Verification**: Ingests provider webhooks with timing-safe HMAC-SHA256 verification using the raw request body (`req.rawBody: Buffer`).
- **Strict Tenant Derivation**: Organization authority is strictly loaded from `Integration.organizationId`, ignoring untrusted payload claims.
- **Durable Deduplication**: Uses database-enforced `@@unique([integrationId, providerEventId])` to deduplicate racing or retried deliveries before asynchronous processing.
- **Idempotent Projection & Out-of-Order Guard**: Projects events into `ExternalOrder` and `ExternalReference`, safely ignoring stale out-of-order events based on `lastObservedAt`.
- **Targeted Reconciliation**: Triggers order-specific reconciliation immediately upon state projection while preserving the periodic scanner as a safety net. Zero direct recovery actions from webhooks. See [webhook-ingestion.md](./webhook-ingestion.md).

---

## 13. Real Shopify Connection, Authentication & Read-Only State Sync

- **Strict Read-Only Guarantee**: Shopify is the first real external provider introduced into Reloop, operating under an inviolable zero-mutation invariant (`readCapability: true`, `mutationCapability: false`). Day 13 recovery workflows remain strictly simulator-only.
- **Hardened OAuth 2.0 Flow**: Supports authorization code grant with single-use `OAuthState` (10m TTL), constant-time HMAC query verification, strict SSRF domain guards (canonical `.myshopify.com` only), cross-tenant store uniqueness, and RBAC (`OWNER`/`ADMIN` only). Token exchange explicitly requests expiring offline tokens (`expiring=1`) and persists encrypted full lifecycle metadata (`accessTokenExpiresAt`, `refreshTokenExpiresAt`).
- **Scope Minimization**: Requests strictly the minimal required read scope (`read_orders` only); `read_inventory` and `read_locations` are eliminated. Zero write scopes are requested.
- **AES-256-GCM Envelope Encryption**: Access and refresh tokens are encrypted at rest using versioned envelopes (`iv`, `tag`, `ciphertext`, `keyId`) with a 256-bit master key. Zero plaintext tokens exist in the database, logs, or API responses.
- **Advisory-Locked Token Refresh**: Automated token refresh uses PostgreSQL transactional advisory locks (`pg_advisory_xact_lock`) to serialize concurrent refresh attempts across worker and API replicas, with a double-check pattern and distinction between transient network errors (safe for retry with existing refresh token) and permanent revocations (degrades integration).
- **Durable Sync Handoff & Crash-Recovery**: OAuth callback enqueues a durable `Job` (`SHOPIFY_SYNC_ORDERS`, `status: QUEUED`) and returns immediately without in-memory fire-and-forget promises. Replacement processors sweep and execute pending sync requests upon startup with idempotent projection.
- **GraphQL Admin API (2026-07)**: Synchronizes order and fulfillment state with cursor-based pagination and leaky bucket rate limit cost tracking. Deterministic normalization minimizes PII and consolidates multi-fulfillment tracking numbers. See [shopify-integration.md](./shopify-integration.md).

---

## 14. Real ShipStation V2 Connection & Read-Only Shipment Sync

- **Two Real External Providers**: ShipStation (API V2) represents Reloop's second real external provider, allowing live cross-system reconciliation between real Shopify orders and real ShipStation shipments.
- **Strict Read-Only Boundary**: Operates strictly in read-only mode (`readCapability: true`, `mutationCapability: false`). Hardcoded base URL (`https://api.shipstation.com/v2`), HTTP `api-key` header authentication, and explicit client-side safety blockers preventing any label purchases, voids, or shipment modifications.
- **AES-256-GCM Credential Encryption**: API keys are validated against ShipStation V2 before storage and encrypted at rest with versioned AES-256-GCM envelopes. Plaintext keys are never logged, stored in the database, or returned via API.
- **Safe Semantic Invariants**:
  - `label_purchased` is normalized to `LABEL_CREATED`, strictly avoiding `SHIPPED`.
  - ShipStation is shipping/label software, NOT a 3PL warehouse (`ORDER_MISSING_AT_3PL` never triggers for ShipStation).
  - PII is strictly stripped from payloads prior to normalization and storage.
- **Durable Background Sync**: Enqueues `SHIPSTATION_SYNC_SHIPMENTS` jobs for durable worker execution with bounded pagination, rate-limit backoff handling (HTTP 429 with `Retry-After`), and idempotent `ExternalReference` projection.
- **Cross-System Reconciliation**: Deterministic matching compares Shopify `ExternalOrder` projections with ShipStation shipment metadata, detecting authoritative missing tracking (`TRACKING_MISSING_IN_SHOPIFY`), ambiguous shipments (`DUPLICATE_RISK`), and conflicts, while strictly fencing simulator recovery actions. See [shipstation-integration.md](./shipstation-integration.md).

---

## 15. Operations API, Integration Health & Exception Read Model

- **Product-Facing Read API**: Converts internal PostgreSQL reliability states into clean, tenant-safe DTO projections serving frontend operational surfaces (Dashboard, Exceptions, Orders, Recoveries, Integrations) without exposing internal Prisma schemas, Job attempts, or raw provider bodies.
- **Strict Read-Only Guarantee**: All operations endpoints (`/dashboard/summary`, `/exceptions`, `/orders`, `/recoveries`, `/integrations`) are strictly `GET`. Existing Day 11 approval and rejection endpoints remain the authoritative mutation paths.
- **Zero Secrets & Zero PII**: Strict recursive DTO filtering guarantees `encryptedCredentials`, access tokens, API keys, and customer PII (street address, email, phone) are never returned.
- **Deterministic Integration Health**: Provider health (`HEALTHY`, `DEGRADED`, `DISCONNECTED`, `SYNCING`) is derived deterministically from durable records. Connected-but-failing sync pipelines are marked `DEGRADED`, preventing false healthy indicators.
- **Flight Recorder Timelines**: Chronological timelines reconstruct execution facts strictly from durable database records (`RecoveryCase`, `Workflow`, `WorkflowStep`, `Approval`, `JobAttempt`).
- **Standardized Pagination & RBAC**: Consistent `{ items, page, pageSize, total, totalPages }` contract across all list endpoints with query validation. `OWNER`, `ADMIN`, `OPERATOR`, and `VIEWER` roles possess read access. See [operations-api.md](./operations-api.md).

---

## 16. Realtime Operations & Invalidation Architecture (Day 20)

- **Authoritative First, Invalidation Signal Second**: Realtime events are strictly invalidation notifications emitted after row-locked PostgreSQL transactions commit. WebSockets are never treated as a second source of truth; clients query authoritative REST endpoints upon receiving signals.
- **Physical Redis Isolation**: Reloop strictly separates durable execution queues (`reloop:jobs:ready` via Redis Streams) from ephemeral realtime broadcasts (`reloop:realtime:events` via Redis Pub/Sub). Failures in realtime fanout never corrupt durable job streams.
- **JWT Handshake Authentication & Tenant Room Binding**: Sockets authenticate via JWT in handshake authorization payload (`auth.token`). The gateway verifies active organization membership in PostgreSQL and binds sockets strictly to `org:<organizationId>`. Cross-tenant event leakage is architecturally impossible.
- **Zero Client Mutations**: Client-to-server business mutation commands over WebSockets are systematically rejected. All operations (Approve, Reject, Connect, Disconnect) are performed exclusively via authenticated REST routes.
- **Multi-Instance Compatibility**: API servers subscribe to Redis Pub/Sub channels on startup, ensuring that worker-driven step completions, webhook reconciliation cases, and admin actions propagate instantly to all active socket sessions across server instances. See [realtime-architecture.md](./realtime-architecture.md).

---

## 17. Reliability, Stress Validation & Failure Injection (Day 21)

- **Comprehensive Empirical Stress Validation**: Rigorously proved Reloop's distributed reliability claims under realistic load, network partitions, and concurrent failure scenarios against isolated test infrastructure (`reloop_test` PostgreSQL on 5433, Redis 7 on 6380).
- **Sub-200ms API Read Latency**: Under sustained read traffic, all operational endpoints achieved sub-200ms p95 latencies (`/dashboard/summary`: 141.6ms p95, `/exceptions`: 33.5ms p95, `/orders`: 44.2ms p95, `/recoveries`: 38.9ms p95, `/integrations`: 31.9ms p95).
- **High-Throughput Distributed Scheduling & Worker Engine**: Atomic scheduling sustained 2,221.1 jobs/sec. A 10,000-job stress test workload completed with 100% success (0 remaining, 0 dead-lettered, 0 blocked, 0 duplicate executions, 259.3 jobs/sec overall across 5 workers with 50 concurrency).
- **Zero Duplicate Side-Effects Under Crash Failure**: Worker crashes during `RUNNING` status are classified as ambiguous crashes and placed into `BLOCKED` status (`AMBIGUOUS_WORKER_CRASH`) with zero blind re-executions, preventing duplicate external mutations. Expired leases in `CLAIMED` status cleanly transition the abandoned attempt to `ABANDONED` and resume execution on a replacement worker.
- **Race-Safe Concurrency & Routing Invariants**: Simultaneous approvals on the same step enforce atomic CAS semantics, guaranteeing exactly 1 winner and 1 conflict rejection. Case routing and detection enforce strict transactional advisory locking and deduplication, ensuring zero duplicate active workflows or cases.
- **Post-Load Database Invariant Verification**: Exhaustive SQL diagnostic audit verified 0 orphaned JobAttempts, 0 duplicate active workflows per case, 0 duplicate active cases per dedupeKey, 0 duplicate idempotency keys, and 0 resolved cases lacking verified resolution timestamps. See [reliability-benchmark.md](./reliability-benchmark.md).

