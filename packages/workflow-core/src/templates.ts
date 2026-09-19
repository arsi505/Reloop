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
 * Infrastructure-only test template: Human-in-the-loop approval workflow.
 * STEP_CHECK -> STEP_APPROVAL (waits for human decision) -> STEP_EXECUTE -> STEP_VERIFY.
 */
export const SYSTEM_APPROVAL_V1: WorkflowTemplate = {
  key: 'SYSTEM_APPROVAL',
  version: 1,
  name: 'System Test Approval Workflow V1',
  steps: [
    {
      key: 'STEP_CHECK',
      name: 'Step Check - Pre-Approval Verification',
      type: 'EXECUTION',
      handlerKey: 'OUTPUT',
      dependsOn: [],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'STEP_APPROVAL',
      name: 'Step Approval - Human in the Loop Decision',
      type: 'APPROVAL',
      dependsOn: ['STEP_CHECK'],
      preview: {
        version: 1,
        problem: 'Simulated carrier delivery exception detected requiring order remediation',
        proposedAction: 'Re-issue replacement shipment with priority carrier dispatch',
        why: 'Original tracking number marked damaged in transit by carrier',
        safetyChecks: [
          'Verify original inventory allocation released',
          'Confirm customer shipping address is deliverable',
          'Ensure idempotency key matches original order reference',
        ],
        changes: [
          'Generate replacement shipment label',
          'Deduct inventory from alternate fulfillment node',
        ],
        nonChanges: [
          'Do not modify existing payment authorization',
          'Do not change customer contact preferences',
        ],
        systems: ['Shopify', 'ShipStation', 'InventoryService'],
        risks: [
          'Potential duplicate shipment if carrier recovers original package',
        ],
        recoveryLevel: 'L2_REPLACE',
        caseReference: 'CASE-SYS-APP-001',
        orderReference: 'ORD-TEST-9988',
        expectedVerification: 'Confirm new tracking ID is registered and active within 15 minutes',
      },
      priority: 10,
    },
    {
      key: 'STEP_EXECUTE',
      name: 'Step Execute - Post-Approval Action',
      type: 'EXECUTION',
      handlerKey: 'OUTPUT',
      dependsOn: ['STEP_APPROVAL'],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'STEP_VERIFY',
      name: 'Step Verify - Post-Execution Validation',
      type: 'EXECUTION',
      handlerKey: 'OUTPUT',
      dependsOn: ['STEP_EXECUTE'],
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
  registry.register(SYSTEM_APPROVAL_V1);
}

/**
 * Recovery Template A: Missing Shopify Tracking (Automated)
 * CHECK -> EXECUTE -> VERIFY
 */
export const RECOVERY_TRACKING_MISSING_AUTO_V1: WorkflowTemplate = {
  key: 'RECOVERY_TRACKING_MISSING_AUTO',
  version: 1,
  name: 'Recovery: Missing Shopify Tracking (Automated)',
  steps: [
    {
      key: 'CHECK',
      name: 'Check Live Order & Fulfillment State',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_CHECK_TRACKING',
      dependsOn: [],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'EXECUTE',
      name: 'Apply Verified Tracking to Shopify',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_EXECUTE_TRACKING',
      dependsOn: ['CHECK'],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'VERIFY',
      name: 'Verify Shopify & 3PL Tracking Agreement',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_VERIFY_TRACKING',
      dependsOn: ['EXECUTE'],
      maxAttempts: 3,
      priority: 10,
    },
  ],
};

/**
 * Recovery Template B: Missing Shopify Tracking (Human Approval)
 * CHECK -> APPROVAL -> EXECUTE -> VERIFY
 */
export const RECOVERY_TRACKING_MISSING_APPROVAL_V1: WorkflowTemplate = {
  key: 'RECOVERY_TRACKING_MISSING_APPROVAL',
  version: 1,
  name: 'Recovery: Missing Shopify Tracking (Human Approval)',
  steps: [
    {
      key: 'CHECK',
      name: 'Check Live Order & Fulfillment State',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_CHECK_TRACKING',
      dependsOn: [],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'APPROVAL',
      name: 'Approve Shopify Tracking Update',
      type: 'APPROVAL',
      dependsOn: ['CHECK'],
      preview: {
        version: 1,
        problem: 'Shopify order is missing tracking details despite active shipment in fulfillment network.',
        proposedAction: 'Update Shopify fulfillment with verified carrier and tracking number.',
        why: 'Customer cannot track shipment and delivery notifications are stalled.',
        safetyChecks: [
          'Verify order identity matches deterministically',
          'Verify carrier and tracking number format are valid',
          'Ensure no conflicting fulfillment exists in Shopify',
        ],
        changes: [
          'Add tracking number and carrier to Shopify fulfillment record',
          'Advance fulfillment state if required',
        ],
        nonChanges: [
          'Do not modify order line items or quantities',
          'Do not re-charge customer payment',
        ],
        systems: ['Shopify', 'Generic3PL'],
        risks: [
          'Customer receives notification for an existing shipment',
        ],
        recoveryLevel: 'REQUIRE_APPROVAL',
        expectedVerification: 'Shopify and 3PL tracking numbers match identically.',
      },
      priority: 10,
    },
    {
      key: 'EXECUTE',
      name: 'Apply Approved Tracking to Shopify',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_EXECUTE_TRACKING',
      dependsOn: ['APPROVAL'],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'VERIFY',
      name: 'Verify Shopify & 3PL Tracking Agreement',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_VERIFY_TRACKING',
      dependsOn: ['EXECUTE'],
      maxAttempts: 3,
      priority: 10,
    },
  ],
};

/**
 * Recovery Template C: Order Missing at 3PL (Human Approval)
 * CHECK -> APPROVAL -> EXECUTE -> VERIFY
 */
export const RECOVERY_ORDER_MISSING_3PL_V1: WorkflowTemplate = {
  key: 'RECOVERY_ORDER_MISSING_3PL',
  version: 1,
  name: 'Recovery: Order Missing at 3PL (Human Approval)',
  steps: [
    {
      key: 'CHECK',
      name: 'Check Order Existence & Fulfillment Grace Period',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_CHECK_ORDER_3PL',
      dependsOn: [],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'APPROVAL',
      name: 'Approve Creation of Order at 3PL',
      type: 'APPROVAL',
      dependsOn: ['CHECK'],
      preview: {
        version: 1,
        problem: 'Shopify order exists but corresponding warehouse order is missing at 3PL.',
        proposedAction: 'Create the corresponding order at the configured 3PL warehouse.',
        why: 'Order cannot be packed or shipped until registered at the warehouse.',
        safetyChecks: [
          'Verify order is paid and valid in Shopify',
          'Search warehouse again by order number and reference to avoid duplicates',
          'Ensure customer shipping address is deliverable',
        ],
        changes: [
          'Transmit new warehouse order with line items to 3PL',
        ],
        nonChanges: [
          'Do not modify Shopify order status',
          'Do not alter customer payment',
        ],
        systems: ['Shopify', 'Generic3PL'],
        risks: [
          'Risk of duplicate fulfillment if warehouse order existed under alternate reference',
        ],
        recoveryLevel: 'REQUIRE_APPROVAL',
        expectedVerification: 'Warehouse confirms order is received and queued for fulfillment.',
      },
      priority: 10,
    },
    {
      key: 'EXECUTE',
      name: 'Create Warehouse Order at 3PL',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_EXECUTE_ORDER_3PL',
      dependsOn: ['APPROVAL'],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'VERIFY',
      name: 'Verify 3PL Warehouse Order Receipt',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_VERIFY_ORDER_3PL',
      dependsOn: ['EXECUTE'],
      maxAttempts: 3,
      priority: 10,
    },
  ],
};

/**
 * Recovery Template D: Shipped at 3PL / Shopify Unfulfilled (Human Approval)
 * CHECK -> APPROVAL -> EXECUTE -> VERIFY
 */
export const RECOVERY_SHIPPED_UNFULFILLED_V1: WorkflowTemplate = {
  key: 'RECOVERY_SHIPPED_UNFULFILLED',
  version: 1,
  name: 'Recovery: Shipped at 3PL / Shopify Unfulfilled (Human Approval)',
  steps: [
    {
      key: 'CHECK',
      name: 'Check Live 3PL Shipment & Shopify Fulfillment',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_CHECK_SHIPPED_UNFULFILLED',
      dependsOn: [],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'APPROVAL',
      name: 'Approve Marking Shopify Order Fulfilled',
      type: 'APPROVAL',
      dependsOn: ['CHECK'],
      preview: {
        version: 1,
        problem: '3PL warehouse marked order as SHIPPED, but Shopify order remains UNFULFILLED.',
        proposedAction: 'Mark Shopify order as fulfilled with tracking details from 3PL.',
        why: 'Keep e-commerce store status synchronized with physical warehouse reality.',
        safetyChecks: [
          'Verify 3PL shipment is genuinely dispatched',
          'Ensure tracking number belongs to this specific order',
          'Verify line item quantities match warehouse shipment',
        ],
        changes: [
          'Set Shopify order fulfillment status to FULFILLED',
          'Attach 3PL tracking number to Shopify order',
        ],
        nonChanges: [
          'Do not modify warehouse order or inventory',
          'Do not initiate new shipping labels',
        ],
        systems: ['Shopify', 'Generic3PL'],
        risks: [
          'Customer notification sent if Shopify notification triggers are active',
        ],
        recoveryLevel: 'REQUIRE_APPROVAL',
        expectedVerification: 'Shopify order reflects FULFILLED and matches 3PL shipment tracking.',
      },
      priority: 10,
    },
    {
      key: 'EXECUTE',
      name: 'Mark Shopify Order Fulfilled',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_EXECUTE_SHIPPED_UNFULFILLED',
      dependsOn: ['APPROVAL'],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'VERIFY',
      name: 'Verify State Convergence Across Systems',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_VERIFY_SHIPPED_UNFULFILLED',
      dependsOn: ['EXECUTE'],
      maxAttempts: 3,
      priority: 10,
    },
  ],
};

/**
 * Recovery Template E: Stuck Order Investigation (Read-Only)
 * CHECK -> INVESTIGATE -> VERIFY
 */
export const RECOVERY_STUCK_INVESTIGATION_V1: WorkflowTemplate = {
  key: 'RECOVERY_STUCK_INVESTIGATION',
  version: 1,
  name: 'Recovery: Stuck Order Investigation (Read Only)',
  steps: [
    {
      key: 'CHECK',
      name: 'Check Order Timestamps & Current Progress',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_CHECK_STUCK_ORDER',
      dependsOn: [],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'INVESTIGATE',
      name: 'Investigate Inactivity & Collect Evidence',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_INVESTIGATE_STUCK_ORDER',
      dependsOn: ['CHECK'],
      maxAttempts: 3,
      priority: 10,
    },
    {
      key: 'VERIFY',
      name: 'Record Investigation Outcome & Convergence Check',
      type: 'EXECUTION',
      handlerKey: 'RECOVERY_VERIFY_STUCK_ORDER',
      dependsOn: ['INVESTIGATE'],
      maxAttempts: 3,
      priority: 10,
    },
  ],
};

/**
 * Helper to populate registry with canonical Day 13 recovery templates.
 */
export function registerRecoveryTemplates(registry: { register: (t: WorkflowTemplate) => void }): void {
  registry.register(RECOVERY_TRACKING_MISSING_AUTO_V1);
  registry.register(RECOVERY_TRACKING_MISSING_APPROVAL_V1);
  registry.register(RECOVERY_ORDER_MISSING_3PL_V1);
  registry.register(RECOVERY_SHIPPED_UNFULFILLED_V1);
  registry.register(RECOVERY_STUCK_INVESTIGATION_V1);
}
