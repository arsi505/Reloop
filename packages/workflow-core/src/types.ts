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

export interface WorkflowStepDefinition {
  key: string;
  name: string;
  handlerKey: string;
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
