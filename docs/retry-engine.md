# Reloop Retry Engine: Classification, Backoff, Jitter & Dead-Lettering

## 1. Architectural Purpose & Overview

In distributed e-commerce infrastructure, operations frequently fail due to transient hiccups—network socket timeouts, rate limits from external APIs (Shopify, ShipStation, Stripe, 3PLs), or temporary 503 Service Unavailable responses from upstream gateways. Blindly marking these operations as permanently failed causes unnecessary support tickets and abandoned recovery workflows. Conversely, blindly retrying invalid requests (e.g., malformed payloads, invalid API credentials, not-found entities) amplifies load and creates endless retry loops.

The **Reloop Retry Engine** (`apps/worker`) implements a principled, resilient retry architecture:
1. **Precise Error Classification**: Categorizes failures into retryable transient errors vs. permanent terminal errors using canonical `JobErrorCategory` types.
2. **Backoff with Uniform Jitter**: Exponential delays (`[30s, 2m, 10m, 30m]`) with \$\pm 15\%\$ random uniform jitter to avoid thundering herd spikes against downstream services.
3. **External Provider Precedence**: Honors provider `Retry-After` headers (in seconds or absolute HTTP dates) by selecting `max(jitteredDelay, retryAfterMs)`.
4. **Dead-Letter Discipline**: Automatically transitions jobs to `DEAD_LETTERED` in PostgreSQL when `attemptCount >= maxAttempts`, preserving complete failure history while acknowledging Redis stream messages to prevent Redis PEL leakage.
5. **Idempotency Stability**: Preserves `Job.idempotencyKey` across all retry attempts, ensuring deterministic downstream deduplication.
6. **Strict Ownership Fencing**: Executes failure transitions (`RETRY_WAITING`, `DEAD_LETTERED`, `FAILED`) in atomic transactions fenced by active worker ownership and unexpired lease. If lease ownership is lost, the transaction rolls back completely.

---

## 2. Error Classification Model

Errors caught during job handler execution are classified via `classifyJobError` into structured `JobExecutionError` instances:

### Classification Matrix

| `JobErrorCategory` | Default Retryable | Typical Scenarios | Next State (Attempts Remaining) | Next State (Attempts Exhausted) |
| :--- | :---: | :--- | :---: | :---: |
| `TRANSIENT` | **YES** | 503 Gateway Outage, ECONNRESET, socket timeout, 502/504 | `RETRY_WAITING` | `DEAD_LETTERED` |
| `RATE_LIMITED` | **YES** | 429 Too Many Requests, leaky bucket threshold hit | `RETRY_WAITING` | `DEAD_LETTERED` |
| `BUSINESS_ERROR` | **NO** | Insufficient funds, inventory depleted, validation failure | `FAILED` | `FAILED` |
| `AUTH_ERROR` | **NO** | 401 Unauthorized, 403 Forbidden, revoked API keys | `FAILED` | `FAILED` |
| `NOT_FOUND` | **NO** | 404 Resource missing, entity deleted | `FAILED` | `FAILED` |
| `DUPLICATE` | **NO** | 409 Conflict, already processed resource | `FAILED` | `FAILED` |
| `UNKNOWN` | **NO** | Uncaught exceptions, unexpected type errors | `FAILED` | `FAILED` |

> [!IMPORTANT]
> `UNKNOWN` errors are **never** retried by default. Retrying unknown, unclassified code crashes creates poison pills that can destabilize worker fleets.

### Structured Error Sanitization
All error messages are passed through `sanitizeErrorMessage`:
- **Length Cap**: Truncated to a maximum of 500 characters.
- **Redaction**: Patterns matching `password=...`, `token=...`, `secret=...`, `Bearer ...`, database connection strings (`postgresql://...`, `redis://...`) are automatically replaced with `[REDACTED]`.
- **No Stack Traces**: Raw internal stack traces containing local filesystem paths are stripped from durable database storage.

---

## 3. Backoff, Jitter & Retry-After Precedence

### Delay Sequence
The backoff policy uses configurable base delays (in milliseconds), defaulting to:
- **Attempt 1**: 30,000 ms (30 seconds)
- **Attempt 2**: 120,000 ms (2 minutes)
- **Attempt 3**: 600,000 ms (10 minutes)
- **Attempt 4+**: 1,800,000 ms (30 minutes cap)

### Uniform Jitter Calculation
To avoid synchronization of retrying workers (the thundering herd problem), a uniform random factor $J \in [-0.15, +0.15]$ is applied:
$$\text{jitteredDelay} = \max\left(1000, \text{round}(\text{baseDelay} \times (1 + J))\right)$$
Delays are guaranteed to remain strictly positive ($\ge 1000\text{ ms}$).

### Provider `Retry-After` Precedence
When an external provider (e.g. Shopify 429 response) provides a `Retry-After` hint:
$$\text{effectiveDelay} = \max(\text{jitteredDelay}, \text{retryAfterMs})$$
If the provider requests 45 seconds while internal jittered backoff computes 30 seconds, 45 seconds is honored. If the provider requests 5 seconds while internal jittered backoff computes 30 seconds, the safer 30 seconds is honored.

---

## 4. State Transition Lifecycle

```text
       ┌───────────┐
       │  QUEUED   │◄─────────────────────────────────────┐
       └─────┬─────┘                                      │
             │ atomic claim                               │
             ▼                                            │
       ┌───────────┐                                      │
       │  CLAIMED  │                                      │
       └─────┬─────┘                                      │
             │ handler start                              │
             ▼                                            │
       ┌───────────┐                                      │
       │  RUNNING  │                                      │
       └─────┬─────┘                                      │
             │                                            │
             ├─ success ──────────────────────────► SUCCEEDED
             │                                            │
             ├─ retryable error & attempts remain         │
             │    │                                       │
             │    ▼                                       │
             │  RETRY_WAITING (nextRunAt set) ────────────┘
             │    (Scanned by Scheduler when nextRunAt <= NOW)
             │
             ├─ retryable error & attempts exhausted
             │    │
             │    ▼
             │  DEAD_LETTERED (nextRunAt = null, completedAt = now)
             │
             └─ permanent error (or UNKNOWN)
                  │
                  ▼
                FAILED (nextRunAt = null, completedAt = now)
```

---

## 5. Transaction Safety & Ownership Fencing

When an execution fails, the worker must finalize the failure durably in PostgreSQL:

### Lease Maintained Through Finalization
The worker's background lease renewal timer is **kept active** until the finalization database transaction has committed. It is canceled in a `finally` block only after the transaction completes or fails. This eliminates the race condition where lease expiration allows a peer worker to steal the job while the original worker is attempting to record the failure.

### All-or-Nothing Fencing Rollback
The database transition is executed in a single atomic transaction:
```sql
UPDATE jobs
SET
  status = 'RETRY_WAITING'::"JobStatus",
  next_run_at = $nextRunAt::timestamptz,
  claimed_by_worker_id = NULL,
  lease_expires_at = NULL,
  completed_at = NULL,
  updated_at = NOW()
WHERE
  id = $jobId::uuid
  AND claimed_by_worker_id = $workerDbId::uuid
  AND status = 'RUNNING'::"JobStatus"
  AND lease_expires_at IS NOT NULL
  AND lease_expires_at > NOW();
```
If this query returns `0` rows affected (because the lease expired or another worker reclaimed ownership):
1. An exception is explicitly thrown inside the transaction callback, forcing PostgreSQL to **roll back completely**.
2. The `JobAttempt` record is **not** left in an orphaned state.
3. The worker **skips** Redis `XACK`, leaving the message in the pending entries list (PEL) for subsequent recovery.

---

## 6. Dead-Letter Queue & Observability

### Authoritative Dead-Letter Storage
Unlike simple broker setups that divert messages to an external Redis dead-letter stream, Reloop treats **PostgreSQL as the single authoritative record of truth**. 
When a job is marked `DEAD_LETTERED`:
- Redis stream message is acknowledged (`XACK`) to prevent infinite delivery loops.
- `Job.status = DEAD_LETTERED` and `Job.completedAt = NOW()`.
- `Job.nextRunAt = NULL` so the Scheduler scanner never selects it again.
- The final `JobAttempt` contains the exact error category, code, duration, and sanitized error message.

### Safe Inspection Helper
The `inspectDeadLetterJobs` helper (`apps/worker/src/inspect.ts`) enables operators and recovery UIs to query dead-lettered jobs with tenant isolation, pagination, and sanitized failure summaries.
