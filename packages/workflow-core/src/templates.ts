import { WorkflowTemplate } from './types';

/**
 * Infrastructure-only test template: Linear sequence A -> B -> C.
 */
export const SYSTEM_LINEAR_V1: WorkflowTemplate = {
  key: 'SYSTEM_LINEAR',
  version: 1,
  name: 'System Test Linear Workflow V1',
  steps: [
    {
      key: 'STEP_A',
      name: 'Step A - Linear Initializer',
      handlerKey: 'OUTPUT',
      dependsOn: [],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'STEP_B',
      name: 'Step B - Linear Intermediate',
      handlerKey: 'OUTPUT',
      dependsOn: ['STEP_A'],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'STEP_C',
      name: 'Step C - Linear Finalizer',
      handlerKey: 'OUTPUT',
      dependsOn: ['STEP_B'],
      maxAttempts: 3,
      priority: 10,
    },
  ],
};

/**
 * Infrastructure-only test template: Parallel branch and join.
 * STEP_A -> (STEP_B, STEP_C) in parallel -> STEP_D waits for both.
 */
export const SYSTEM_PARALLEL_JOIN_V1: WorkflowTemplate = {
  key: 'SYSTEM_PARALLEL_JOIN',
  version: 1,
  name: 'System Test Parallel Join Workflow V1',
  steps: [
    {
      key: 'STEP_A',
      name: 'Step A - Root Fork',
      handlerKey: 'OUTPUT',
      dependsOn: [],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'STEP_B',
      name: 'Step B - Parallel Branch 1',
      handlerKey: 'OUTPUT',
      dependsOn: ['STEP_A'],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'STEP_C',
      name: 'Step C - Parallel Branch 2',
      handlerKey: 'OUTPUT',
      dependsOn: ['STEP_A'],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'STEP_D',
      name: 'Step D - Join Synchronization Barrier',
      handlerKey: 'OUTPUT',
      dependsOn: ['STEP_B', 'STEP_C'],
      maxAttempts: 3,
      priority: 10,
    },
  ],
};

/**
 * Infrastructure-only test template: Conditional step.
 * STEP_A -> STEP_B (runs only if STEP_A output has continue === true) -> STEP_C (depends on STEP_B).
 */
export const SYSTEM_CONDITIONAL_V1: WorkflowTemplate = {
  key: 'SYSTEM_CONDITIONAL',
  version: 1,
  name: 'System Test Conditional Workflow V1',
  steps: [
    {
      key: 'STEP_A',
      name: 'Step A - Conditional Evaluator',
      handlerKey: 'OUTPUT',
      dependsOn: [],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'STEP_B',
      name: 'Step B - Conditional Branch',
      handlerKey: 'OUTPUT',
      dependsOn: ['STEP_A'],
      condition: {
        type: 'STEP_OUTPUT_EQUALS',
        stepKey: 'STEP_A',
        field: 'continue',
        value: true,
      },
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'STEP_C',
      name: 'Step C - Post-Condition Continuation',
      handlerKey: 'OUTPUT',
      dependsOn: ['STEP_B'],
      maxAttempts: 3,
      priority: 10,
    },
  ],
};

/**
 * Infrastructure-only test template: Retry workflow.
 * STEP_A fails transiently on attempt 1, succeeds on attempt 2.
 */
export const SYSTEM_RETRY_V1: WorkflowTemplate = {
  key: 'SYSTEM_RETRY',
  version: 1,
  name: 'System Test Retry Workflow V1',
  steps: [
    {
      key: 'STEP_A',
      name: 'Step A - Transient Flaky Step',
      handlerKey: 'FAIL_TRANSIENT_ONCE',
      dependsOn: [],
      maxAttempts: 3,
      priority: 10,
    },
  ],
};

/**
 * Helper to populate registry with default system test templates.
 */
export function registerSystemTemplates(registry: { register: (t: WorkflowTemplate) => void }): void {
  registry.register(SYSTEM_LINEAR_V1);
  registry.register(SYSTEM_PARALLEL_JOIN_V1);
  registry.register(SYSTEM_CONDITIONAL_V1);
  registry.register(SYSTEM_RETRY_V1);
}
