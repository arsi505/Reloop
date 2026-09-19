# Reloop Versioned Workflow & DAG Orchestration Engine

## 1. Overview & Architecture

Reloop Day 10 establishes the core generic durable workflow execution engine. The engine coordinates multi-step DAG workflows by linking high-level business workflow steps directly to Reloop''s underlying PostgreSQL durable Jobs, Redis Streams dispatch scheduler, distributed worker claiming, lease renewals, and crash recovery layers.

```
Versioned Fixed Template (in code)
           │
           ▼
    Workflow (PENDING)
           │
           ▼
 WorkflowStep instances (PENDING)
           │
           ▼
  WorkflowCoordinator (Reconciliation Tick)
  - Evaluates DAG dependencies
  - Evaluates safe conditions
           │
           ▼
   WorkflowStep (READY)
           │
   (Atomic Tx: ON CONFLICT DO NOTHING)
           ▼
   Durable Job (QUEUED, type: WORKFLOW_STEP)
           │
           ▼
   JobScanner / Redis Streams Dispatch (Day 6)
           │
           ▼
   Worker Claim & Leases (Day 7-9)
           │
           ▼
 WorkflowStepExecutor (Worker)
  - Tenant safety validation
  - Terminal workflow fence
  - Step start fence: READY -> RUNNING
  - Step handler execution
           │
     ┌─────┴─────────────────────────┐
     ▼                               ▼
Success:                        Failure:
WorkflowStep: SUCCEEDED         - Retryable: Step stays RUNNING,
Output persisted                  Job RETRY_WAITING (Day 8 backoff)
Job: SUCCEEDED                  - Permanent: Step FAILED,
XACK                              Workflow FAILED
```

> [!IMPORTANT]
> **Scope Boundaries**:
> - **No visual builder**: Templates are fixed, versioned definitions written in code.
> - **No arbitrary user scripts**: No `eval()`, `Function()`, or dynamic scripting.
> - **No real provider recovery yet**: No live Shopify, ShipStation, or 3PL mutation workflows.
> - **No approval flows yet**: Reserved for subsequent recovery case orchestration phases.

---

## 2. Fixed Versioned Workflow Templates

Workflow templates are defined and registered within the pure `@reloop/workflow-core` package. Each template is uniquely addressed by its tuple: `(templateKey, templateVersion)`.

```typescript
export interface WorkflowTemplate {
  key: string;
  version: number;
  name: string;
  steps: WorkflowStepDefinition[];
}
```

### 2.1 Immutability & Version Evolution
- Registered templates are frozen in memory upon registration.
- Once a version is registered and deployed, its definition is immutable.
- Future structural or behavior changes must increment the version (e.g., `v1` to `v2`), allowing in-flight historical workflows to finish according to their original definition.

### 2.2 Template Validation & Cycle Detection
Before registration, every template is validated against strict invariants:
1. **Uniqueness**: Step keys must be unique within the template.
2. **Non-Empty & Well-Formed**: Keys, names, and handlers must be non-empty strings; versions and maxAttempts must be positive integers.
3. **No Self-Dependencies**: A step cannot declare a dependency on itself.
4. **No Missing Dependencies**: All upstream `dependsOn` step keys must exist in the template.
5. **Acyclic DAG Guarantee**: A 3-color depth-first search detects direct cycles (`A -> B -> A`) and transitive cycles (`A -> B -> C -> A`), preventing cyclic templates from ever loading.
6. **Valid Conditions**: Conditions can only target upstream step outputs.

---

## 3. DAG Resolution & Safe Declarative Conditions

### 3.1 DAG Traversal
A step is eligible for execution only when **all** steps listed in its `dependsOn` array are complete:
- Complete states: `SUCCEEDED` or `SKIPPED`.
- Incomplete states: `PENDING`, `READY`, `RUNNING`, `RETRY_WAITING`.
- Blocking states: `FAILED` or `BLOCKED` dependencies strictly prevent downstream execution.

### 3.2 Safe Declarative Conditions
Reloop intentionally disallows user-provided JavaScript expressions. Conditions are strictly declarative:
- `ALWAYS`: Unconditional execution (default).
- `STEP_OUTPUT_EQUALS`:
  - `stepKey`: Target upstream step.
  - `field`: Top-level output field name.
  - `value`: Expected primitive value (`string`, `number`, `boolean`, `null`).

**Condition Evaluation Outcomes**:
- **Evaluates True**: Step transitions from `PENDING` to `READY` and a durable Job is created.
- **Evaluates False**: Step transitions from `PENDING` to `SKIPPED` with `completedAt = NOW()`. **No Job is created.** Downstream steps treat `SKIPPED` steps as satisfied dependencies.

---

## 4. One Durable Job Per WorkflowStep

Each executable `WorkflowStep` corresponds to **exactly one logical Job**:
- `Job.type = 'WORKFLOW_STEP'`
- `Job.organizationId = Workflow.organizationId`
- `Job.workflowId = Workflow.id`
- `Job.workflowStepId = WorkflowStep.id`
- `Job.idempotencyKey = workflow-step:<workflowId>:<stepKey>:v<templateVersion>`

### 4.1 Retries Reuse the Same Logical Job
- When a step fails with a retryable error, the `WorkflowStep` remains in `RUNNING` status.
- The underlying `Job` transitions to `RETRY_WAITING` with backoff and jitter.
- Subsequent attempts create a new `JobAttempt` record referencing the **same Job ID** and **same WorkflowStep ID**.
- No duplicate WorkflowStep rows or duplicate Jobs are ever generated.

### 4.2 Multi-Coordinator Race & Restart Idempotency
- Multiple scheduler/coordinator processes may inspect the same workflow concurrently.
- `PENDING -> READY` transitions and `Job` insertions run in a transaction using PostgreSQL `ON CONFLICT (organization_id, idempotency_key) DO NOTHING`.
- If a coordinator restarts mid-tick, any orphaned `READY` step missing a Job is repaired idempotently on the next scan.

---

## 5. Worker Step Execution & Fences

Execution occurs inside `apps/worker` via `WorkflowStepExecutor`:

### 5.1 Tenant Isolation
- Validates that `context.organizationId` strictly matches `Workflow.organizationId` and `WorkflowStep.organizationId`.
- Cross-tenant execution is rejected immediately with an error.

### 5.2 Terminal Workflow Execution Fence
- If the parent `Workflow` has already reached a terminal state (`FAILED`, `BLOCKED`, `CANCELLED`, `SUCCEEDED`), the worker refuses to execute the handler.
- Prevents stale or out-of-order jobs from performing business effects after a workflow has terminated.

### 5.3 Step Start Fence
- Before invoking the registered step handler, the worker transitions `WorkflowStep` from `READY` to `RUNNING` (preserving `RUNNING` if this is a retry attempt).

---

## 6. Terminal State & Error Propagation

1. **All Steps Succeeded/Skipped**:
   - `Workflow.status` transitions to `SUCCEEDED` with `completedAt = NOW()`.
2. **Permanent Step Failure**:
   - When a step job reaches `FAILED` or `DEAD_LETTERED`, the coordinator reconciles `WorkflowStep.status = FAILED`.
   - `Workflow.status` transitions to `FAILED`. Downstream steps never execute.
3. **Ambiguous Crash / Blocked Job**:
   - When a step job reaches `BLOCKED` (e.g. unverified crash recovery state), `WorkflowStep.status = BLOCKED` and `Workflow.status = BLOCKED`.
4. **Missing Template**:
   - If an active workflow references an unregistered template version, the coordinator safely marks `Workflow.status = BLOCKED` with diagnostic logging.

---

## 7. System Test Templates

The engine includes four infrastructure-only test templates in `@reloop/workflow-core`:
1. `SYSTEM_LINEAR_V1`: `STEP_A -> STEP_B -> STEP_C`
2. `SYSTEM_PARALLEL_JOIN_V1`: `STEP_A -> (STEP_B, STEP_C) in parallel -> STEP_D` (synchronization barrier)
3. `SYSTEM_CONDITIONAL_V1`: `STEP_A -> STEP_B (conditional) -> STEP_C`
4. `SYSTEM_RETRY_V1`: `STEP_A` (transient failure on attempt 1, success on attempt 2)

5. SYSTEM_APPROVAL_V1: STEP_CHECK -> STEP_APPROVAL (HITL Pause) -> STEP_EXECUTE -> STEP_VERIFY (See [Approval Engine Documentation](./approval-engine.md))
