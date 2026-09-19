# Reloop Human Approval Engine & HITL Safety Boundary

## 1. Overview & Architectural Principles

The Reloop Approval Engine introduces safe, durable **Human-in-the-Loop (HITL)** decision points into automated recovery workflows. While standard workflow steps dispatch asynchronous distributed jobs to workers, an `APPROVAL` step deliberately pauses execution, generates an immutable preview of the proposed action, and waits for authorized human intervention.

### Core Architectural Invariants:
1. **Zero-Job Invariant on Approval Steps**: An `APPROVAL` step **NEVER** creates a `Job` record in the database and never enqueues a message on Redis Streams. It exists entirely as an orchestrated database gate.
2. **Deterministic Waiting & Non-Revival**: When an `APPROVAL` step becomes active, the step and its parent workflow transition to `WAITING`. Terminal workflows (`SUCCEEDED`, `FAILED`, `CANCELLED`, `BLOCKED`) cannot be revived by stale or out-of-order approval decisions.
3. **Optimistic Row-Fenced CAS**: All state transitions (`approve` or `reject`) use transactional `SELECT ... FOR UPDATE` row-level locks on the `Workflow`, `WorkflowStep`, and `Approval` records, asserting expected statuses (`WAITING`, `PENDING`).
4. **Synchronous Audit Trail**: Approval decisions atomically record an append-only `AuditLog` row in the exact same database transaction. If the audit log insertion fails, the entire transaction rolls back.

---

## 2. Recovery Preview Data Contract

Before deciding an approval, human operators must have complete clarity regarding the proposed recovery. The `RecoveryPreview` object defines this schema:

```typescript
export interface RecoveryPreview {
  version: 1;
  problem: string;
  proposedAction: string;
  why: string;
  systems: string[];
  changes: string[];
  nonChanges: string[];
  risks: string[];
  safetyChecks: string[];
  recoveryLevel?: string;
  caseReference?: string;
  orderReference?: string;
  expectedVerification?: string;
  metadata?: Record<string, unknown>;
}
```

### Snapshot Immutability:
When an approval step pauses in `WAITING`, the workflow coordinator freezes the template's preview into `Approval.previewSnapshot` (`jsonb`). Even if the workflow template definition is later updated, the approval record preserves the exact snapshot shown to the reviewer.

---

## 3. Workflow State Transitions & Flow

```
   [STEP_CHECK: EXECUTION] ©¤©¤(succeeds)©¤©¤? [STEP_APPROVAL: APPROVAL]
                                                   ©¦
                                                   ¨�?                                        Step: WAITING, Workflow: WAITING
                                        (Approval: PENDING, Jobs: 0)
                                                   ©¦
                         ©°©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©Ø©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©´
                         ¨�?                                                  ¨�?                Human Decides: APPROVE                              Human Decides: REJECT
                         ©¦                                                   ©¦
        Approval: APPROVED                                  Approval: REJECTED
        Step: SUCCEEDED                                     Step: BLOCKED
        Workflow: RUNNING                                   Workflow: BLOCKED
        AuditLog: APPROVAL_APPROVED                         AuditLog: APPROVAL_REJECTED
                         ©¦                                                   ©¦
                         ¨�?                                                  ¨�?               [STEP_EXECUTE: EXECUTION]                           Execution HALTED
                         ©¦                                         Downstream steps remain PENDING
                         ¨�?                                        Downstream jobs count: 0
               [STEP_VERIFY: EXECUTION]
                         ©¦
                         ¨�?                 Workflow: SUCCEEDED
```

---

## 4. API & RBAC Boundary

All approval actions are exposed via the NestJS `@reloop/api` under the `/approvals` namespace:

| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/approvals` | `OWNER`, `ADMIN`, `OPERATOR`, `VIEWER` | List approvals for authenticated tenant with filtering (`status`, `workflowId`, `recoveryCaseId`) |
| `GET` | `/approvals/:id` | `OWNER`, `ADMIN`, `OPERATOR`, `VIEWER` | Fetch single approval by ID with full preview snapshot and relations |
| `POST` | `/approvals/:id/approve` | `OWNER`, `ADMIN`, `OPERATOR` | Approve a pending approval step (optional `note`) |
| `POST` | `/approvals/:id/reject` | `OWNER`, `ADMIN`, `OPERATOR` | Reject a pending approval step (requires non-empty `reason`) |

### Strict Security Enforcements:
- **Authentication**: Valid JWT required.
- **Tenant Isolation**: All queries and mutations include `organizationId = req.user.organizationId`. Probing other tenant IDs returns 404 Not Found.
- **Role Enforcement**: Read-only `VIEWER` users receive 403 Forbidden on approve or reject endpoints.
- **Actor Identity**: `decidedByUserId` is strictly derived from the authenticated JWT session (`req.user.id`). User-supplied actor IDs are strictly prohibited.
- **Single Decision Safety**: Attempting to approve or reject an already decided approval returns 409 Conflict.
- **Race Condition Safety**: Concurrent approve/reject requests serialize via PostgreSQL row locks (`SELECT FOR UPDATE`), guaranteeing that exactly one decision succeeds and the other receives 409 Conflict.

---

## 5. Integration with Recovery Engine (Day 13)

In Day 13's recovery workflows (`RECOVERY_TRACKING_MISSING_APPROVAL`, `RECOVERY_ORDER_MISSING_3PL`, `RECOVERY_SHIPPED_UNFULFILLED`), human approvals gate sensitive external mutations:
- **Dynamic Previews from Upstream CHECK**: When `WorkflowCoordinator` pauses the workflow at the `APPROVAL` step, it injects the live diagnostic findings from the preceding `CHECK` step directly into `Approval.previewSnapshot`.
- **Pre-execution Fencing**: The human operator reviews exact state diffs, safety fingerprints, and compensation parameters before any external mutation occurs. Rejection marks the step `REJECTED`, blocks the workflow, and leaves the recovery case safely unresolved without side effects. See [recovery-engine.md](./recovery-engine.md).
