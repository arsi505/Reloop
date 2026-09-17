# Reloop Product Specification

## 1. Product Purpose & Problem Statement

Reloop is a B2B SaaS reliability and recovery engine built specifically for growing e-commerce brands.

Modern e-commerce brands rely on a distributed ecosystem of business-critical platforms:
- Storefront & Order Management: **Shopify**
- Shipping & Logistics Platform: **ShipStation**
- Fulfillment Infrastructure: **External Warehouses / 3PL Systems**

### The Core Problem
When orders flow between Shopify, shipping platforms, and 3PL warehouses, cross-system discrepancies inevitably arise. Typical failures include dropped webhooks, transient network/API timeouts, race conditions, unsynced tracking numbers, stuck processing states, and data validation mismatches (e.g., malformed addresses, unrecognized SKUs).

In traditional operations:
- Discrepancies go undetected until angry customers contact support or manual weekly audits expose lost revenue.
- Automation scripts or basic integration tools rely naively on HTTP `200 OK` responses. Receiving an HTTP 200 when posting an order payload does not guarantee the 3PL accepted, allocated inventory, or queued it for picking.
- Human operations teams manually re-enter order details or push manual sync buttons, introducing severe risks of duplicate fulfillment, double-shipping, and inventory leakage.

### Product Promise: Verified Recovery
Reloop operates on a non-negotiable core operating principle:

$$\text{CHECK} \longrightarrow \text{EXECUTE} \longrightarrow \text{VERIFY} \longrightarrow \text{RESOLVED}$$

An HTTP 200 response alone must **NEVER** mean that a recovery succeeded. Reloop must actively reread the relevant external systems and verify that the actual business state has converged before declaring any exception case resolved.

Reloop provides continuous state monitoring, automated root-cause investigation, conservative recovery execution, human-in-the-loop previews for risky state changes, and verified post-recovery reconciliation.

---

## 2. Customer Profile & User Personas

### V1 Customer Profile
Reloop V1 is purpose-built for:
- Growing direct-to-consumer (DTC) and omnichannel Shopify brands.
- Order volume: hundreds to several thousand+ orders per month.
- Systems architecture: Shopify core connected to an external warehouse / 3PL and shipping platform (such as ShipStation).
- Team structure: Lean operations team (1–4 people) managing fulfillment, inventory, and customer resolution.
- Business realities: Fulfillment errors are costly (re-shipping costs, lost inventory, brand reputation damage), and internal engineering resources are limited or absent.

### Primary User
- **E-commerce Operations / Fulfillment Manager**: Responsible for daily order flow, ensuring on-time delivery, resolving warehouse discrepancies, and preventing shipping halts. Needs high clarity, actionable insights, and minimized duplicate-fulfillment risks.

### Secondary Users
- **Founder / Owner**: Seeks operational peace of mind, system reliability metrics, and prevention of inventory leakage or shipping bleed.
- **Warehouse Coordinator**: Needs clear visibility into why orders are stuck, which SKUs are failing validation, and clean reconciliation between Shopify and warehouse batches.
- **Customer Service Lead**: Needs visibility into order exception states and timeline explanations to answer customer delivery inquiries accurately without filing manual warehouse tickets.

### Excluded Audiences (Do NOT Design For)
- Generic developers seeking custom coding sandboxes
- Workflow automation builders looking for visual node-based graph editors
- Giant enterprise retailers with dedicated in-house ERP/EDI integration engineering teams
- Amazon-only sellers using Fulfillment by Amazon (FBA) exclusively
- 3PL logistics companies managing multi-client infrastructure across hundreds of separate tenants
- Tiny hobby stores with fewer than 50 orders per month

---

## 3. Core Operating Principles

1. **Business Language First**: The UI and domain model speak the language of e-commerce operations (Order, Problem, Investigation, Recovery, Waiting for Approval, Blocked, Verification, Resolved, Integration Health). Infrastructure primitives (Redis Streams, consumer groups, leases, PEL, CAS internals) are strictly confined to internal backend mechanics.
2. **Deterministic & Safe Operations**: No ungrounded guessing. Every action follows explicit, deterministic reliability rules.
3. **Verified Convergence**: A case cannot transition to `RESOLVED` until post-execution checks confirm that both external systems agree on the state of the order.
4. **Idempotency and Duplicate-Risk Controls**: Any operation that carries the risk of re-transmitting an order to a warehouse must use stable logical idempotency keys across retries, require rigorous pre-flight checks and human authorization, or be automatically blocked. Reloop targets at-least-once job delivery with idempotent business effects without claiming absolute guarantees or exactly-once execution.
5. **No AI in V1**: V1 contains zero machine learning, LLM diagnostics, AI agents, or probabilistic recommendation algorithms. All evaluations are deterministic and rule-governed.

---

## 4. V1 Recovery Levels

Reloop enforces exactly four recovery levels. No additional recovery levels exist in V1:

| Recovery Level | Operational Meaning | System Behavior |
| :--- | :--- | :--- |
| **`AUTO_RECOVER`** | Fully automated recovery is verified safe. | Reloop executes deterministic, idempotent retry or sync operations with exponential backoff and verifies state convergence before resolving. |
| **`AUTO_INVESTIGATE`** | System discrepancy detected, but safe automated recovery cannot yet be confirmed. | Reloop queries connected systems, inspects order histories, checks tracking/fulfillment states, and aggregates diagnostic facts before determining if the case can transition or needs human intervention. |
| **`REQUIRE_APPROVAL`** | Discrepancy identified and remediation path known, but execution carries financial or operational risk. | Reloop constructs a detailed Recovery Preview detailing what will change, what will not change, and the verification plan. Execution pauses until an authorized human approves or rejects. |
| **`BLOCK`** | Dangerous condition detected (e.g., potential duplicate order creation, hazardous data mismatch). | Reloop immediately halts all automated operations on the affected order, alerts the operations team, locks automated retry mechanisms, and mandates manual operational review. |

---

## 5. V1 Failure Cases

Reloop V1 addresses exactly the following eight failure cases. No generic or hypothetical failure classes are included:

### 1. Temporary 3PL / API Failure
- **Condition**: Network timeouts, 5xx server errors, rate limits, or temporary endpoint unresponsiveness when communicating with the 3PL or shipping platform API.
- **Recovery Level**: `AUTO_RECOVER`
- **Remediation**: Scheduled automatic retries with progressive exponential backoff and jitter.
- **Verification**: Following an apparently successful retransmission, Reloop queries the 3PL to confirm that the order exists in their ingestion buffer and holds a valid downstream identifier.

### 2. Tracking Exists Externally but is Missing in Shopify
- **Condition**: The 3PL or shipping platform has generated a valid carrier tracking number and marked the shipment label generated, but Shopify remains unfulfilled or lacks the tracking details.
- **Recovery Level**: `AUTO_RECOVER` (conditioned on deterministic identity match)
- **Remediation**: When order identity, line items, and recipient address produce a deterministic match using all required configured identifiers with no detected conflicts, Reloop executes an idempotent fulfillment sync to Shopify with the external tracking number and carrier code.
- **Verification**: Reloop re-fetches the Shopify order resource to verify that fulfillment status is updated and tracking info is visible on the order object.

### 3. Stuck Order
- **Condition**: An order has been placed in Shopify and acknowledged by intermediate systems, but has remained in an unfulfilled, unpicked, or static processing state past the brand’s defined SLA threshold (e.g., > 24 hours without warehouse movement).
- **Recovery Level**: `AUTO_INVESTIGATE`
- **Remediation**: Reloop queries the 3PL and shipping provider APIs to check current internal statuses, picking queue positions, inventory holds, or backorder tags.
- **Verification**: If an investigation confirms the order was simply dropped from the warehouse pick queue without duplicate risk, safe recovery is prepared; if ambiguous, it escalates to human review.

### 4. Shopify Order Missing at 3PL
- **Condition**: An active, paid order exists in Shopify, but the 3PL has no record of the order ID or reference number in their system.
- **Recovery Level**: `REQUIRE_APPROVAL`
- **Remediation**: Reloop first performs a rigorous duplicate-risk pre-check (searching by customer email, shipping address, line items, and recent order timestamps across the 3PL). Once confirmed absent, Reloop prepares a resubmission payload and requests human authorization.
- **Verification**: Upon human approval and transmission, Reloop rereads the 3PL order queue to confirm ingestion and verifies Shopify’s external reference tag.

### 5. 3PL Reports Shipped but Shopify Remains Unfulfilled
- **Condition**: The 3PL marks the order as fully shipped, but Shopify’s fulfillment status remains `unfulfilled` or `partial`, and automated tracking sync was either rejected or ambiguous.
- **Recovery Level**: `REQUIRE_APPROVAL`
- **Remediation**: Reloop flags the discrepancy and generates a side-by-side reconciliation preview of shipped line items versus Shopify unfulfilled line items, requiring operational sign-off before forcing fulfillment status update.
- **Verification**: Reloop verifies that the Shopify fulfillment object is created with matching line item counts and no unfulfilled balance remains.

### 6. Inventory Mismatch
- **Condition**: Shopify available-to-sell inventory levels diverge from the physical or allocated stock reported by the 3PL / warehouse management system.
- **Recovery Level**: `REQUIRE_APPROVAL`
- **Remediation**: Reloop detects the delta across active SKUs, highlights potential overselling or stockout conditions, and presents the discrepancy for human decision (adjust Shopify to match 3PL, adjust 3PL, or flag physical cycle count needed).
- **Verification**: Reloop re-checks inventory levels across both platforms to confirm balance convergence.

### 7. Duplicate-Risk Operation
- **Condition**: An order resubmission, manual sync, or retry is triggered where there is any ambiguity that the 3PL might have already received, printed, or processed the order under an alternate reference or split shipment.
- **Recovery Level**: `BLOCK`
- **Remediation**: Reloop immediately locks the order from automated retry, halts transmission, and presents the case with full duplicate-risk evidence (matching address, active packages, or conflicting tracking numbers).
- **Verification**: Requires operational manager review to confirm single fulfillment path or cancel redundant order allocations.

### 8. Invalid SKU / Address / Order Data
- **Condition**: The 3PL or carrier rejects order ingestion due to unmapped SKU codes, invalid postal/zip codes, missing street numbers, or character-length overflow.
- **Recovery Level**: `BLOCK` (Automatic retries stopped)
- **Remediation**: Reloop stops wasteful retries immediately to avoid API bans. Reloop highlights the exact failing data attribute. The human operator corrects the data in the authoritative source system (e.g., Shopify), then requests a re-check in Reloop. Once verified rectified, Reloop unlocks recovery. Reloop V1 is not an order-data editor.
- **Verification**: Reloop re-validates the payload against carrier/3PL validation schemas and confirms successful ingestion at the 3PL.

*Note on V1 Scope: Reloop V1 explicitly does NOT perform customer refunds, return handling, automatic order cancellation, or automated customer reshipping.*

---

## 6. Shadow Mode Progression

To establish operational trust with brands whose order fulfillment is mission-critical, Reloop provides a phased operational progression known as **Shadow Mode**:

```
[OBSERVE] ────────► [RECOMMEND] ────────► [APPROVAL] ────────► [SAFE AUTO-RECOVERY]
(Passive read)     (Draft recoveries)    (Human authorization) (Autonomous verified safe)
```

1. **OBSERVE Mode**:
   - Reloop connects to Shopify, ShipStation, and the 3PL in read-only mode.
   - Silently monitors order flows, measures sync latency, and logs discrepancies without alerting or intervening.
   - Calculates baseline reliability metrics (discrepancy rate, silent failure volume, average detection time).

2. **RECOMMEND Mode**:
   - Discrepancies generate visible Exception cases in the inbox.
   - Reloop simulates and displays what recovery action *would* have been taken, explaining the safety checks and verification criteria.
   - No external state-changing API calls are made.

3. **APPROVAL Mode**:
   - Recovery actions can be executed, but every proposed action—even those eligible for `AUTO_RECOVER`—requires explicit human confirmation via the Recovery Preview screen.
   - Verifies all executions post-action and demonstrates deterministic convergence.

4. **SAFE AUTO-RECOVERY Mode**:
   - Low-risk, idempotent recoveries (`AUTO_RECOVER`) execute autonomously according to brand rules.
   - Post-recovery verification is strictly enforced.
   - High-risk and duplicate-potential operations remain firmly bounded by `REQUIRE_APPROVAL` and `BLOCK`.

---

## 7. Scope & Explicit Non-Goals

### V1 In-Scope Capabilities
- Connectors: Shopify, ShipStation, Generic 3PL / Warehouse API Simulator
- Ingestion of order webhooks and scheduled reconciliation polling
- 8 specified failure detection rules
- 4 defined recovery levels
- Strict 4-phase verification engine (Check → Execute → Verify → Resolved)
- Web UI: Dashboard, Exception Inbox, Orders List, Recoveries List, Integrations, Rules Configuration, Organization & Settings
- High-fidelity Recovery Detail, Recovery Preview, and chronological Order Timeline
- Shadow Mode configuration and progressive operational enablement

### Explicit V1 Non-Goals
To maintain hyper-focus and deliver dependable core reliability, the following are explicitly excluded from V1:
- **E-Commerce Channels**: Amazon, Walmart, WooCommerce, Magento, BigCommerce, eBay, TikTok Shop
- **Financial & Order Modifications**: Customer refunds, return management, payment capture/voiding, automatic order cancellations, automatic inventory write-offs, automatic reshipments
- **Domain Overreach**: Inventory forecasting, complete Warehouse Management System (WMS), complete Order Management System (OMS), authoritative order-data editor (data corrections must be performed in source systems)
- **Advanced Customization**: Drag-and-drop workflow builders, custom scripting engines, user-defined state machine DSLs
- **Operational Scope Reductions**: Bulk recovery approval (each risky recovery requires individual review), Slack webhook notifications, CSV exports, column customization
- **Enterprise IAM**: Custom permissions/roles, SAML 2.0, Okta/Azure SSO, SCIM provisioning, two-person dual approval rules
- **Client Platforms**: Native iOS or Android mobile applications (responsive web only)
- **Commercial Systems**: Stripe billing integrations, multi-tier subscription paywalls, usage metering
- **Artificial Intelligence**: AI diagnosis, LLM reasoning agents, conversational chatbots, generative recommendations, non-deterministic heuristics
- **Complex Distributed Primitives**: Kubernetes clusters, Apache Kafka, Temporal, RabbitMQ, multi-region distributed databases
