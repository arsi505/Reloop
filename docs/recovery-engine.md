# Reloop Recovery Engine Architecture (Day 13)

## 1. Overview & Core Mission
The Reloop Recovery Engine bridges detected `RecoveryCase` incidents to safe, versioned workflow orchestration. It implements the foundational Reloop operating promise:
```
RecoveryCase → Recovery Policy Router → Workflow Engine
CHECK → (optional APPROVAL) → EXECUTE → VERIFY → RESOLVED
```
An HTTP 200 or step execution success does **NEVER** mean recovery succeeded. A `RecoveryCase` can only be resolved when authoritative systems are reread and business invariant agreement is explicitly verified.

---

## 2. Deterministic Recovery Policy Router
The router evaluates each `RecoveryCase` by its canonical failure type and recovery level:

| Recovery Level | Routing Action | Workflow Template | Behavioral Guarantee |
|---|---|---|---|
| **AUTO_RECOVER** | `START_WORKFLOW` | `RECOVERY_TRACKING_MISSING_AUTO` | Automated execution pipeline (CHECK → EXECUTE → VERIFY). Stopped if CHECK detects discrepancies. |
| **REQUIRE_APPROVAL** | `START_WORKFLOW` | `RECOVERY_TRACKING_MISSING_APPROVAL`<br>`RECOVERY_ORDER_MISSING_3PL`<br>`RECOVERY_SHIPPED_UNFULFILLED` | Workflow pauses at durable `APPROVAL` step until human decides. Pre-execution fence re-checks preconditions before mutation. |
| **AUTO_INVESTIGATE** | `INVESTIGATE_ONLY` | `RECOVERY_STUCK_INVESTIGATION` | Strictly read-only. Collects evidence. Zero business mutations. Does NOT resolve case. |
| **BLOCK** | `BLOCKED` | *None* | Strictly creates 0 Workflows, 0 Jobs, and 0 Approvals. Case marked BLOCKED. |

---

## 3. Workflow Pipeline Rules

### A. CHECK Step (Mandatory)
- **Why CHECK rereads live state**: Day 12 detection evidence explains *why* the incident was opened. Live state may have converged or degraded since detection. CHECK answers: *"Is the discrepancy still present right now?"*
- **No-Action Cancellation**: If systems have already synchronized independently, CHECK flags `noActionNeeded: true`, and downstream `EXECUTE` skips mutations.
- **Conflict Escalation**: If new conflicting tracking or multiple candidates appear, CHECK blocks automated execution and halts the workflow.

### B. Dynamic APPROVAL & Staleness Detection
- **Dynamic Previews**: Previews are generated from live CHECK outputs rather than stale detection records.
- **Safety Fingerprint**: Derived from critical state identifiers (order number, line item hashes, tracking IDs).
- **Approval Staleness Fence**: Immediately before `EXECUTE`, the system re-validates the safety fingerprint. If the environment changed while waiting for approval, the execution fence aborts mutation.

### C. EXECUTE Step
- **Simulator-Backed Adapter**: All mutations target the isolated simulator; zero real external provider calls.
- **Stable Business Idempotency Key**:
  ```
  logicalOperationKey = `${organizationId}:${integration}:${operationType}:${recoveryCaseId}`
  ```
  Physical worker attempt numbers are **strictly excluded** to ensure idempotent retry semantics across crashes.
- **Ambiguous Timeout Handling**: If a mutation encounters a commit-then-timeout, the worker rereads external state rather than blindly duplicating the mutation.

### D. VERIFY Step (Authoritative)
- **Separate Durable Step**: EXECUTE and VERIFY are distinct steps.
- **HTTP Success != Resolution**: A 200 response from an external API only indicates request acceptance. Only VERIFY can inspect authoritative state and authorize case resolution.
- **Case Resolution Service**: A dedicated service updates `RecoveryCase` status to `RESOLVED`, records the timestamp, and preserves original detection evidence alongside resolution metrics.
