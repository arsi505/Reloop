# Reloop Webhook Ingestion & Event Deduplication Engine

## 1. Overview & Architecture

Reloop Day 14 establishes the production-grade external event ingestion pipeline. The system securely receives webhooks from external e-commerce platforms, 3PL warehouses, shipping services, and simulators, normalizes external events into stable domain projections, and triggers targeted reconciliation.

```
External Provider / Simulator Webhook
               │
               ▼
┌──────────────────────────────┐
│  Raw Request Body Buffer     │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  HMAC-SHA256 Timing-Safe     │
│  Signature Verification      │
└──────────────┬───────────────┘
               │ (Valid)
               ▼
┌──────────────────────────────┐
│  Tenant Authority Check      │
│  (Integration.organizationId)│
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Durable Ingestion & Dedupe  │
│  @@unique(integrationId,     │
│           providerEventId)   │
└──────────────┬───────────────┘
               │ (HTTP 200 Fast Response to Provider)
               ▼
┌──────────────────────────────┐
│  Asynchronous Processor      │
│  (At-Least-Once Processing)  │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Normalization & Out-of-Order│
│  Projection Guard            │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Targeted Reconciliation     │
│  reconcileOrder(snapshot)    │
└──────────────┬───────────────┘
               │ (Discrepancy Found)
               ▼
┌──────────────────────────────┐
│  Day 12 RecoveryCase (OPEN)  │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Day 13 Policy Router        │
│  (Independent Evaluation)    │
└──────────────────────────────┘
```

---

## 2. Cryptographic Signature Verification & Raw Body Requirement

1. **Exact Raw Request Body**: Signature verification operates exclusively on the exact incoming byte stream (`req.rawBody: Buffer`), preserved via NestJS `{ rawBody: true }`. JSON re-serialization is strictly forbidden to prevent canonical byte discrepancies.
2. **HMAC-SHA256 Algorithm**: The digest is computed using `crypto.createHmac('sha256', secret)`.
3. **Constant-Time Comparison**: Signatures are verified using `crypto.timingSafeEqual`. Fixed length checking (64 hex characters) and regex guards prevent `RangeError` exceptions and timing side-channel attacks.
4. **Invalid & Missing Signatures**: Missing or mismatched signatures immediately reject the request with `401 Unauthorized`. Zero `IntegrationEvent` records are persisted.

---

## 3. Tenant Authority & Ingestion Boundaries

- **Authoritative Tenant Resolution**: The tenant identity is strictly derived from `Integration.organizationId` loaded from the database via `:integrationId`.
- **Payload Spoofing Prevention**: Any `organizationId` present within the webhook payload body is ignored. Cross-tenant event injection is cryptographically and architecturally impossible.

---

## 4. Durable Event Ingestion & Deduplication

1. **Durable Persistence Before Response**: An incoming webhook is durably committed to the database as an `IntegrationEvent` with `status: RECEIVED` before responding to the provider.
2. **Fast Provider Response**: The HTTP controller performs only necessary verification and persistence, returning in `< 20ms`. Heavy processing occurs asynchronously.
3. **Database-Enforced Deduplication**: A unique constraint `@@unique([integrationId, providerEventId])` guarantees that identical events deliver exactly one database row. Concurrent duplicates return `200 OK` with `{ status: 'ignored_duplicate' }` and create zero duplicate side effects.
4. **Commit-Then-Response-Loss Safety**: If a provider commits an event but disconnects before receiving the response, the subsequent retry is recognized by `providerEventId` and acknowledged safely.

---

## 5. Processing Model & Out-of-Order Event Fencing

- **At-Least-Once Processing**: Reloop embraces an at-least-once event delivery model paired with idempotent external state projection.
- **Out-of-Order Guard**: Each event includes an `occurredAt` timestamp. When projecting state to `ExternalOrder`:
  - If `existingOrder.lastObservedAt > event.occurredAt`, the event is recognized as stale/out-of-order.
  - The older event is marked `PROCESSED` with note `SUPERSEDED_BY_NEWER_STATE`.
  - The newer projected state (`status`, `lastObservedAt`) is never regressed.
- **Replay Capability**: Internal `replayEvent(eventId)` resets the event to `RECEIVED` and idempotently re-executes projection and targeted reconciliation without entity duplication.

---

## 6. Targeted Reconciliation Trigger vs. Periodic Safety Net

- **Event-Driven Latency**: When an event updates `ExternalOrder` and `ExternalReference`, `TargetedReconciliationService` immediately reconciles the specific order.
- **Explainable Discrepancy Detection**: Evaluates `reconcileOrder(snapshot)` from `@reloop/reconciliation-core`. Any detected invariant violation creates or updates an open `RecoveryCase` via transactional advisory locking.
- **Periodic Scanner Remains**: The Day 12 periodic reconciliation scanner remains active as a complete safety net, since external webhooks are not guaranteed to be delivered.

---

## 7. The Strict Boundary Invariant

> [!IMPORTANT]
> **Webhooks never directly recover anything.**
>
> A webhook only supplies new external facts. It never calls `RecoveryActionExecutor`, never creates `Approval` gates directly, and never executes external mutations.
>
> Recovery strictly follows the canonical architectural chain:
> `Webhook -> IntegrationEvent -> State Projection -> Targeted Reconciliation -> RecoveryCase -> Day 13 Policy Router -> CHECK -> (APPROVAL) -> EXECUTE -> VERIFY -> RESOLVED`.
