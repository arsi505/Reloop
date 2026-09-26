# Reloop Screen Map & UX Navigation Architecture

This document specifies the information architecture, primary/supporting actions, state variations, and responsive behavior across all customer-facing screens in Reloop.

---

## 1. Global Navigation & Layout Shell

Reloop utilizes a focused, calm B2B layout:
- **Collapsible Left Sidebar**: Fixed-width (240px expanded, 64px collapsed icon-only) containing the brand selector, primary navigation items, system health indicator, and organization profile.
- **Top Utility Bar**: Fixed height (56px) displaying current environment mode (`SHADOW: OBSERVE`, `RECOMMEND`, `APPROVAL`, or `LIVE`), global search (by Order #, Tracking #, or Customer Email), and user profile / notifications.
- **Main Viewport**: Fluid content area with consistent max-width containers (1440px) designed for dense operational tables and clean detail panes.

---

## 2. Primary Navigation Screens

### 1. Dashboard (`/dashboard`)
* **Purpose**: High-level operational command center providing real-time visibility into order health, active discrepancies, pending approvals, and integration status.
* **Main Information**:
  - Operational KPIs:
    - **Orders Checked (Last 24h)**: Total throughput evaluated.
    - **Active Problems**: Current count of un-resolved exceptions.
    - **Auto-Recovered (Last 24h)**: Volume of incidents autonomously resolved and verified.
    - **Waiting for Approval**: High-priority count of actions requiring human sign-off.
    - **Blocked**: Critical issues locked due to risk (duplicate risk, invalid data).
  - **Integration Health Strip**: Quick status pills for Shopify, ShipStation, and 3PL (Healthy, Degraded, Down).
  - **Recent Recovery Activity Table**: Latest 5 executions with order number, problem type, recovery level, and current convergence state.
  - **Problem Trends Card**: 7-day bar breakdown by failure category (e.g., API timeouts vs. tracking syncs vs. invalid addresses) to spot systemic warehouse/carrier issues.
* **Primary Actions**:
  - `Review Approvals`: Deep link directly to Exceptions filtered by `WAITING_APPROVAL`.
  - `View Blocked`: Deep link to Exceptions filtered by `BLOCKED`.
* **Supporting Actions**:
  - Date range selector (Last 24h, Last 7d, Last 30d).
  - Refresh data button.
* **Empty State**:
  - Displayed when no orders have been synced yet or store is completely healthy: *"All systems in sync. 0 active exceptions across connected stores."* Clean checkmark illustration with prompt to check Integrations.
* **Error State**:
  - Banner: *"Unable to load real-time metrics. Retrying connection..."* with manual `Retry` button and fallback to cached timestamp.
* **Mobile Behavior**:
  - KPI cards stack into a 2x2 grid, then single column on narrow viewports.
  - Trends chart switches to a simplified table summary.
  - Quick action buttons become full-width floating action bar.

---

### 2. Exceptions Inbox (`/exceptions`)
* **Purpose**: The primary operational workhorse screen for triaging, investigating, and resolving cross-system discrepancies.
* **Main Information**:
  - Filterable, searchable data table displaying:
    - **Severity & Status Badge**: `OPEN`, `INVESTIGATING`, `READY_FOR_RECOVERY`, `WAITING_APPROVAL`, `RECOVERING`, `VERIFYING`, `RESOLVED`, `BLOCKED`, `FAILED`.
    - **Order Identifier**: Shopify Order Number (e.g., `#10492`) with customer name.
    - **Problem Type**: One of the 8 canonical failure cases (e.g., *Tracking Missing in Shopify*, *Shopify Order Missing at 3PL*).
    - **Affected Integration**: System logo / badge (Shopify, 3PL, ShipStation).
    - **Recovery Level**: `AUTO_RECOVER`, `AUTO_INVESTIGATE`, `REQUIRE_APPROVAL`, `BLOCK`.
    - **Detected Time**: Relative timestamp (e.g., `12m ago`) with absolute hover.
    - **Assignee**: Operator avatar or unassigned indicator.
  - Quick-filter tab bar: `All Active`, `Needs Approval (N)`, `Blocked (N)`, `Investigating (N)`, `Resolved`.
* **Primary Actions**:
  - Click row to navigate to **Exception Detail** / **Recovery Preview**. (In V1, all `REQUIRE_APPROVAL` cases must be reviewed and approved individually; bulk approval is excluded from V1).
* **Supporting Actions**:
  - Search bar (Order #, SKU, Tracking #, Customer Email).
  - Filter dropdowns (Problem Type, Recovery Level, System, Date Range).
* **Empty State**:
  - Filter result empty: *"No exceptions match the selected filters."* with `Clear Filters` button.
  - Inbox zero: *"Inbox zero. All order syncs are operating normally."*
* **Error State**:
  - Inline error alert above table: *"Failed to fetch exception list. Check your network or reload."*
* **Mobile Behavior**:
  - Table transforms into dense, scannable cards.
  - Secondary metadata (assignee, detected time) collapes into an expandable disclosure.
  - Sticky bottom filter bar for quick status switching.

---

### 3. Orders (`/orders`)
* **Purpose**: Comprehensive lookup and inspection of all monitored orders, showing their multi-system sync status and complete history.
* **Main Information**:
  - Order table containing:
    - Shopify Order Number and Date.
    - Customer Name & Destination.
    - Line item summary count and total value.
    - Cross-system status matrix: Shopify state (e.g., `Unfulfilled`), 3PL state (e.g., `In Picking`), Shipping state (e.g., `Label Generated`).
    - Sync Health indicator (Green check for converged, Amber warning for active exception, Grey for pending).
* **Primary Actions**:
  - Search order by ID, customer name, email, or tracking number.
  - Open **Order Detail**.
* **Supporting Actions**:
  - Filter by fulfillment status, payment status, destination country, or date range.
  - Re-sync order (requests fresh state snapshot from Shopify and 3PL).
* **Empty State**:
  - *"No orders found. Once your integrations are active, orders will appear here automatically."*
* **Error State**:
  - *"Unable to query orders. Upstream rate limit reached. Retrying in 15s."*
* **Mobile Behavior**:
  - Table collapses into list view showing Order #, Customer, and consolidated sync pill.

---

### 4. Recoveries (`/recoveries`)
* **Purpose**: Audit trail and ledger of all recovery actions attempted, executed, or verified across the organization.
* **Main Information**:
  - Chronological recovery execution log:
    - Recovery ID & Timestamp.
    - Associated Order #.
    - Recovery Rule applied.
    - Execution Mode: `Automatic` vs `Approved by [User]`.
    - Verification Outcome: `VERIFIED_CONVERGED`, `VERIFICATION_FAILED`, `SKIPPED`.
    - Duration to convergence (e.g., `42 seconds`).
* **Primary Actions**:
  - Filter by outcome (`Verified`, `Failed`, `Pending Verification`).
  - View **Recovery Detail**.
* **Supporting Actions**:
  - View recovery verification status and timeline history.
* **Empty State**:
  - *"No recovery actions executed yet. When discrepancies are resolved, their audit records will be stored here."*
* **Error State**:
  - Table failure alert with retry button.
* **Mobile Behavior**:
  - Card-based timeline view with single-tap access to recovery audit log.

---

### 5. Integrations (`/integrations`)
* **Purpose**: Management and real-time connectivity status of all external platforms (Shopify, ShipStation, 3PL Warehouses).
* **Main Information**:
  - Integration Cards:
    - **Shopify**: Store domain, webhook status, API quota usage, sync latency.
    - **ShipStation**: Account identifier, connection status, and last triggered sync.
    - **Warehouse / 3PL**: API endpoint, connection protocol, recent heartbeat response time.
  - Health status tag: `HEALTHY` (green), `DEGRADED` (amber), `DISCONNECTED / ERROR` (red).
  - Last sync timestamp and error rate over last 24h.
* **Primary Actions**:
  - `Connect New Integration` or `Re-authenticate`.
  - `Test Connection` (triggers non-mutating heartbeat check).
* **Supporting Actions**:
  - View connector settings and credential configuration.
  - Open **Integration Detail** for live event stream and webhook logs.
* **Empty State**:
  - Onboarding prompt: *"Connect your Shopify store to begin monitoring fulfillment reliability."*
* **Error State**:
  - Red indicator with clear error reason: *"Shopify API token expired. Re-authenticate to resume order ingestion."*
* **Mobile Behavior**:
  - Cards stack vertically with full-width `Test Connection` buttons.

---

### 6. Rules (`/rules`)
* **Purpose**: Configuration interface allowing operators to adjust recovery thresholds, approval policies, and operational modes for the 8 failure cases.
* **Main Information**:
  - Master operational mode selector: `OBSERVE (Shadow)`, `RECOMMEND`, `APPROVAL`, `SAFE AUTO-RECOVERY`.
  - Rule configuration table covering the 8 failure cases:
    - Rule name and description.
    - Assigned recovery level (`AUTO_RECOVER`, `AUTO_INVESTIGATE`, `REQUIRE_APPROVAL`, `BLOCK`).
    - Configurable parameters (e.g., Stuck order threshold: `24 hours`; Max auto-retry count: `3 attempts`).
    - Safety override locks (immutable safety defaults).
* **Primary Actions**:
  - Change global operational mode.
  - Adjust threshold parameters.
  - `Save Rule Changes`.
* **Supporting Actions**:
  - `Reset to Recommended Safe Defaults`.
  - Audit log of rule modifications.
* **Empty State**:
  - N/A (Standard ruleset is loaded by default).
* **Error State**:
  - Form validation error: *"Threshold must be between 1 and 72 hours."*
* **Mobile Behavior**:
  - Rules list presents as expandable accordion items.

---

### 7. Settings (`/settings`)
* **Purpose**: Global organization configuration, workspace preferences, notification routing, and team membership.
* **Main Information**:
  - Workspace details (Company Name, Timezone, Primary Operational Contact).
  - Organization Members & Role Assignment (`OWNER`, `ADMIN`, `OPERATOR`, `VIEWER`).
  - Alert notification channels (Email alerts for high-priority blocked orders).
  - Security & audit log preferences.
* **Primary Actions**:
  - `Save Changes`.
  - `Invite Member`.
* **Supporting Actions**:
  - Manage member access (`OWNER`, `ADMIN`, `OPERATOR`, `VIEWER`).
* **Empty State**:
  - Team list empty state: *"Invite your fulfillment team to collaborate on order approvals."*
* **Error State**:
  - Form save failure banner.
* **Mobile Behavior**:
  - Settings tabs switch to horizontal swipeable tab bar.

---

## 3. Supporting & Detail Experiences

### Exception Detail (`/exceptions/:id`)
* **Purpose**: Complete contextual view of a specific operational issue.
* **Components**:
  - Header: Order #, Problem Type, Current State (`INVESTIGATING`, `WAITING_APPROVAL`, `BLOCKED`, etc.), Recovery Level badge.
  - **State Discrepancy Matrix**: Side-by-side comparison showing exact values in Shopify vs 3PL (e.g., Shopify: *Unfulfilled*, 3PL: *Shipped - Label #1Z999*).
  - **Investigation Summary**: Plain-language explanation of what Reloop checked and discovered.
  - **Action Area**: If `WAITING_APPROVAL`, displays the embedded **Recovery Preview** with `Approve Recovery` and `Reject` buttons. If `BLOCKED`, shows exact blocking factor, prompt to correct the issue in the authoritative source system (e.g., Shopify), and a **Re-check & Resume** button (Reloop V1 is not an order-data editor).
  - **Embedded Order Timeline**: Chronological log of all events for this order.

---

### Order Detail (`/orders/:id`)
* **Purpose**: Single pane of glass for everything known about an order across all systems.
* **Components**:
  - Order metadata (date, customer, shipping address, line items, item pricing, quantities).
  - Systems status bar: Shopify order status, 3PL order status, Carrier package status.
  - Associated Exceptions list (if any active or historical discrepancies exist).
  - **Embedded Order Timeline**: Full lifecycle history.
  - Manual sync trigger button (`Request External Check`).

---

### Recovery Detail (`/recoveries/:id`)
* **Purpose**: Deep-dive operational forensics for a completed or in-progress recovery action.
* **Components**:
  - Exact answers to the 11 core operational questions:
    1. *What happened?* (Failure classification and initial event).
    2. *Which order is affected?* (Direct link to Shopify and internal order).
    3. *Which systems disagree?* (Systems and conflicting fields).
    4. *Why does Reloop think there is a problem?* (Rule trigger explanation).
    5. *What has Reloop already checked?* (Log of read queries and pre-flight tests).
    6. *What recovery is proposed / executed?* (Target endpoint, payload diff).
    7. *Is it safe?* (Duplicate-risk analysis score and proof).
    8. *Does human approval matter?* (Explanation of policy and authority).
    9. *What will change?* (Exact attributes modified in external systems).
    10. *What will NOT change?* (Confirmation of untouched financial or inventory fields).
    11. *What verification will happen afterward?* (GET polling plan and expected convergence criteria).
  - Historical attempts log: timestamps, HTTP statuses, response times, verification checks.

---

### Recovery Preview (Component Modal / Drawer)
* **Purpose**: The high-stakes decision surface presented to the Operations Manager before authorizing any risky recovery.
* **Layout & Content**:
  - Clean, high-legibility layout without generic confirmation dialogues.
  - Sections:
    - **PROBLEM**: Clear summary of the detected mismatch.
    - **PROPOSED ACTION**: Exact operation to be performed (e.g., *Resubmit Order to 3PL Ingestion Queue*).
    - **WHY THIS ACTION**: Operational justification for the fix.
    - **WHY IT IS / IS NOT SAFE**: Evidence confirming duplicate order pre-check passed, line items verified, address validated.
    - **WHAT WILL CHANGE**: Explicit list of side effects (e.g., *1 new order will be created at 3PL*).
    - **WHAT WILL NOT CHANGE**: Explicit list of untouched data (e.g., *Customer credit card will not be charged; Shopify order status remains intact*).
    - **SYSTEMS THAT WILL BE CONTACTED**: Target API endpoints and authentication scopes used.
    - **VERIFICATION PLAN**: Steps Reloop will take immediately post-execution to prove convergence.
    - **POSSIBLE RISKS**: Transparent operational risks if warehouse state was out-of-band.
  - Decision Bar:
    - `Approve Recovery` (Solid primary button with clear action label).
    - `Reject / Dismiss` (Neutral button with reason prompt).

---

### Order Timeline (Component)
* **Purpose**: Chronological, human-readable business history of the order across all connected platforms and Reloop actions.
* **Layout**:
  - Vertical timeline with semantic icons and precise relative + absolute timestamps.
  - Example Flow:
    - `10:31` — Order received from Shopify (Order `#10492`)
    - `10:31` — Sent to warehouse
    - `10:32` — Warehouse timeout (504 Gateway Timeout)
    - `10:32` — Recovery case opened (`AUTO_RECOVER`)
    - `10:34` — Retry scheduled (Backoff: 120s)
    - `10:36` — Retry attempted
    - `10:36` — Warehouse accepted order (Ref `WH-8812`)
    - `10:36` — Verification started
    - `10:37` — Shopify + warehouse states verified (Converged)
    - `10:37` — Recovery resolved
* **Interactivity**: Filter events by system (All, Shopify, 3PL, Reloop). Expandable payloads for technical inspection.

---

### Integration Detail (`/integrations/:connectorId`)
* **Purpose**: Diagnostic and configuration view for a specific connector.
* **Components**:
  - Real-time connection status pill with last heartbeat check.
  - Webhook delivery health (received, processed, dropped, latency).
  - API rate limit utilization bar.
  - Historical sync log and raw payload inspector (sanitized of sensitive tokens).
  - Connection credential update form.

---

### Organization & Members Settings (`/settings/members`)
* **Purpose**: Workspace team management.
* **Components**:
  - Member table: Name, Email, Role (`OWNER`, `ADMIN`, `OPERATOR`, `VIEWER`), Status (Active, Invited), Last Active.
  - Invite Modal: Email address, initial role selection (`ADMIN`, `OPERATOR`, `VIEWER`).
  - Activity log: Record of who approved which recovery actions.
