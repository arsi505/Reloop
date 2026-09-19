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
├── apps/
�?  ├── web/                     # Next.js web application (Dashboard, Exception Inbox, Previews)
�?  ├── api/                     # NestJS core backend API & Webhook Ingestion
�?  ├── scheduler/               # Scheduled cron engine (reconciliation pollers, heartbeat sweeps)
�?  └── worker/                  # Background worker daemon consuming recovery execution jobs
�?├── packages/
�?  ├── database/                # Prisma schema, client, migrations, and database seeders
�?  ├── contracts/               # Shared TypeScript DTOs, API contracts, and event schemas
�?  ├── workflow-core/           # Recovery state machines, verification logic, and safety rules
�?  └── integration-sdk/         # Connector interfaces, rate-limiters, and normalized order models
�?├── connectors/
�?  ├── simulator/               # Mock 3PL and carrier simulator for robust local development & testing
�?  ├── shopify/                 # Shopify Admin GraphQL/REST connector
�?  ├── shipstation/             # ShipStation v1/v2 REST connector
�?  └── generic-3pl/             # Standardized REST/Webhook connector for 3PL warehouse systems
�?├── docker/
�?  ├── docker-compose.yml       # Local development services (Postgres, Redis, app services)
�?  └── Dockerfile.*             # Individual production container definitions
�?├── docs/                        # Specifications, UX journeys, design system, architecture plans
├── .gitignore                   # Repository ignore specifications
├── LICENSE                      # MIT License
└── README.md                    # Project overview and status
```

---

## 4. Execution & Data Flow Architecture

### Ingestion Flow
1. **Webhooks**: Shopify, ShipStation, or 3PL warehouse fires order/shipment webhooks to `apps/api`.
2. **Scheduled Polling**: `apps/scheduler` triggers periodic reconciliation scans via `packages/integration-sdk` to detect silent drops and stuck states.
3. **State Evaluation**: Incoming state is compared against the database. If a discrepancy matches one of the 8 canonical failure cases, an Exception record is created in PostgreSQL with status `OPEN` and assigned a Recovery Level (`AUTO_RECOVER`, `AUTO_INVESTIGATE`, `REQUIRE_APPROVAL`, `BLOCK`).

### Recovery Execution Flow
```
[Event Trigger] ────────�?[Ingestion / Poller]
                                �?                                �?                       [Exception Created]
                                �?        ┌───────────────────────┴───────────────────────�?        �?                                              �?[AUTO_RECOVER / INVESTIGATE]                  [REQUIRE_APPROVAL / BLOCK]
Queued to Redis Stream worker                 UI shows Recovery Preview
        �?                                              �?        �?                                              �?[Execute Idempotent Payload]                  [Human Operator Approves]
        �?                                              �?        └───────────────────────┬───────────────────────�?                                �?                                �?                     [State: VERIFYING]
                                �?                     (Independent GET query
                      across both platforms)
                                �?               ┌────────────────┴────────────────�?               �?                                �?       [State Converged]                 [State Divergent]
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
- **Deduplication & Concurrency**: Uses \dedupeKey\ and PostgreSQL advisory locks to guarantee that racing detector processes resolve to exactly one active \RecoveryCase\. Reuses open cases and records distinct incidents for recurrences. See [reconciliation-engine.md](./reconciliation-engine.md).
