# Reloop Technical Portfolio & Engineering Interview Notes

This document provides a concise, deep-dive reference for engineering discussions, architectural interviews, and technical evaluation of the Reloop e-commerce reliability platform.

---

## 1. Core Engineering Questions & Design Rationale

### Why Reloop exists
Modern multi-channel e-commerce is fundamentally distributed and asynchronous. Disjointed SaaS platforms (Shopify storefronts, 3PL warehouse management systems, carriers, and ERPs) communicate via webhooks, polling APIs, and batch files. At integration boundaries, webhooks drop, events arrive out of order, inventory desynchronizes, and refunds stall. Naive automation tools (e.g. basic retry loops or simple webhooks-to-Zapier glue) blindly re-fire requests, causing catastrophic duplicate shipments or double refunds. Reloop acts as an autonomous reliability plane: detecting cross-system state discrepancies, orchestrating idempotent multi-step recovery workflows, gating hazardous mutations behind human approval, and independently verifying final state consistency.

### Why PostgreSQL is authoritative
PostgreSQL provides ACID transactions, relational integrity constraints, and durable multi-tenant isolation. All business entities (orders, recovery cases, DAG steps, approvals, and immutable audit logs) must have a single unambiguous source of truth. If any ephemeral service, worker daemon, or memory cache crashes, PostgreSQL guarantees that commercial state is never lost, corrupted, or left in an inconsistent partial state.

### Why Redis is not durable truth
Redis is an in-memory data store optimized for ultra-low-latency coordination, not durable cold storage. Treating Redis as the authoritative source of record introduces severe data-loss risks during node restarts, OOM evictions, or cluster re-sharding. In Reloop, Redis is strictly infrastructure for dispatch (Streams), concurrency locking (Redlock), and notification signals (Pub/Sub). If Redis is completely wiped or restarted, zero business data is lost; the Scheduler rediscovers pending jobs from PostgreSQL and reconstructs the active work streams.

### Why Redis Streams
Redis Streams provides consumer group semantics (`XREADGROUP`, `XACK`, `XCLAIM`, `XPENDING`), message persistence across restarts (unlike plain Redis Pub/Sub), and automatic pending-entry tracking (PEL) with minimal operational overhead. Compared to heavy message brokers, Redis Streams easily runs locally in Docker, integrates directly with our Redlock leasing infrastructure, and provides sub-millisecond dispatch latency.

### Why at-least-once delivery instead of exactly-once
In distributed systems spanning third-party networks and independent SaaS vendors, genuine "exactly-once delivery" is physically impossible (the Two Generals' Problem). Network partitions, timeout ambiguities, and process restarts can always cause duplicate message transmissions. Designing for mythical "exactly-once" creates fragile systems. Reloop embraces **at-least-once delivery combined with idempotent business effects**: every webhook ingestion, job claim, and recovery mutation is guarded by unique deduplication hashes, distributed Redlock mutexes, and idempotency keys.

### How idempotency works in Reloop
Idempotency is enforced at three distinct layers:
1. **Edge Webhook Ingestion:** Ingested webhooks calculate a deterministic `dedup_hash` (`provider + eventId + sha256(payload)`). An `INSERT ... ON CONFLICT (dedup_hash) DO NOTHING` drops redundant payloads before any worker execution occurs.
2. **Execution Mutual Exclusion:** Before executing any recovery step, the worker acquires a distributed Redlock mutex keyed by the business entity (e.g. `reloop:lock:order:<orderId>`). Only one worker can manipulate an order at any instant.
3. **Upstream API Idempotency Keys:** Outbound mutations to third-party providers (e.g., creating a Shopify fulfillment) include deterministic idempotency tokens derived from the workflow step ID, ensuring repeated transmissions are treated as no-ops by upstream APIs.

### What happens when a worker crashes
If a worker process terminates abruptly (e.g. `SIGKILL`, OOM, or hardware crash):
1. The worker's heartbeat in PostgreSQL and Redis lease stops renewing.
2. The distributed Redlock mutex expires automatically upon TTL expiration.
3. The Scheduler daemon detects the expired claim via periodic sweep of the database.
4. If the step was in a pre-execution state (`CLAIMED` or `READY`), it is reset and re-enqueued for another worker to process.

### Why ambiguous RUNNING crash becomes BLOCKED
If a worker crashes while an external API mutation was actively `RUNNING` (e.g. the HTTP request was dispatched, but the process died before receiving the response), the system **cannot** know whether the upstream SaaS executed the mutation or not. Blindly retrying could result in a duplicate charge or shipment. Therefore, ambiguous crashes on non-idempotent steps automatically transition the recovery case to `BLOCKED`. A human operator is alerted to verify upstream state before releasing the block.

### Why verification is separate from execution
In multi-channel logistics, an upstream API returning `HTTP 200 OK` does **not** mean the downstream warehouse has fulfilled the order or that systems agree. The third-party API may have accepted the request asynchronously into an internal queue that later failed, or an eventual-consistency lag may exist. Reloop enforces the invariant:
`CHECK → GATE / APPROVAL → EXECUTE → VERIFY → RESOLVED`
The `VERIFY` step independently re-queries the upstream systems across both channels to confirm that both records match expected target state before marking any incident `RESOLVED`.

### Why HTTP 200 is insufficient
Many e-commerce APIs acknowledge webhook or mutation receipt with HTTP 200/202 before internal processing begins ("ghost writes"). If the downstream warehouse rejects the SKU or encounters a billing lock, the order remains stalled despite the initial HTTP 200. Verification must query read-endpoints or await conclusive downstream status events before assuming success.

### Why risky recovery requires human approval
Autonomous automation should never possess unconditional authority to perform irreversible commercial actions (e.g. issuing large financial refunds, cancelling warehouse shipments, or modifying delivery addresses). High-impact actions are guarded by policy rules (`RecoveryLevel.REQUIRE_APPROVAL`). The engine drafts the proposed mutation, calculates an immutable preview snapshot, and halts at a human gate. Only authenticated operators with `ADMIN` or `OWNER` privileges can approve or reject the action.

### Why no Kafka
Apache Kafka is an exceptional distributed commit log for organizations processing millions of events per second with dedicated infrastructure teams. For Reloop's target throughput (100–500 jobs/sec) and multi-tenant operational model, Kafka introduces excessive operational complexity (JVM management, ZooKeeper/KRaft cluster overhead, partition rebalancing lag, and local development friction). Redis Streams combined with PostgreSQL ACID storage delivers the required reliability with zero operational bloat and instant local startup.

### Why no Kubernetes
Kubernetes adds massive configuration overhead (Helm charts, ingress controllers, storage CSI drivers, and multi-node network meshes) that distracts from core application reliability during development. Reloop was architected for standard containerized runtimes (Docker Compose locally, AWS ECS / Google Cloud Run / Nomad in production). The services are stateless 12-factor daemons; any container orchestrator can run them without Kubernetes vendor lock-in.

### How tenant isolation works
Reloop implements logical tenant isolation:
- Every relational table contains an indexed, foreign-keyed `organization_id` column.
- Composite unique constraints (`@@unique([organizationId, externalOrderNumber])`) prevent cross-tenant key collisions.
- NestJS API guards inspect the authenticated user's JWT session and inject the verified `organizationId` into every database query.
- WebSocket connections authenticate via session tokens and join tenant-isolated rooms (`org:<organizationId>`), ensuring invalidation events never leak across tenants.

### How credentials are encrypted
Upstream OAuth access tokens, refresh tokens, and API keys are protected using **Envelope Encryption**:
- Secrets are encrypted at rest using AES-256-GCM.
- Each encrypted credential stores its initialization vector (`iv`) and authentication tag (`authTag`).
- Plain-text secrets never touch database logs or client network responses; UI endpoints display strictly allowlisted metadata (e.g. `Credential configured`).

### How the system could scale
1. **API Gateway:** Stateless NestJS containers scale horizontally behind an Application Load Balancer.
2. **Worker Fleet:** Background workers scale horizontally across multiple instances, consuming concurrently from Redis Streams consumer groups with partition hashing on `organizationId`.
3. **PostgreSQL Read Replicas:** Read queries for dashboards, order inspection, and exception filtering route to read replicas, reserving primary database IOPS for ACID state transitions.
4. **Redis Cluster:** Redis Streams and Redlock instances migrate to a multi-node Redis Cluster with read-through Redis Sentinels.

---

## 2. Key Development Lessons & Architectural Takeaways

1. **Never Trust Eventual Consistency Blindly:** Distributed e-commerce systems experience frequent synchronization lag. Designing explicit verification steps is the only way to avoid false-positive resolution.
2. **Idempotency Must Be Baked Into the Core:** Trying to bolt on deduplication after building workflows leads to race conditions. Deduplication must exist at the database schema level.
3. **Decouple Invalidation from Data Transfer:** Sending large state payloads over WebSockets creates serialization lag and cache consistency bugs. Emitting lightweight invalidation signals and letting clients refetch authoritative REST endpoints is vastly more reliable.
4. **Human Operators Must Have Immutable Context:** When requiring a human to approve an automated action, never show abstract IDs. Always provide complete before/after state diffs and clear rationale.
