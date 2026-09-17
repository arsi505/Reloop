# Reloop Recovery UX Architecture

## 1. The Core Philosophy of Recovery

Fulfillment recovery in e-commerce is inherently risky. A single mistimed API call or duplicate submission can trigger double picking, duplicate shipping, inventory discrepancies, and severe financial waste.

Reloop's foundational mandate is:
$$\text{CHECK} \longrightarrow \text{EXECUTE} \longrightarrow \text{VERIFY} \longrightarrow \text{RESOLVED}$$

### Non-Negotiable Axioms
1. **HTTP 200 is Not Success**: An HTTP 200 from a 3PL or Shopify API merely indicates message receipt, not business state convergence. Reloop never marks an incident resolved until independent read queries prove both systems agree.
2. **Business Language Exclusively**: Customer-facing UX speaks in terms of orders, packages, addresses, and discrepancies. Low-level internal mechanics (Redis Streams, consumer groups, leases, PEL, CAS locks) are strictly prohibited from normal operational views.
3. **Transparent Intent**: The user must never be asked to make a blind decision or be presented with a scary, generic "Are you sure?" modal. Every recovery proposal must detail exact consequences before execution.

---

## 2. The 11 Core Questions of Recovery Detail

When an Operations Manager inspects an exception or recovery in Reloop, the UI answers eleven explicit questions directly on the screen:

| Question | Operational Meaning | UI Presentation in Reloop |
| :--- | :--- | :--- |
| **1. What happened?** | The detected failure type and trigger event. | Prominent card header with canonical problem name (e.g., *"Tracking Exists Externally but Missing in Shopify"*). |
| **2. Which order is affected?** | Primary business identifier. | Monospace badge (e.g., `Order #10492`) linked to customer name, destination, and order value. |
| **3. Which systems disagree?** | Conflicting external platforms. | Side-by-side comparative matrix showing Shopify vs 3PL vs Shipping provider values. |
| **4. Why does Reloop think there is a problem?** | The exact discrepancy rule evaluated. | Contextual summary (e.g., *"ShipStation created tracking 1Z999 4 hours ago, but Shopify fulfillment status remains unfulfilled"*). |
| **5. What has Reloop already checked?** | Completed pre-flight queries and investigations. | Checklist of completed diagnostic reads with timestamps and verified findings. |
| **6. What recovery is proposed?** | The exact remediation operation to be performed. | Clear action description (e.g., *"Post fulfillment record with tracking 1Z999 to Shopify"*). |
| **7. Is it safe?** | Risk assessment and duplicate check. | Safety assessment badge (e.g., *"Safe: Duplicate check passed. Carrier label verified authentic"*). |
| **8. Does human approval matter?** | Why human authorization is required or bypassed. | Policy rationale (e.g., *"Order resubmission carries financial risk; brand policy requires human sign-off"*). |
| **9. What will change?** | Explicit list of side effects in connected systems. | Green bulleted list of updated attributes across target systems. |
| **10. What will NOT change?** | Explicit confirmation of protected data. | Neutral bulleted list confirming untouched fields (e.g., *"Payment will not be modified. No customer email will be sent until verified"*). |
| **11. What verification will happen afterward?** | The post-execution convergence proof. | Step-by-step verification plan that will execute before the case can transition to `RESOLVED`. |
| **Historical Context** | What happened during previous attempts? | Log of all past attempts, backoff intervals, and error responses. |

---

## 3. Recovery Preview: High-Stakes Decision Surface

The **Recovery Preview** is the central trust-building component of Reloop. When an operation requires approval or an operator manually triggers remediation, this comprehensive preview renders inline or in a dedicated decision drawer.

### Recovery Preview Layout & Content Structure

```
+-------------------------------------------------------------------------+
| RECOVERY PREVIEW: Order #10521                                    [ X ] |
+-------------------------------------------------------------------------+
|                                                                         |
| PROBLEM                                                                 |
| Paid Shopify order #10521 is missing from 3PL warehouse fulfillment     |
| queue after 6 hours.                                                    |
|                                                                         |
| PROPOSED ACTION                                                         |
| Transmit verified order payload to 3PL Ingestion API                    |
| Endpoint: POST /api/v2/orders                                           |
|                                                                         |
| WHY THIS ACTION                                                         |
| Resolves fulfillment stall by injecting the missing order into the      |
| warehouse picking queue.                                                |
|                                                                         |
| WHY IT IS SAFE                                                          |
| [✓] Scanned 3PL orders for last 7 days: No duplicate matching name/zip  |
| [✓] Shipping address syntax validated against carrier database          |
| [✓] Inventory allocation confirmed available at warehouse               |
|                                                                         |
| WHAT WILL CHANGE                                                        |
| • 1 new order record created at 3PL (Reference: RELOOP-10521)           |
| • Warehouse queue status set to PENDING_PICK                            |
|                                                                         |
| WHAT WILL NOT CHANGE                                                    |
| • Customer payment status remains untouched (already paid)              |
| • Shopify order line items and pricing remain unmodified                |
| • No duplicate email sent to customer at this stage                     |
|                                                                         |
| SYSTEMS THAT WILL BE CONTACTED                                          |
| • External Warehouse API (3PL Logistics Corp)                           |
| • Shopify Orders Admin API (Read verification only)                     |
|                                                                         |
| VERIFICATION PLAN                                                       |
| 1. Query 3PL GET /api/v2/orders/RELOOP-10521 after 10 seconds           |
| 2. Confirm order status is ACCEPTED                                     |
| 3. Read Shopify order tag to verify cross-system link                   |
|                                                                         |
| POSSIBLE RISKS                                                          |
| If warehouse floor had processed this order from a manual paper slip,   |
| duplicate picking could occur. Verify with warehouse lead if in doubt.  |
|                                                                         |
+-------------------------------------------------------------------------+
| [ Reject / Dismiss ]                          [ Approve Recovery -> ]   |
+-------------------------------------------------------------------------+
```

### Decision Controls
- **`Approve Recovery`**: Primary solid button. Initiates the execution pipeline, instantly switching state to `RECOVERING` $\rightarrow$ `VERIFYING`.
- **`Reject / Dismiss`**: Neutral outline button. Prompts operator for a brief reason (e.g., *"Handled manually on warehouse floor"*), archiving the exception with full audit tracking.
- **No generic alert modals**: The preview itself provides complete context; no secondary browser confirmation dialog is used.

---

## 4. Chronological Order Timeline

The **Order Timeline** transforms fragmented multi-system events into a cohesive, chronological operational story.

### Business-Language Timeline Example
```
10:31:02 AM  Order received from Shopify (Order #10492 • $142.50)
10:31:15 AM  Sent to warehouse (3PL API request dispatched)
10:32:15 AM  Warehouse timeout (3PL API unresponsive after 60s gateway timeout)
10:32:16 AM  Recovery case opened (Assigned level: AUTO_RECOVER)
10:34:00 AM  Retry scheduled (Exponential backoff delay: 120s)
10:36:00 AM  Retry attempted (Payload re-transmitted with stable logical idempotency key)
10:36:04 AM  Warehouse accepted order (3PL confirmed receipt • Ref WH-8812)
10:36:05 AM  Verification started (Awaiting downstream queue convergence)
10:37:15 AM  Shopify + warehouse states verified (Both systems reflect active picking)
10:37:16 AM  Recovery resolved (Incident closed after verified state convergence)
```

Each timeline entry contains:
- Semantic timestamp (relative in list, absolute on hover).
- System source tag (`Shopify`, `Warehouse`, `ShipStation`, `Reloop Engine`).
- Human-readable event description.
- Collapsible technical payload drawer for technical diagnostics when required.

---

## 5. Shadow Mode: The Progression of Trust

Fulfillment operations cannot tolerate erratic automation. Reloop establishes operational authority via a four-stage progression:

```
[ 1. OBSERVE ]  ────────────────► [ 2. RECOMMEND ]
Silent read-only monitoring        Simulated recoveries with previews
Discrepancy audit rate calculated  No state mutations executed
              │                                  │
              ▼                                  ▼
[ 4. SAFE AUTO-RECOVERY ] ◄──────── [ 3. APPROVAL ]
Autonomous idempotent execution    Human authorization required
Strict post-verification           for all recovery actions
```

1. **Stage 1: OBSERVE (Shadow Mode)**
   - Connects to platforms in passive read mode.
   - Discrepancies are logged internally to build data on failure frequencies and silent error rates.
   - Zero modifications are ever dispatched to external systems.

2. **Stage 2: RECOMMEND**
   - Discrepancies appear in the Exception Inbox tagged as `SIMULATION`.
   - Operators can view full Recovery Previews showing what Reloop would do, why it is safe, and what verification would check.
   - Trains the operations team on Reloop’s decision logic.

3. **Stage 3: APPROVAL**
   - Live recovery capability is enabled.
   - Every recovery—even routine transient retries—pauses in `WAITING_APPROVAL`.
   - Operators manually click `Approve Recovery` in the Recovery Preview, witnessing the execution and subsequent verification.

4. **Stage 4: SAFE AUTO-RECOVERY**
   - Purely idempotent, low-risk failures (`AUTO_RECOVER`) execute automatically.
   - Post-recovery verification is strictly enforced before resolution.
   - Risky actions (`REQUIRE_APPROVAL`) and hazardous conditions (`BLOCK`) remain gated by mandatory human review.

---

## 6. Exception States & State Transition Rules

The Exception lifecycle enforces deterministic state transitions:

```
                  ┌──────────────┐
                  │     OPEN     │
                  └──────┬───────┘
                         │
                         ▼
               ┌──────────────────┐
        ┌─────►│  INVESTIGATING   ├─────┐
        │      └─────────┬────────┘     │
        │                │              ▼
        │                │         ┌─────────┐
        │                ▼         │ BLOCKED │
        │     ┌──────────────────┐ └────┬────┘
        │     │READY_FOR_RECOVERY│      │ (Source data fixed -> Re-check)
        │     └──────────┬───────┘      │ (Manual intervention -> Re-check)
        │                │              ▼
        │                ├────────►[WAITING_APPROVAL]
        │                │              │ (User approves)
        │                ▼              │
        │        ┌───────────────┐      │
        │        │  RECOVERING   │◄─────┘
        │        └───────┬───────┘
        │                │
        │                ▼
        │        ┌───────────────┐
        │        │   VERIFYING   │◄─────────┘
        │        └───┬───────┬───┘
(Timeout/error)      │       │ (State confirmed converged)
        └────────────┘       ▼
                       ┌──────────┐
                       │ RESOLVED │
                       └──────────┘
```

> **Mandatory Verification Rule**: Under NO circumstances does any human action, button click, or API response bypass `VERIFYING` to reach `RESOLVED`. State convergence must always be verified by reading external systems.

### State Definitions
- **`OPEN`**: Discrepancy detected and registered in database.
- **`INVESTIGATING`**: Background poller querying connected systems to aggregate facts.
- **`READY_FOR_RECOVERY`**: Diagnostic checks completed and recovery payload assembled.
- **`WAITING_APPROVAL`**: Paused pending operational review in Recovery Preview.
- **`RECOVERING`**: Dispatching idempotent mutation payload to external platform using a stable logical idempotency key.
- **`VERIFYING`**: Polling external platforms independently to prove business state convergence.
- **`RESOLVED`**: External platforms independently verified to be in agreement. Under no circumstances can a case transition directly to `RESOLVED` without passing `VERIFYING`.
- **`BLOCKED`**: Dangerous condition (duplicate risk or invalid data) halted; retries locked. Requires external data correction or warehouse intervention followed by a verified re-check.
- **`FAILED`**: Max retries exceeded or verification failed after execution. Requires human triage.
