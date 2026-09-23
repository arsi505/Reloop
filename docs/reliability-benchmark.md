# Reloop Day 21: Reliability, Stress Validation & Failure Injection Benchmark Report

## 1. Environment & Infrastructure Specifications

| Component | Specification |
| :--- | :--- |
| **Host Operating System** | Windows 11 Pro 64-bit (Build 26100) |
| **Host CPU** | AMD Ryzen 5 5600H (6 cores, 12 logical processors @ ~3.30 GHz) |
| **Host Memory** | 15.92 GB RAM |
| **Runtime Environment** | Node.js v24.13.1, npm v11.8.0 |
| **Database Engine** | PostgreSQL 16.15 (Alpine Linux, container `reloop-postgres` on port 5433) |
| **Cache & Queue Engine** | Redis 7.4.11 (Alpine Linux, container `reloop-redis` on port 6380) |
| **Test Database URL** | `postgresql://reloop:<redacted>@localhost:5433/reloop_test?schema=public` |
| **Execution Tooling** | ts-node / Jest test harness scoped to non-production synthetic data |

---

## 2. API Read Endpoints Under Load

Measured with 50 authenticated requests per endpoint under continuous load:

| Endpoint | Target Latency (p95) | Measured p50 | Measured p95 | Measured p99 | Throughput | Result |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `GET /dashboard/summary` | < 200 ms | 11.1 ms | 141.6 ms | 154.4 ms | 100.5 req/s | **PASS** |
| `GET /exceptions` | < 200 ms | 12.7 ms | 33.5 ms | 39.2 ms | 265.4 req/s | **PASS** |
| `GET /orders` | < 200 ms | 7.1 ms | 44.2 ms | 47.2 ms | 226.0 req/s | **PASS** |
| `GET /recoveries` | < 200 ms | 7.6 ms | 38.9 ms | 43.0 ms | 276.9 req/s | **PASS** |
| `GET /integrations` | < 200 ms | 6.3 ms | 31.9 ms | 32.5 ms | 311.1 req/s | **PASS** |

### Rate Limiting Enforcement
- **ThrottlerGuard Policy**: 100 requests per 60,000 ms per IP address.
- **Stress Verification**: A burst of 150 consecutive requests from a single client resulted in HTTP `429 Too Many Requests` actively enforced on requests 101–150.

---

## 3. Webhook Ingestion & Deduplication Benchmarks

### Webhook Throughput & Drain Rates
Measured using the synthetic simulator webhook endpoint (`POST /webhooks/simulator`):

| Offered Load | Accepted Throughput | Processing (Drain) Throughput | p95 Ingestion Latency | Result / Classification |
| :--- | :--- | :--- | :--- | :--- |
| **50 events/sec** | 50.0 events/sec | 205.7 events/sec | 16.94 ms | **PASS** |
| **100 events/sec** | 100.0 events/sec | 168.1 events/sec | 15.06 ms | **PASS (Target Met)** |
| **150 events/sec** | 107.8 events/sec | 222.4 events/sec | 15.15 ms | **SATURATION (Single-Process CPU Bound)** |

### Ingestion Semantics & Machine Bounds
- **100 events/sec Target**: Fully satisfied with 100.0 events/sec accepted throughput and 15.06 ms p95 response time.
- **150 events/sec Saturation**: A single Node.js runtime process saturates at ~108 accepted events/sec on this local machine environment due to synchronous HMAC signature verification, JSON serialization, and HTTP loopback round-trip overhead.
- **Processing Drain vs. Ingestion**: Background worker processing throughput (168–222 events/sec) exceeds HTTP ingestion throughput because background workers execute in batched pipeline concurrency independent of HTTP socket ingress.

### Webhook Duplicate Exact Counts Drill
Evaluated with 20 concurrent identical deliveries of the same signed provider event:

| Metric | Measured Count | Expected Target | Status |
| :--- | :---: | :---: | :---: |
| **Deliveries Sent** | 20 | 20 | Complete |
| **Requests Accepted (`status: 'accepted'`)** | 1 | 1 | **PASS** |
| **Duplicate Responses (`status: 'ignored_duplicate'`)** | 19 | 19 | **PASS** |
| **IntegrationEvent Rows Created** | 1 | 1 | **PASS** |
| **Downstream Executions (Orders)** | 1 | 1 | **PASS** |
| **RecoveryCases Created** | 0 | 0 | **PASS** |
| **Duplicate Business Effects** | 0 | 0 | **PASS** |

---

## 4. Job Scheduling & 10k Throughput Repeatability

### Single-Run Baseline Throughput
| Workload Metric | Configuration | Rate / Measurement | Evaluation Target | Result |
| :--- | :--- | :--- | :--- | :---: |
| **Atomic Job Scheduling** | 1,000 jobs batched | 2,221.1 jobs/sec | N/A | High-speed batch |
| **Claimed Throughput (30 Conc)** | 3 Workers (30 Concurrency) | 309.3 claimed/sec | N/A | In-band claim |
| **Claimed Throughput (50 Conc)** | 5 Workers (50 Concurrency) | 284.8 claimed/sec | N/A | In-band claim |
| **Completed Jobs Throughput** | 5 Workers (50 Concurrency) | **259.3 completed/sec** | >= 250 jobs/sec | **PASS** |

### 10k Workload Repeatability (3 Independent Runs Under 50 Concurrency)
Configuration: 5 Workers, 10 Concurrency each (50 total concurrency), Redis stream pipeline, batched PostgreSQL insertion (500/batch).

| Run # | Jobs Created | Jobs Completed | Elapsed Time | Completed Jobs/Sec | Duplicate Effects | Blocked | Dead-Lettered | Unfinished |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | 10,000 | 10,000 | 33.32 s | **300.1 jobs/sec** | 0 | 0 | 0 | 0 |
| **2** | 10,000 | 10,000 | 29.49 s | **339.1 jobs/sec** | 0 | 0 | 0 | 0 |
| **3** | 10,000 | 10,000 | 26.85 s | **372.4 jobs/sec** | 0 | 0 | 0 | 0 |

### 10k Repeatability Summary Statistics
- **Minimum Completed Jobs/Sec**: 300.1 completed jobs/sec
- **Median Completed Jobs/Sec**: **339.1 completed jobs/sec**
- **Maximum Completed Jobs/Sec**: 372.4 completed jobs/sec
- **Evaluation against >= 250 completed jobs/sec Target (Median)**: **PASS** (339.1 >= 250)
- **Duplicate Business Effects (Across All 3 Runs)**: **0**
- **Blocked Jobs (Across All 3 Runs)**: **0**
- **Dead-Lettered Jobs (Across All 3 Runs)**: **0**
- **Unfinished Jobs (Across All 3 Runs)**: **0**

---

## 5. Failure Injection & Reliability Drills (24/24 PASS)

| # | Drill Name | Core Invariant Under Test | Observed Result | Verdict |
| :---: | :--- | :--- | :--- | :---: |
| 1 | Duplicate Delivery (Idempotency Key) | PostgreSQL unique constraint `(organization_id, idempotency_key)` rejects dupes | Exactly 1 job created; duplicate rejected | **PASS** |
| 2 | Redis Stream Duplicate Delivery | Reread PostgreSQL state before execution | 3 stream deliveries; handler ran exactly 1 time | **PASS** |
| 3 | Worker Crash Before Execution | Expired lease in CLAIMED status discovered via PEL | Attempt 1 ABANDONED; Attempt 2 SUCCEEDED | **PASS** |
| 4 | Worker Crash During RUNNING | Ambiguous crash policy protects external side-effects | Job transitioned to BLOCKED; 0 blind retries | **PASS** |
| 5 | Redis Stream PEL Recovery | XAUTOCLAIM stale PEL discovery after `workerPelMinIdleMs` | Stale PEL entry claimed and XACKed (0 pending) | **PASS** |
| 6 | Simultaneous Approve/Approve | Atomic CAS `WHERE status = 'PENDING'` | Exactly 1 winner, 1 conflict rejection; 1 audit log | **PASS** |
| 7 | Simultaneous Approve/Reject | Atomic CAS `WHERE status = 'PENDING'` | Exactly 1 winner, 1 conflict rejection | **PASS** |
| 8 | Recovery Routing Concurrency | Advisory transaction lock `pg_advisory_xact_lock` | 3 concurrent calls -> exactly 1 active workflow | **PASS** |
| 9 | Case Detection Concurrency | Unique case deduplication key `dedupeKey` | 3 concurrent findings -> exactly 1 active case | **PASS** |
| 10 | Out-of-Order Webhook Projection | Monotonic timestamp fence `lastObservedAt <= incoming` | Older event ignored; current status preserved | **PASS** |
| 11 | Retry Backoff Schedule & Precedence | Exponential backoff [30s, 120s, 600s, 1800s] ±15% jitter | Backoff intervals verified; Retry-After header honored | **PASS** |
| 12 | Permanent Failure Classification | Non-retryable error categories transition to FAILED | Category UNKNOWN / retryable: false -> FAILED | **PASS** |
| 13 | Retry Exhaustion (DEAD_LETTERED) | Max attempts exhausted triggers DEAD_LETTERED | Job DEAD_LETTERED; Attempt 3 recorded FAILED | **PASS** |
| 14 | Verification Failure Safety | Failed invariant verification prevents RESOLVED | Status set to INVESTIGATING; never RESOLVED | **PASS** |
| 15 | HTTP 200 Wrong State Safety | Authoritative state mismatch flags verification error | External HTTP 200 with wrong state rejected | **PASS** |
| 16 | Realtime Failure Independence | PostgreSQL durable transaction independent of Pub/Sub | Realtime failure caught; job committed to DB | **PASS** |
| 17 | Request Coalescing Under Load | Frontend 300 ms coalescing window | 50 events in 200 ms -> exactly 1 API refetch | **PASS** |
| 18 | Cross-Tenant Stress & Multi-Entity Isolation | Scoped tenant queries across Orders, Cases, Workflows | 0 foreign records observed across all entities | **PASS** |
| 19 | Worker Restart Drill | Queued work resumes across worker restart via PEL | Status SUCCEEDED; 0 lost jobs; 0 duplicates | **PASS** |
| 20 | Scheduler Restart Drill | Scheduler restart redispatches eligible work safely | Active workflows = 1; reused active workflow; 0 dupes | **PASS** |
| 21 | API Restart Drill | Background processing continues during API restart | Status SUCCEEDED; 0 durability loss; 1 execution | **PASS** |
| 22 | Redis Outage — Durable Job Behavior | PostgreSQL job survives outage (no false success) | Restored dispatch processed to SUCCEEDED; 0 dupes | **PASS** |
| 23 | PostgreSQL Outage Safety Drill | Fail-fast error throwing, reconnect restoration | Outage failed fast; active connection query ok=1 | **PASS** |
| 24 | Socket Lifecycle Stress Drill (100 Cycles) | 100 connect/disconnect cycles with timer cleanup | 100 cycles completed; 0 listener leaks; 0 timer leaks | **PASS** |

---

## 6. PostgreSQL Application-Level Outage & Recovery Drill

Evaluated via temporary container stop with intact storage volumes:

| Invariant / Check | Observed Behavior | Expected | Verdict |
| :--- | :--- | :--- | :---: |
| **API Mutation During Outage** | Connection error thrown fast; 0 HTTP 200 returned; 0 records created | Fails safely, no false success | **PASS** |
| **False API Success During Outage?** | **NO** | NO | **PASS** |
| **Worker Operation During Outage** | Worker DB claim failed fast; job remained `QUEUED`; Redis was not treated as durable truth | No false SUCCEEDED in Redis or DB | **PASS** |
| **Worker Falsely Marked Success?** | **NO** | NO | **PASS** |
| **Storage Volumes Intact Post-Outage** | Baseline Org Count = 14; Post-Recovery Org Count = 15 | All volume records preserved | **PASS** |
| **Normal DB Operation Resumed** | Active connection returned `SELECT 1 as ok`; Surviving job processed to `SUCCEEDED` | DB operational, job completed | **PASS** |
| **Duplicate Business Effects** | **0** | 0 | **PASS** |

---

## 7. Post-Load Database Invariant Integrity Audit

| Invariant Checked | SQL Verification Query Condition | Count | Status |
| :--- | :--- | :---: | :---: |
| **Orphaned JobAttempts** | `job_attempts ja LEFT JOIN jobs j WHERE j.id IS NULL` | **0** | **PASS** |
| **Duplicate Active Workflows** | `workflows WHERE status IN ('PENDING', 'RUNNING', 'WAITING') GROUP BY org, recovery_case_id HAVING COUNT(*) > 1` | **0** | **PASS** |
| **Duplicate Active Cases** | `recovery_cases WHERE status NOT IN ('RESOLVED', 'FAILED') GROUP BY org, dedupe_key HAVING COUNT(*) > 1` | **0** | **PASS** |
| **Duplicate Idempotency Keys** | `jobs GROUP BY organization_id, idempotency_key HAVING COUNT(*) > 1` | **0** | **PASS** |
| **Unverified Resolved Cases** | `recovery_cases WHERE status = 'RESOLVED' AND resolved_at IS NULL` | **0** | **PASS** |

---

## 8. Known Architectural Limitations & Operational Boundaries

1. **Local Single-Process Ingestion Bound**:
   - Single-instance Node process webhook ingestion reaches saturation at ~108 events/sec on the local test machine due to HMAC signature validation, JSON parsing, and TLS/HTTP loopback latency. In production, horizontal scaling across stateless API replicas behind an external load balancer is required for throughput exceeding 1,000 events/sec.
2. **Ambiguous Worker Crash Semantics**:
   - If a worker crashes mid-execution (job in `RUNNING` status), Reloop deliberately does NOT blindly retry the job. The job is placed in `BLOCKED` status, and the attempt is marked `ABANDONED` with `AMBIGUOUS_WORKER_CRASH`. This guarantees zero duplicate side-effects against external APIs (e.g., duplicate fulfillments or refunds) and requires manual or automated verification before unblocking.
3. **Local IP Rate Limiting**:
   - NestJS `ThrottlerGuard` applies a global 100 requests / 60-second limit per IP. Rapid benchmarking on loopback `127.0.0.1` must take this into account; in multi-tenant production, client IPs are resolved via trusted proxy headers (`X-Forwarded-For`).
