# Reloop: E-Commerce Reliability & Recovery Engine

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15.5-black.svg)](https://nextjs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10.4-red.svg)](https://nestjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-5.22-teal.svg)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue.svg)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-red.svg)](https://redis.io/)
[![Security Audit](https://img.shields.io/badge/Vulnerabilities-0%20Critical-brightgreen.svg)]()
[![Release](https://img.shields.io/badge/Release%20Candidate-v0.1.0--rc1-orange.svg)]()

> **Core Operating Invariant:**
> `CHECK -> GATE / APPROVAL -> EXECUTE -> VERIFY -> RESOLVED`
> Reloop never mutates upstream state blindly, never assumes eventual consistency resolved an error, and never marks an incident resolved until independent cross-system verification confirms total agreement.

---

## 1. Overview & Problem Statement

Modern multi-channel e-commerce is fundamentally distributed and asynchronous. Orders, fulfillments, inventory, and tracking information flow across disjointed SaaS platforms (e.g., Shopify storefronts, 3PL warehouse management systems like ShipStation, ERPs, and carrier APIs).

At integration boundaries, failure is inevitable:
- **Webhook Drops & Out-of-Order Delivery**: Shipments are created before fulfillment orders are acknowledged, or tracking numbers fail to register in the storefront.
- **Cascading Retries & Double Actions**: Naive retries during intermittent API timeouts generate duplicate shipments, double-refunds, or trigger upstream rate limits.
- **Silent Desynchronization**: A customer service agent cancels an order in Shopify while a 3PL worker is packing it on the warehouse floor; the parcel ships anyway.

**Reloop provides a dedicated reliability and recovery layer for multi-channel commerce.** It ingests authenticated provider events and triggered sync results, reconciles cross-system entities against a single operational truth, isolates discrepancies into explicit **Recovery Cases**, orchestrates multi-step **DAG Workflows**, halts hazardous actions behind **Human Operator Approval Gates**, and durably records every state transition in an append-only **Flight Recorder**.

---

## 2. Core Operational Workflow

```mermaid
flowchart LR
    A["1. CHECK<br/>(Reconcile State)"] --> B{"Policy Check"}
    B -->|High Value / Risk| C["2. GATE / APPROVAL<br/>(Human in the Loop)"]
    B -->|Safe Automation| D["3. EXECUTE<br/>(Idempotent Action)"]
    C -->|Operator Approved| D
    C -->|Operator Rejected| E["ABORTED / BLOCKED"]
    D --> F["4. VERIFY<br/>(Cross-System Audit)"]
    F -->|State Matches| G["5. RESOLVED"]
    F -->|Mismatch Persists| H["RE-SCHEDULE / ALERT"]

    style A fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#f8fafc
    style B fill:#334155,stroke:#94a3b8,stroke-width:2px,color:#f8fafc
    style C fill:#451a03,stroke:#f97316,stroke-width:2px,color:#ffedd5
    style D fill:#1e293b,stroke:#3b82f6,stroke-width:2px,color:#f8fafc
    style E fill:#450a0a,stroke:#ef4444,stroke-width:2px,color:#fee2e2
    style F fill:#1e293b,stroke:#8b5cf6,stroke-width:2px,color:#f8fafc
    style G fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#ecfdf5
    style H fill:#451a03,stroke:#eab308,stroke-width:2px,color:#fefce8
```

---

## 3. System Architecture & Component Roles

Reloop enforces a clean separation of concerns between durable storage, distributed execution, and client visualization:

- **PostgreSQL = Durable Source of Truth**: All tenant models, external orders, integration events, recovery cases, workflows, approval gates, and flight recorder audit logs are stored durably with relational integrity.
- **Redis = Dispatch, Coordination & Realtime Infrastructure**: Provides Redis Streams for work distribution, distributed Redlock leases for mutual exclusion, and Pub/Sub for lightweight invalidation signals. Redis is **not** treated as durable state of record.
- **Scheduler = Durable Job Rediscovery**: Periodically sweeps PostgreSQL to discover eligible execution candidates, detect expired worker leases, and dispatch work into Redis Streams.
- **Worker = Claim, Lease, Execute, Verify**: Atomically claims jobs from Redis Streams, holds a renewal lease, executes DAG steps idempotently, and independently verifies post-action consistency through authoritative adapter reads before writing final state to PostgreSQL. V1 recovery writes remain simulator-only.
- **Realtime Notifications = Invalidation Signals**: WebSockets (via Socket.IO) transmit lightweight cache invalidation signals; the browser refetches authoritative state from REST endpoints backed by PostgreSQL.

```mermaid
flowchart TB
    subgraph ClientLayer["Client & Dashboard Layer"]
        Web["@reloop/web (Next.js 15.5 App Router)"]
        BrowserWS["Socket.IO Client (Realtime Invalidation)"]
    end

    subgraph ApiGateway["API & Ingestion Plane"]
        API["@reloop/api (NestJS Core API)"]
        AuthGuards["Tenant Isolation & JWT Auth Guards"]
        WebhookController["Webhook Ingestion Endpoints (HMAC Verified)"]
        WSGateway["WebSocket Invalidation Gateway"]
    end

    subgraph MessagingStorage["Durable Storage & Concurrency Engine"]
        Postgres[("PostgreSQL 16 Database<br/>Authoritative Durable Source of Truth")]
        RedisQueue[("Redis 7: Streams & Distributed Redlock<br/>Dispatch & Coordination Infrastructure")]
        RedisPubSub[("Redis Pub/Sub<br/>Cache Invalidation Fanout")]
    end

    subgraph EngineWorkers["Reliability & Execution Engine"]
        ReconciliationEngine["@reloop/reconciliation-core<br/>Cross-System Discrepancy Detector"]
        DAGOrchestrator["Workflow DAG Engine<br/>Dependency Resolver & Steps"]
        WorkerService["@reloop/worker<br/>Distributed Job Consumers"]
        SchedulerService["@reloop/scheduler<br/>Durable Job Sweeper"]
    end

    subgraph IntegrationsExternal["Integration Adapters"]
        ShopifyConnector["@reloop/connector-shopify<br/>(OAuth, Webhook HMAC, REST/GraphQL)"]
        ShipStationConnector["@reloop/connector-shipstation<br/>(API Key Auth, Rate Limiter, Polling)"]
        SimulatorConnector["@reloop/connector-simulator<br/>(Reverse Logistics & Fault Injection)"]
    end

    Web -->|HTTP / REST| API
    BrowserWS <-->|WebSocket| WSGateway
    API --> AuthGuards
    AuthGuards --> WebhookController
    WebhookController --> Postgres
    WebhookController --> RedisQueue
    API <--> Postgres
    WSGateway <--> RedisPubSub

    WorkerService <--> RedisQueue
    WorkerService <--> Postgres
    WorkerService --> DAGOrchestrator
    DAGOrchestrator --> ReconciliationEngine
    WorkerService --> RedisPubSub

    SchedulerService --> RedisQueue
    SchedulerService --> Postgres

    DAGOrchestrator --> ShopifyConnector
    DAGOrchestrator --> ShipStationConnector
    DAGOrchestrator --> SimulatorConnector
```

---

## 4. Operational Invariant Pipelines

### A. Webhook Ingestion & Deduplication Pipeline
Webhooks from external providers arrive unpredictably and may be retransmitted multiple times. Reloop guarantees deduplication and idempotency at the edge:

```mermaid
sequenceDiagram
    autonumber
    actor Provider as Upstream Provider (Shopify/3PL)
    participant Ingest as Webhook Ingestion Endpoint
    participant DB as PostgreSQL (Tenant Scoped)
    participant Queue as Redis Job Queue
    participant Worker as Background Worker

    Provider->>Ingest: POST /webhooks/:provider (with HMAC Signature)
    Ingest->>Ingest: Verify HMAC-SHA256 & Timestamp Freshness
    alt Invalid Signature or Replay (>5m)
        Ingest-->>Provider: 401 Unauthorized / 400 Bad Request
    else Valid Payload
        Ingest->>DB: INSERT INTO integration_events ON CONFLICT (dedup_hash) DO NOTHING
        alt Duplicate Event
            Ingest-->>Provider: 200 OK (Ignored Duplicate)
        else New Event
            Ingest->>Queue: Push INGEST_EVENT Job
            Ingest-->>Provider: 202 Accepted { eventId }
            Queue->>Worker: Consume Event
            Worker->>DB: Parse Order / Shipment State
            Worker->>Worker: Trigger Reconciliation Evaluation
        end
    end
```

### B. Recovery Case & DAG Execution Pipeline
When a cross-system discrepancy is detected, Reloop initiates a controlled recovery workflow:

```mermaid
flowchart TD
    Detect["Discrepancy Detected (e.g. Tracking Missing in Shopify)"] --> CreateCase["Create RecoveryCase (Status: OPEN)"]
    CreateCase --> GenDAG["Generate Workflow DAG Steps"]
    GenDAG --> EvaluatePolicy{"Evaluate Policy Rule"}

    EvaluatePolicy -->|High Risk Action| Gate["Step 1: REQUEST_APPROVAL<br/>Case Status: WAITING_APPROVAL"]
    Gate --> HumanReview{"Human Operator Action"}
    HumanReview -->|Approve| ExecStep["Step 2: EXECUTE_RECOVERY<br/>Case Status: RECOVERING"]
    HumanReview -->|Reject| BlockStep["Case Status: BLOCKED / CANCELLED"]

    EvaluatePolicy -->|Low Risk / Safe Mode| ExecStep

    ExecStep --> AcquireLock["Acquire Distributed Redlock (Entity Key)"]
    AcquireLock --> SimulatorAction["Execute Simulator-Backed Recovery Action<br/>(Real Providers Remain Read-Only)"]
    SimulatorAction --> StepVerify["Step 3: VERIFY_STATE<br/>Case Status: VERIFYING"]
    StepVerify --> CrossQuery["Query Upstream Provider API"]
    CrossQuery --> ValidateCheck{"State Synchronized?"}

    ValidateCheck -->|Yes| Resolved["Case Status: RESOLVED<br/>Write Immutable Flight Recorder Log"]
    ValidateCheck -->|No| RetryPolicy{"Max Retries Reached?"}
    RetryPolicy -->|No| Backoff["Exponential Backoff Delay"] --> ExecStep
    RetryPolicy -->|Yes| MarkFailed["Case Status: FAILED<br/>Notify Operator"]
```

---

## 5. Operational UI Gallery

Reloop includes an operational web UI built with **Next.js 15.5 App Router**, **Tailwind CSS**, and **Socket.IO Realtime Invalidation**.

| Screen | Description | Reference Asset |
| :--- | :--- | :--- |
| **Operations Dashboard** (`/dashboard`) | Command center displaying open exceptions, pending human gates, blocked cases, and live system feed. | [`02-dashboard-overview.png`](docs/assets/screenshots/02-dashboard-overview.png) |
| **Exception Queue** (`/exceptions`) | Multi-channel incident queue with multi-facet filtering (status, recovery level, incident type, provider). | [`03-exceptions-queue.png`](docs/assets/screenshots/03-exceptions-queue.png) |
| **Recovery Detail & DAG View** (`/recoveries/[id]`) | DAG workflow visualization, interactive human approval gate with preview diff, and Flight Recorder audit trail. | [`04-recovery-detail.png`](docs/assets/screenshots/04-recovery-detail.png) |
| **Cross-System Orders** (`/orders`) | Multi-provider order reconciliation view highlighting discrepancies between Shopify and warehouse systems. | [`05-orders-reconciliation.png`](docs/assets/screenshots/05-orders-reconciliation.png) |
| **Integrations Hub** (`/integrations`) | External adapter management, OAuth state, sync recency, safety guardrails (read-only mode enforcement). | [`06-integrations-hub.png`](docs/assets/screenshots/06-integrations-hub.png) |
| **System Operational Health** (`/health`) | Infrastructure observability, component connectivity (Postgres, Redis), and provider rate-limit telemetry. | [`07-system-health.png`](docs/assets/screenshots/07-system-health.png) |
| **Secure Authentication** (`/login`) | Tenant-isolated user authentication portal. | [`01-login-screen.png`](docs/assets/screenshots/01-login-screen.png) |

---

### Operations Dashboard Overview
![Dashboard Overview](docs/assets/screenshots/02-dashboard-overview.png)

### Exception Management Queue
![Exception Queue](docs/assets/screenshots/03-exceptions-queue.png)

### Recovery Case, Human Approval Gate & Flight Recorder
![Recovery Detail](docs/assets/screenshots/04-recovery-detail.png)

### Cross-System Order Reconciliation Table
![Orders Reconciliation](docs/assets/screenshots/05-orders-reconciliation.png)

---

## 6. Monorepo Structure

The project is structured as an npm monorepo with 14 cohesive, decoupled workspaces:

```
reloop/
├── apps/
│   ├── api/                    # NestJS Core API (Port 3101: REST, Webhooks, Auth, WebSockets)
│   ├── web/                    # Next.js 15.5 App Router Dashboard (Port 3100)
│   ├── worker/                 # Distributed Stream Worker Daemon
│   ├── scheduler/              # Cron Polling & Durable Job Sweeper
│   └── simulator/              # Reverse Logistics Simulation Server
├── packages/
│   ├── contracts/              # Shared DTOs, Enums, Interfaces & API Contracts
│   ├── database/               # Prisma Schema, Database Client & Migrations
│   ├── integration-sdk/        # Base Connector interfaces, rate-limiters, safe wrappers
│   ├── reconciliation-core/    # Discrepancy detection engine & comparison rules
│   ├── workflow-core/          # Multi-step DAG orchestrator & state machine
│   ├── common/                 # Logging, telemetry, encryption, Redlock primitives
│   └── testing/                # Shared test fixtures, mock servers & harness utilities
└── connectors/
    ├── connector-shopify/      # Shopify OAuth, REST/GraphQL clients, webhook verification
    ├── connector-shipstation/  # ShipStation REST adapter, tracking sync, polling
    ├── connector-simulator/    # Fault-injection engine & reverse logistics simulator
    └── connector-generic-3pl/  # Generic 3PL contract specifications
```

---

## 7. Zero-to-Running Local Quickstart

### Prerequisites
- **Node.js**: v20.x, v22.x, or v24 LTS
- **Docker & Docker Compose**: Docker Engine 24+ / Docker Desktop
- **npm**: v10+

### Step 1: Clone & Install Dependencies
```bash
git clone https://github.com/reloop-io/reloop.git
cd reloop
npm install
```

### Step 2: Environment Configuration
Copy the template configuration:
```bash
cp .env.example .env
```
*(Ensure `DATABASE_URL` references host port `5433` and `REDIS_URL` references host port `6380` as configured in `docker-compose.yml`.)*

### Step 3: Start Infrastructure Services
Start the dedicated PostgreSQL 16 and Redis 7 containers:
```bash
docker compose up -d
```
Verify container health:
```bash
docker compose ps
```

### Step 4: Run Database Migrations
Apply database schema migrations:
```bash
npm run db:migrate
```

### Step 5: Seed Synthetic Demonstration Data (Optional Local Navigation)
Populate the database with synthetic demonstration data for UI inspection and navigation:
```bash
npx ts-node scripts/seed-rich-demo-data.ts
```

### Step 6: Start Applications
In separate terminal tabs (or background processes):
```bash
# Terminal 1: Core API Gateway (Port 3101)
npm run dev --workspace=@reloop/api

# Terminal 2: Web Dashboard (Port 3100)
npm run dev --workspace=@reloop/web

# Terminal 3: Reliability Worker Daemon
npm run dev --workspace=@reloop/worker

# Terminal 4: Durable Scheduler Sweeper
npm run dev --workspace=@reloop/scheduler

# Terminal 5 (Optional): Reverse Logistics Simulator
npm run dev --workspace=@reloop/simulator
```

### Demonstration Credentials
> [!NOTE]
> **LOCAL DEVELOPMENT DEMO ONLY**: These credentials access synthetic mock data generated by `scripts/seed-rich-demo-data.ts`. They are not for production use.
- **URL**: `http://localhost:3100/login`
- **Email**: `operator@reloop.test`
- **Password**: `Password123!`
- **Organization**: `Acme Commerce Group` (Role: `OWNER`)

---

## 8. Security & Tenancy Invariants

Reloop is designed under a zero-trust multi-tenant model:

1. **Strict Tenant Data Isolation**: Every relational entity is constrained by `organizationId`. Queries enforce composite uniqueness (`@@unique([organizationId, ...])`). Cross-tenant access is prevented at both the ORM and guard levels.
2. **Short-Lived Access Tokens & Rotation**:
   - Access tokens: Stateless JWT signed with HS256, 15-minute expiration.
   - Refresh tokens: Secure, HTTP-only, `SameSite=Lax` cookies, single-use with cryptographic rotation and server-side revocation tables.
3. **Envelope Encryption for Third-Party Credentials**:
   - Upstream API keys, OAuth tokens, and secrets are encrypted at rest using AES-256-GCM with unique initialization vectors (`iv`) and authentication tags (`authTag`).
4. **Webhook Signature Verification & Replay Protection**:
   - Ingested webhooks require valid HMAC-SHA256 signatures matching the registered tenant provider secret.
   - Ingestion enforces a 5-minute timestamp validity window to prevent replay attacks.
5. **Human Operator Approval Gate**:
   - Destructive or high-impact actions (e.g., initiating returns, manual fulfillments, cross-provider cancellations) cannot execute autonomously unless authorized by an authenticated operator with `ADMIN` or `OWNER` privileges.
6. **Vulnerability-Free Core Dependencies**:
   - Monorepo dependency audit reports **0 critical vulnerabilities**, validated under strict `npm audit` standards.

---

## 9. Verification & Empirical Benchmarks

### LOCAL DEVELOPMENT MACHINE BENCHMARK
> [!NOTE]
> The following throughput figures represent a **local development machine benchmark** run under controlled developer hardware conditions. They do not claim distributed cloud production capacity.

- **Sustained Throughput Repeatability Benchmark**:
  - Tested with a bounded 10,000-job workload repeated across three independent runs under identical configuration:
    - **Run 1:** 300.1 completed jobs/sec
    - **Run 2:** 339.1 completed jobs/sec
    - **Run 3:** 372.4 completed jobs/sec
    - **Median Throughput:** On the final three-run local benchmark, median completed throughput was **339.1 jobs/sec** (exceeding the >= 250 completed jobs/sec local target).
  - All three runs achieved:
    - 10,000 / 10,000 jobs completed
    - 0 duplicate business effects
    - 0 blocked jobs
    - 0 dead-lettered jobs
    - 0 unfinished jobs
- **Webhook Ingestion Capacity**:
  - 100 events/sec target load passed with 0 drops.
  - Saturated load test: When 150 events/sec offered load was applied, the local ingestion endpoint saturated at ~107.8 accepted events/sec without data corruption or memory exhaustion (150 events/sec offered load was not supported on single-node local configuration; it saturated gracefully).
- **Fault-Injection & Chaos Testing**:
  - Redis connection loss: Automatic backoff reconnection, Redlock lease recovery, and zero in-flight task corruption.
  - Worker process crash during execution: Heartbeat reaper detects abandoned claims and safely re-enqueues jobs without duplicate execution.
  - Concurrent duplicate webhook storms: Ingestion deduplication hash drops 100% of duplicate payloads at the persistence layer.
- **Automated Regression Suite**:
  - 518 passing unit and integration tests across all 14 workspaces.
  - 41 automated security matrix assertions verifying RBAC, CSRF, and tenant isolation.
  - 100% TypeScript compile-time type safety with zero lint errors.

---

## 10. Known Limitations & V1 Non-Goals

### Known Limitations
- **Local Benchmark Evidence**: Throughput and stress measurements were conducted on local developer hardware; performance under distributed multi-region cloud topologies will depend on network latency and provisioned IOPS.
- **Single-Region Architecture**: The V1 architecture is designed for single-region deployments; active-active multi-region database replication is not implemented.
- **Real Provider Credentials**: Live read-only integration smoke testing against real Shopify storefronts and ShipStation accounts requires valid developer credentials and merchant account permissions.
- **Remaining Development Dependencies**: While runtime critical vulnerabilities are at 0, transitive dev-only dependencies report low/moderate advisories.
- **V1 Recovery Scope**: Automated recovery actions in V1 are simulator-backed demonstrations of order-discrepancy, fulfillment-synchronization, and tracking-update workflows; real Shopify and ShipStation integrations remain read-only.

### V1 Non-Goals (Explicitly Out of Scope)
The following capabilities are deliberately outside the scope of Reloop V1:
- Automated financial refunds or payment gateway chargebacks
- Upstream order cancellations or automated returns/RMA processing
- Inventory demand forecasting or inventory replenishment
- Complete replacement of Warehouse Management Systems (WMS)
- Visual drag-and-drop workflow builders or arbitrary user script execution
- Custom organizational roles or dynamic permission builders
- Single Sign-On (SSO / SAML / Okta)
- Commercial billing, subscription management, or meter tracking
- AI / LLM autonomous decision agents
- Multi-region active-active distributed clusters
- Apache Kafka message brokers
- Kubernetes orchestration manifests

---

## 11. Technology Stack

- **Monorepo Management**: npm Workspaces
- **Backend Framework**: NestJS, Express, Socket.IO
- **Frontend Framework**: Next.js 15.5 (App Router), React 18, Tailwind CSS, Lucide Icons
- **Database & Modeling**: PostgreSQL 16, Prisma ORM
- **Queue & Coordination**: Redis 7 Streams, IORedis, Redlock
- **Language & Runtime**: TypeScript 5.7, Node.js 20+
- **Security & Cryptography**: Argon2, Node Crypto (AES-256-GCM, HMAC-SHA256)
- **Containerization**: Docker, Docker Compose

---

## 12. Supporting Documentation

- [System Architecture Specification](docs/architecture.md): Topology, component responsibilities, and failure mode analysis.
- [Manual Acceptance Testing Runbook](docs/manual-acceptance-test.md): Human acceptance test protocol for Day 24 validation.
- [Release Checklist](docs/release-checklist.md): Pre-release milestone tracking and verification gates.
- [Portfolio & Engineering Notes](docs/portfolio-notes.md): Technical deep-dive and architectural rationale for interviews.

---

## 13. License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
