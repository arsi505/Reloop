export type WorkflowConditionType = 'ALWAYS' | 'STEP_OUTPUT_EQUALS';

export interface AlwaysCondition {
  type: 'ALWAYS';
}

export interface StepOutputEqualsCondition {
  type: 'STEP_OUTPUT_EQUALS';
  stepKey: string;
  field: string;
  value: string | number | boolean | null;
}

export type WorkflowCondition = AlwaysCondition | StepOutputEqualsCondition;

export type WorkflowStepType = 'EXECUTION' | 'APPROVAL';

export interface RecoveryPreview {
  version: 1;
  problem: string;
  proposedAction: string;
  why: string;
  safetyChecks: string[];
  changes: string[];
  nonChanges: string[];
  systems: string[];
  risks: string[];
  recoveryLevel?: string;
  caseReference?: string;
  orderReference?: string;
  expectedVerification?: string;
}

export interface WorkflowStepDefinition {
  key: string;
  name: string;
  type?: WorkflowStepType;
  handlerKey?: string;
  preview?: RecoveryPreview;
  dependsOn?: string[];
  condition?: WorkflowCondition;
  maxAttempts?: number;
  priority?: number;
}

export interface WorkflowTemplate {
  key: string;
  version: number;
  name: string;
  steps: WorkflowStepDefinition[];
}

export interface WorkflowStepResult {
  output?: Record<string, unknown> | null;
}
