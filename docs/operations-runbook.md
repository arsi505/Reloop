# Reloop Production Operations Runbook

This runbook defines the operational procedures, topology, initialization sequences, monitoring guidelines, and incident response playbooks for the Reloop platform.

---

## 1. System Topology & Architecture

Reloop is a distributed reverse-logistics reconciliation and recovery platform composed of the following services:

```
                      +-------------------+
                      |   Next.js (Web)   |
                      |    Port: 3100     |
                      +---------+---------+
                                |
                                v
                      +-------------------+
                      |  Core API (Nest)  | <---> Realtime WebSockets
                      |    Port: 3101     |
                      +----+---------+----+
                           |         |
         +-----------------+         +-----------------+
         v                                             v
+-------------------+                         +-------------------+
|   PostgreSQL 16   |                         |      Redis 7      |
|    Port: 5433     |                         |    Port: 6380     |
+---------+---------+                         +---------+---------+
          ^                                             ^
          |             +-----------------+             |
          +-------------+ Worker Engine   +-------------+
          |             | (Concurrency)   |             |
          |             +-----------------+             |
          |                                             |
          |             +-----------------+             |
          +-------------+ Scheduler Daemon+-------------+
                        | (Cron / Sweeps) |
                        +-----------------+
```

### Components Summary
1. **Core API (`apps/api`)**: NestJS HTTP & WebSocket server. Handles authentication, RBAC, tenant operations, approval decisions, webhook ingestion, and realtime socket events.
2. **Distributed Worker (`apps/worker`)**: Distributed Redis Streams and database job execution engine. Processes asynchronous reconciliation workflows, external carrier queries, and notification dispatches.
3. **Scheduler Daemon (`apps/scheduler`)**: Periodic task coordinator. Schedules interval reconciliations, monitors worker heartbeats, and recovers orphaned jobs.
4. **PostgreSQL 16**: Durable primary datastore. Implements ACID transactions, foreign-key multi-tenancy, and row-level locking (`FOR UPDATE SKIP LOCKED`).
5. **Redis 7**: High-throughput broker for Redis Streams dispatch, rate-limiting caches, and Socket.io pub/sub adapter.
6. **Web Client (`apps/web`)**: Next.js single-page application and operator dashboard.

---

## 2. Initialization & Ordered Startup

To prevent race conditions, services must be initialized in strict dependency order:

### Startup Sequence
```bash
# 1. Start Infrastructure Containers
docker compose up -d postgres redis

# 2. Wait for Healthchecks
docker compose exec postgres pg_isready -U reloop -d reloop
docker compose exec redis redis-cli ping

# 3. Apply Database Migrations & Seed Baseline Data
npm run db:migrate --workspace=@reloop/database

# 4. Start Core API Service
npm run start:api

# 5. Start Background Scheduler Daemon
npm run start:scheduler

# 6. Start Distributed Worker Pool
npm run start:worker

# 7. Start Frontend Web Application
npm run start:web
```

---

## 3. Configuration & Environment Variables

All services load configuration from environment variables.

| Variable | Description | Required | Example |
| :--- | :--- | :---: | :--- |
| `DATABASE_URL` | PostgreSQL connection URL | Yes | `postgresql://user:pass@host:5432/reloop?schema=public` |
| `REDIS_URL` | Redis connection URL | Yes | `redis://:pass@host:6379` |
| `PORT` | API HTTP listening port | No (3101) | `3101` |
| `FRONTEND_URL` | Trusted frontend origin for CORS | Yes | `https://app.reloop.example.com` |
| `JWT_SECRET` | 256-bit secret for JWT signing | Yes | `64-char-hex-or-random-string` |
| `INTEGRATION_ENCRYPTION_KEY`| 256-bit AES-256-GCM master key | Yes | `64-char-hex-string` |
| `SHOPIFY_CLIENT_ID` | Shopify App Client ID | Conditional | `shpa_12345678` |
| `SHOPIFY_CLIENT_SECRET` | Shopify App Client Secret | Conditional | `shps_12345678` |
| `SHOPIFY_SCOPES` | Requested Shopify OAuth scopes | No | `read_orders,read_fulfillments` |
| `WEBHOOK_MAX_PAYLOAD_BYTES` | Maximum webhook body size | No (1MB) | `1048576` |

---

## 4. Health Checks & Observability

### 4.1 Health Check Endpoints
- **HTTP Endpoint**: `GET /health` (acts as both liveness and readiness probe; no separate `/ready` or `/live` route)
- **Response Format**:
  ```json
  {
    "status": "ok",
    "timestamp": "2026-09-23T15:30:00.000Z",
    "services": {
      "database": { "status": "up" },
      "redis": { "status": "up" }
    }
  }
  ```
- **Load Balancer Target**: Configure health probe to `/health` with a 5-second interval and 3-second timeout. If database or Redis fails, returns HTTP 503 Service Unavailable.

### 4.2 Key Operational Metrics
1. **API Latency**: p95 < 150ms on operational dashboards; p99 < 50ms on webhook ingestion.
2. **Queue Lag**: Number of `QUEUED` jobs with `next_run_at <= NOW()`. An alert should trigger if lag exceeds 500 jobs for > 2 minutes.
3. **Dead-Letter Queue (DLQ)**: Count of jobs in `DEAD_LETTER` status:
   ```sql
   SELECT organization_id, type, COUNT(*)
   FROM jobs
   WHERE status = 'DEAD_LETTER'
   GROUP BY organization_id, type;
   ```
4. **Worker Liveness**: Worker records in `workers` table with `status = 'ACTIVE'` and `last_heartbeat_at >= NOW() - INTERVAL '30 SECONDS'`.

---

## 5. Routine Maintenance Procedures

### 5.1 Redis Memory Management
- Redis is configured with `maxmemory-policy: noeviction`. Queued jobs and lease locks must never be silently evicted under memory pressure.
- Regularly monitor memory usage via `redis-cli info memory`.

### 5.2 PostgreSQL Maintenance
High-churn tables (`jobs`, `job_attempts`, `integration_events`) require periodic maintenance:
```sql
VACUUM ANALYZE jobs;
VACUUM ANALYZE job_attempts;
VACUUM ANALYZE integration_events;
```

---

## 6. Backup & Disaster Recovery Procedures

### 6.1 Database Backup
Perform hourly full backups using `pg_dump`:
```bash
pg_dump -h localhost -p 5433 -U reloop -Fc reloop > /backups/reloop_$(date +%Y%m%d_%H%M%S).dump
```

### 6.2 Database Restoration
To restore from a backup file:
```bash
pg_restore -h localhost -p 5433 -U reloop -d reloop --clean --if-exists /backups/reloop_target.dump
```

### 6.3 Redis Persistence
Ensure both RDB snapshots and AOF (Append-Only File) are active in `redis.conf`:
```
save 300 10
appendonly yes
appendfsync everysec
```

### 6.4 Redis Reconstructability & State Recovery
Redis is treated as a high-performance message broker and ephemeral cache. PostgreSQL is the durable primary source of truth.
- In the event of catastrophic Redis data loss or corruption, flush the affected Redis instance (`redis-cli flushall`).
- Active and pending jobs are safely persisted in PostgreSQL `jobs` and `integration_events`.
- The Scheduler Daemon automatically sweeps PostgreSQL for pending and orphaned work and re-enqueues jobs to Redis.
- Realtime WebSocket clients automatically reconnect with exponential backoff and request fresh state via authenticated REST queries.

---

## 7. Incident Response Runbooks

### Runbook 1: PostgreSQL Outage / Connection Pool Exhaustion
**Symptoms**:
- API `/health` returns HTTP 503 (`database: down`).
- Workers report `PrismaClientInitializationError` or connection timeout errors.

**Action Steps**:
1. Inspect PostgreSQL container status:
   ```bash
   docker ps --filter "name=reloop-postgres"
   docker logs --tail 100 reloop-postgres
   ```
2. Check active connections in database:
   ```sql
   SELECT count(*), state FROM pg_stat_activity GROUP BY state;
   ```
3. If database crashed, restart container:
   ```bash
   docker compose restart postgres
   ```
4. Verify API recovery by pinging `/health`.

---

### Runbook 2: Redis Outage / Queue Stall
**Symptoms**:
- Realtime WebSocket updates cease.
- New jobs fail to dispatch to Redis Streams.

**Action Steps**:
1. Check Redis connectivity:
   ```bash
   docker compose exec redis redis-cli ping
   ```
2. If Redis is unresponsive, inspect logs and memory:
   ```bash
   docker logs --tail 100 reloop-redis
   ```
3. Restart Redis:
   ```bash
   docker compose restart redis
   ```
4. Core API and Worker instances automatically reconnect with exponential backoff.

---

### Runbook 3: Worker Node Crash & Orphaned Job Recovery
**Symptoms**:
- A worker process terminates unexpectedly (e.g. OOM, host crash).
- Jobs remain in `IN_PROGRESS` status without active execution.

**Action Steps**:
1. The **Scheduler Daemon** runs an automated sweeper every 30 seconds:
   - Queries `workers` where `last_heartbeat_at < NOW() - INTERVAL '45 SECONDS'`.
   - Marks those workers as `DEAD`.
   - Finds jobs where `status = 'IN_PROGRESS'` and `lease_expires_at < NOW()`.
   - Resets job status to `QUEUED` and increments attempt count.
2. If manual recovery is needed, execute the recovery SQL:
   ```sql
   UPDATE jobs
   SET status = 'QUEUED',
       claimed_by_worker_id = NULL,
       lease_expires_at = NULL
   WHERE status = 'IN_PROGRESS'
     AND lease_expires_at < NOW();
   ```

---

### Runbook 4: Webhook Replay Storm / Traffic Spike
**Symptoms**:
- Sudden surge of thousands of webhooks from Shopify or carrier integrations.
- Increased CPU utilization on API instances.

**Action Steps**:
1. **Reloop Webhook Ingestion Engine** is designed for high-concurrency ingestion:
   - HMAC verification and event insertion occur in < 20ms.
   - Compound index `(integration_id, provider_event_id)` automatically deduplicates retries.
   - Duplicates return `200 { status: 'ignored_duplicate' }` immediately without triggering downstream job processing.
2. If API instances approach memory limits, increase replica count behind load balancer.
3. Workers will consume the durable `integration_events` from the queue at a governed concurrency rate (10-25 workers), preventing downstream API rate-limiting against Shopify or ShipStation.

---

## 8. Graceful Shutdown & Drain

All Reloop services trap `SIGTERM` and `SIGINT` signals:

### Worker Drain Process
1. On receiving `SIGTERM`, worker marks its status as `STOPPING`.
2. Worker stops accepting new jobs from Redis / database.
3. In-flight jobs are allowed up to 30 seconds (`SHUTDOWN_TIMEOUT_MS`) to finish execution.
4. If a job cannot complete within the grace period, the lease lock is explicitly released so another worker can claim it immediately.
5. Database and Redis connections close cleanly before process exit.

---

## 9. Deployment Boundary & Infrastructure Scope

- **Topology Target**: Reloop is architected, tested, and validated for single-region multi-container Docker Compose or VM topologies.
- **Explicit Non-Claims**:
  - No Kubernetes operators, Helm charts, or multi-cluster mesh configurations are claimed or included in this release.
  - No multi-region active-active database replication or distributed Paxos/Raft consensus beyond PostgreSQL ACID transactions is claimed.
- **Vertical & Horizontal Scaling**:
  - API instances can be horizontally scaled behind a round-robin or least-connections HTTP load balancer with sticky sessions or shared Redis adapter for WebSockets.
  - Worker instances scale horizontally by increasing container replicas; concurrency is regulated by PostgreSQL `FOR UPDATE SKIP LOCKED` and Redis Streams consumer groups.

---

## 10. Production Transport Security Requirements

- **SSL/TLS Termination**: Internal microservices communicate over plaintext HTTP/WS within private Docker networks. Production deployments MUST terminate TLS at an edge reverse proxy (e.g. Cloudflare, AWS ALB, Nginx, Envoy).
- **Enforced Protocols**: All external client traffic must be forced to HTTPS (TLS 1.2+) and secure WebSockets (WSS).
- **Production Cookie Security**: The `reloop_refresh` cookie is configured with `sameSite: 'lax'`, `httpOnly: true`, and automatically sets `secure: true` when `NODE_ENV === 'production'`.
