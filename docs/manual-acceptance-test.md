# Reloop Manual Acceptance Testing Runbook (Day 24 Protocol)

**Target Audience:** Human Operator & Acceptance Tester
**Purpose:** Comprehensive interactive manual validation of the Reloop e-commerce reliability platform prior to v1.0.0 release.
**Execution Note:** Do not modify these test outcomes automatically. The human tester must execute each step in an interactive browser and record the actual result.

> [!IMPORTANT]
> **Testing Principle:** Pre-seeded synthetic database rows are provided strictly for layout inspection, screenshot capture, and exploratory navigation.
> **True behavioral acceptance tests (discrepancy detection, DAG execution, approval gating, and independent verification) must be triggered through real simulator and application webhook flows.**

---

## Environment Preparation

Before starting Section A, ensure infrastructure is running locally:
```bash
# 1. Start database & Redis
docker compose up -d

# 2. Apply migrations
npm run db:migrate

# 3. Start Core API (Terminal 1)
npm run dev --workspace=@reloop/api

# 4. Start Web Dashboard (Terminal 2)
npm run dev --workspace=@reloop/web

# 5. Start Worker Engine (Terminal 3)
npm run dev --workspace=@reloop/worker

# 6. Start Scheduler Sweeper (Terminal 4)
npm run dev --workspace=@reloop/scheduler
```

---

## Section A: Startup & Login

### A.1 Initial Application Boot
- **Action:** Open a clean browser window (or incognito window) and navigate to `http://localhost:3100`.
- **Expected:** Browser automatically redirects unauthenticated requests to `http://localhost:3100/login`. The login card renders cleanly with email and password inputs.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

### A.2 Invalid Credential Rejection
- **Action:** Enter `operator@reloop.test` with an incorrect password (e.g., `WrongPassword!`) and click **Sign In**.
- **Expected:** Login is rejected. An error alert displays indicating invalid credentials. No access token or session cookie is granted.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

### A.3 Valid Tenant Authentication
- **Action:** Enter valid local demo credentials:
  - Email: `operator@reloop.test`
  - Password: `Password123!`
  Click **Sign In**.
- **Expected:** Authentication succeeds immediately. Browser transitions to `http://localhost:3100/dashboard`. Top navigation displays organization name `Acme Commerce Group` and user avatar `JM (Jordan Miller, OWNER)`.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section B: Dashboard, Navigation & Direct URLs

### B.1 Dashboard Metrics Rendering
- **Action:** Inspect the main dashboard metrics cards at `/dashboard`.
- **Expected:** Open Exceptions, Needs Approval, Blocked Cases, and System Feed render numeric counts and status cards without layout shifts or raw error text.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

### B.2 Navigation Sidebar Links
- **Action:** Click through each primary navigation item in the sidebar:
  1. `Exceptions` (`/exceptions`)
  2. `Orders` (`/orders`)
  3. `Recoveries` (`/recoveries`)
  4. `Integrations` (`/integrations`)
  5. `System Health` (`/health`)
- **Expected:** Each page loads within 500ms, highlights the corresponding active sidebar link, and renders its header and tabular content correctly.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

### B.3 Direct URL Refresh & Deep Linking
- **Action:** Navigate to `http://localhost:3100/health` and press `Ctrl+F5` (hard refresh).
- **Expected:** Page reloads cleanly without redirecting to `/login` or displaying a blank screen. Session persistence keeps user authenticated.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section C: Create Discrepancy via Real Simulator Flow

### C.1 Trigger Simulated Out-of-Order Webhook
- **Action:** Open terminal and trigger a simulated webhook event representing an order marked fulfilled at 3PL but missing tracking in Shopify:
  ```bash
  curl -X POST http://localhost:3101/webhooks/simulator \
    -H "Content-Type: application/json" \
    -d '{"eventType": "ORDER_SHIPPED_3PL", "orderNumber": "TEST-7001", "carrier": "UPS", "trackingNumber": "1Z9999999999999999", "requiresApproval": true}'
  ```
- **Expected:** Endpoint returns `202 Accepted` with a valid JSON response containing `eventId`.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section D: Exception Appears

### D.1 Exception Queue Realtime Ingestion
- **Action:** Observe the open `/exceptions` page in the browser (do not click manual refresh).
- **Expected:** Within 2 seconds of the webhook POST, the new exception for `TEST-7001` (`TRACKING_MISSING_IN_SHOPIFY` or `SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY`) appears in the queue via realtime invalidation.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section E: Open Exception & Inspect Evidence

### E.1 Exception Detail Inspection
- **Action:** Click **Inspect** on the newly created `TEST-7001` incident row.
- **Expected:** The exception detail view displays:
  1. Discrepancy summary and incident type.
  2. Associated external order reference (`TEST-7001`).
  3. Raw structured evidence panel displaying carrier (`UPS`), tracking number (`1Z9999999999999999`), and timestamp.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section F: AUTO_INVESTIGATE Flow

### F.1 Low-Risk Auto-Investigation Execution
- **Action:** Dispatch a simulated transient API mismatch:
  ```bash
  curl -X POST http://localhost:3101/webhooks/simulator \
    -H "Content-Type: application/json" \
    -d '{"eventType": "TRANSIENT_SYNC_LAG", "orderNumber": "TEST-7002", "recoveryLevel": "AUTO_INVESTIGATE"}'
  ```
- **Expected:** The engine marks the recovery case `INVESTIGATING`, launches the automated investigation DAG step, queries the mock API, and transitions status automatically without human prompt.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section G: REQUIRE_APPROVAL Flow

### G.1 Policy-Enforced Human Approval Gate
- **Action:** Inspect the recovery detail view for `TEST-7001` (`/recoveries/[id]`).
- **Expected:** Status is `WAITING_APPROVAL`. The Operator Approval Request panel renders in amber with clear warning: *"Human Operator Gate Required. This recovery action mutates commercial records and requires human verification."* Action controls (**Approve Recovery** and **Reject Recovery**) are clearly visible.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section H: Approve Flow

### H.1 Operator Approval Execution
- **Action:** On the pending approval panel for `TEST-7001`, click **Approve Recovery**. In the confirmation dialog, enter audit note: `"Approved after carrier validation"` and confirm.
- **Expected:**
  1. Button transitions to loading state; double-clicks are ignored.
  2. Dialog closes.
  3. Status immediately transitions to `RECOVERING`.
  4. DAG step 2 (`EXECUTE_RECOVERY`) begins processing in the worker log.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section I: Reject Flow

### I.1 Trigger and Reject Risky Recovery
- **Action:**
  1. Post a new discrepancy:
     ```bash
     curl -X POST http://localhost:3101/webhooks/simulator \
       -H "Content-Type: application/json" \
       -d '{"eventType": "ORDER_SHIPPED_3PL", "orderNumber": "TEST-7003", "trackingNumber": "1Z8888888888888888", "requiresApproval": true}'
     ```
  2. Open the created recovery case and click **Reject Recovery**.
  3. Submit rejection with reason: `"Customer requested address change prior to dock dispatch"`.
- **Expected:** Case status transitions permanently to `BLOCKED` (or `CANCELLED`). Downstream execution steps are marked `SKIPPED`. No upstream mutation is attempted.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section J: Verification Success

### J.1 End-State Verification & Resolution
- **Action:** Re-inspect case `TEST-7001` after approval has executed.
- **Expected:**
  1. Worker executes `VERIFY_STATE` step against the mock provider.
  2. Once verified, case status transitions to `RESOLVED`.
  3. Flight Recorder timeline displays the complete lifecycle: `1. CHECK → 2. GATE / APPROVAL → 3. EXECUTE → 4. VERIFY → RESOLVED`.
  4. Green "Verified Resolution" badge is prominently displayed.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section K: HTTP Success but Verification Failure

### K.1 Guardrail: Independent Verification Failure
- **Action:** Dispatch a test case configured to simulate an upstream endpoint returning HTTP 200 OK while the data remains desynchronized:
  ```bash
  curl -X POST http://localhost:3101/webhooks/simulator \
    -H "Content-Type: application/json" \
    -d '{"eventType": "SIMULATE_GHOST_WRITE", "orderNumber": "TEST-7004"}'
  ```
- **Expected:**
  1. Execution step finishes with HTTP 200.
  2. Step 4 `VERIFY_STATE` detects that upstream state STILL mismatches.
  3. Case is **NOT** marked resolved.
  4. UI explicitly displays `Verification Failed (Not Resolved)` with warning banner.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section L: BLOCK / Duplicate-Risk Case

### L.1 Duplicate Order Hazard Prevention
- **Action:** Dispatch two identical shipment events simultaneously with duplicate tracking numbers on different order IDs:
  ```bash
  curl -X POST http://localhost:3101/webhooks/simulator \
    -H "Content-Type: application/json" \
    -d '{"eventType": "DUPLICATE_ORDER_RISK", "orderNumber": "TEST-7005", "duplicateKey": "DUP-TRACK-999"}'
  ```
- **Expected:** Reliability engine flags `DUPLICATE_RISK`, assigns recovery level `BLOCK`, prevents automated execution, and halts the incident safely until human intervention.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section M: Two-Browser Realtime Behavior

### M.1 Multi-Window Synchronous Invalidation
- **Action:** Open two browser windows side by side (Window 1 on `/dashboard`, Window 2 on `/exceptions`). In a third terminal window, trigger a new exception via curl.
- **Expected:** Both windows update simultaneously without page refreshes. Window 1 increments the Open Exceptions counter; Window 2 prepends the new row into the table within 2 seconds.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section N: Integration UX & Security Hygiene

### N.1 Credential Secrecy Verification
- **Action:** Navigate to `http://localhost:3100/integrations` and inspect the ShipStation adapter card.
- **Expected:**
  1. Card displays `Credential configured` with green healthy badge.
  2. **No** plain-text API key, prefix, suffix, or hashed fragment is exposed in the DOM or network response.
  3. Clicking **Replace Key** opens a password-masked modal input that clears immediately on cancel.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section O: API Gateway Restart

### O.1 API Resilience Under In-Flight Client Requests
- **Action:** Kill the NestJS API process (`Ctrl+C` in Terminal 1). Wait 3 seconds, then restart it (`npm run dev --workspace=@reloop/api`). Refresh the browser dashboard.
- **Expected:** Once restarted, the dashboard reconnects automatically. Socket.IO re-establishes connection and displays `Connected`.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section P: Worker Daemon Restart

### P.1 Worker Crash & Lease Recovery
- **Action:** Trigger a long-running recovery case. While the worker log indicates step execution is underway, terminate the worker process (`Ctrl+C` in Terminal 3). Wait 5 seconds, then restart the worker.
- **Expected:** The scheduler detects the expired worker claim or Redis stream re-delivers the pending item. The job is recovered and completed without corrupting the case state.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section Q: Scheduler Daemon Restart

### Q.1 Scheduler Recovery
- **Action:** Stop and restart the Scheduler process (`Terminal 4`).
- **Expected:** On startup, the scheduler performs an initial database sweep, logs eligible jobs, and resumes its periodic heartbeat interval with zero errors.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section R: Redis Restart

### R.1 Ephemeral Redis Outage Handling
- **Action:** Restart the Redis container via Docker: `docker restart reloop-redis`. Observe the API, worker, and scheduler terminal logs.
- **Expected:**
  1. Services log reconnection attempts with exponential backoff.
  2. Once Redis completes boot (within 2 seconds), all services reconnect cleanly.
  3. PostgreSQL retains all durable records; zero cases or orders are dropped.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section S: Responsive & Mobile Sanity

### S.1 Viewport Scaling Check
- **Action:** Open Chrome DevTools (`F12`), toggle device toolbar, and select **iPhone 14 Pro (393x852)** and **iPad Air (820x1180)**.
- **Expected:**
  1. Navigation collapses into a mobile drawer or accessible menu.
  2. Tabular cards scroll horizontally or collapse into stacked cards without horizontal viewport breaking.
  3. Primary action buttons (Approve / Reject) remain tappable without overlapping text.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Section T: Final Visual & Usability Judgment

### T.1 Overall Visual Cohesion & B2B Ergonomics
- **Action:** Walk through the complete user journey as a logistics operations director.
- **Expected:** Typography, spacing, color coding (amber for pending approvals, green for resolved, red for blocked), and response latencies convey a dependable, production-grade enterprise software experience.
- **Result:** [ ] PASS  [ ] FAIL
- **Notes:**

---

## Acceptance Sign-Off

- **Tester Name:** __________________________________
- **Date Tested:** __________________________________
- **Git Commit Hash Tested:** _______________________
- **Overall Recommendation:** [ ] ACCEPT FOR RELEASE (v1.0.0)  [ ] REJECT / DEFECTS BLOCKING
- **Summary Feedback:**
