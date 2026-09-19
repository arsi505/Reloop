import { WorkflowTemplate, WorkflowStepDefinition, RecoveryPreview } from './types';

export class WorkflowTemplateValidationError extends Error {
  constructor(message: string) {
    super(`[WorkflowTemplateValidationError] ${message}`);
    this.name = 'WorkflowTemplateValidationError';
  }
}

/**
 * Validates that a workflow template is well-formed, acyclic, and adheres to DAG rules.
 * Throws WorkflowTemplateValidationError on any violation.
 */
export function validateWorkflowTemplate(template: WorkflowTemplate): void {
  if (!template) {
    throw new WorkflowTemplateValidationError('Template must be defined.');
  }

  if (!template.key || typeof template.key !== 'string' || template.key.trim().length === 0) {
    throw new WorkflowTemplateValidationError('Template key must be a non-empty string.');
  }

  if (!Number.isInteger(template.version) || template.version < 1) {
    throw new WorkflowTemplateValidationError(`Template version must be a positive integer, received: ${template.version}.`);
  }

  if (!template.name || typeof template.name !== 'string' || template.name.trim().length === 0) {
    throw new WorkflowTemplateValidationError('Template name must be a non-empty string.');
  }

  if (!Array.isArray(template.steps) || template.steps.length === 0) {
    throw new WorkflowTemplateValidationError('Template must contain at least one step.');
  }

  const stepKeys = new Set<string>();

  // 1. Validate individual step properties and uniqueness
  for (const step of template.steps) {
    if (!step.key || typeof step.key !== 'string' || step.key.trim().length === 0) {
      throw new WorkflowTemplateValidationError('Step key must be a non-empty string.');
    }

    if (stepKeys.has(step.key)) {
      throw new WorkflowTemplateValidationError(`Duplicate step key detected: "${step.key}". Step keys must be unique within a template.`);
    }
    stepKeys.add(step.key);

    if (!step.name || typeof step.name !== 'string' || step.name.trim().length === 0) {
      throw new WorkflowTemplateValidationError(`Step "${step.key}" must have a non-empty name.`);
    }

    const stepType = step.type ?? 'EXECUTION';
    if (stepType !== 'EXECUTION' && stepType !== 'APPROVAL') {
      throw new WorkflowTemplateValidationError(
        `Step "${step.key}" has invalid type "${stepType}". Must be "EXECUTION" or "APPROVAL".`,
      );
    }

    if (stepType === 'EXECUTION') {
      if (!step.handlerKey || typeof step.handlerKey !== 'string' || step.handlerKey.trim().length === 0) {
        throw new WorkflowTemplateValidationError(`Execution step "${step.key}" must have a non-empty handlerKey.`);
      }
    } else if (stepType === 'APPROVAL') {
      if (step.preview) {
        try {
          validateRecoveryPreview(step.preview);
        } catch (err: any) {
          throw new WorkflowTemplateValidationError(
            `Approval step "${step.key}" has invalid preview: ${err.message}`,
          );
        }
      }
    }

    if (step.maxAttempts !== undefined) {
      if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1) {
        throw new WorkflowTemplateValidationError(`Step "${step.key}" has invalid maxAttempts: ${step.maxAttempts}. Must be integer >= 1.`);
      }
    }

    if (step.priority !== undefined) {
      if (!Number.isInteger(step.priority)) {
        throw new WorkflowTemplateValidationError(`Step "${step.key}" has invalid priority: ${step.priority}. Must be integer.`);
      }
    }
  }

  // 2. Validate step direct dependencies
  const stepMap = new Map<string, WorkflowStepDefinition>();
  for (const step of template.steps) {
    stepMap.set(step.key, step);
    if (step.dependsOn && Array.isArray(step.dependsOn)) {
      for (const depKey of step.dependsOn) {
        if (depKey === step.key) {
          throw new WorkflowTemplateValidationError(`Step "${step.key}" cannot depend on itself (self-dependency).`);
        }
        if (!stepKeys.has(depKey)) {
          throw new WorkflowTemplateValidationError(`Step "${step.key}" depends on nonexistent step "${depKey}".`);
        }
      }
    }
  }

  // 3. Cycle detection (topological DFS)
  detectCycles(template.steps);

  // 4. Validate conditions and enforce transitive upstream ancestor requirement
  for (const step of template.steps) {
    if (step.condition) {
      if (step.condition.type === 'STEP_OUTPUT_EQUALS') {
        const cond = step.condition;
        if (!cond.stepKey || !stepKeys.has(cond.stepKey)) {
          throw new WorkflowTemplateValidationError(`Step "${step.key}" condition references nonexistent step "${cond.stepKey}".`);
        }
        if (cond.stepKey === step.key) {
          throw new WorkflowTemplateValidationError(`Step "${step.key}" condition cannot reference its own output.`);
        }
        if (!cond.field || typeof cond.field !== 'string' || cond.field.trim().length === 0) {
          throw new WorkflowTemplateValidationError(`Step "${step.key}" condition has empty target field.`);
        }

        // Enforce: Target step must be in the transitive upstream dependency ancestry
        const ancestors = getTransitiveAncestors(step.key, stepMap);
        if (!ancestors.has(cond.stepKey)) {
          throw new WorkflowTemplateValidationError(
            `Step "${step.key}" condition targets "${cond.stepKey}", which is not a transitive upstream dependency in the DAG.`,
          );
        }
      }
    }
  }
}

/**
 * Computes the set of all transitive upstream ancestor step keys for a given step.
 */
function getTransitiveAncestors(
  stepKey: string,
  stepMap: Map<string, WorkflowStepDefinition>,
): Set<string> {
  const ancestors = new Set<string>();
  const queue = [...(stepMap.get(stepKey)?.dependsOn ?? [])];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!ancestors.has(current)) {
      ancestors.add(current);
      const parentStep = stepMap.get(current);
      if (parentStep?.dependsOn) {
        for (const dep of parentStep.dependsOn) {
          if (!ancestors.has(dep)) {
            queue.push(dep);
          }
        }
      }
    }
  }

  return ancestors;
}

/**
 * Detects cycles in the DAG using 3-color DFS (0: unvisited, 1: visiting, 2: visited).
 */
function detectCycles(steps: WorkflowStepDefinition[]): void {
  const stepMap = new Map<string, WorkflowStepDefinition>();
  for (const step of steps) {
    stepMap.set(step.key, step);
  }

  const visited = new Map<string, number>(); // 0: unvisited, 1: visiting, 2: visited
  for (const step of steps) {
    visited.set(step.key, 0);
  }

  function dfs(currentKey: string, path: string[]): void {
    visited.set(currentKey, 1);
    path.push(currentKey);

    const currentStep = stepMap.get(currentKey);
    const deps = currentStep?.dependsOn ?? [];

    for (const depKey of deps) {
      const state = visited.get(depKey);
      if (state === 1) {
        const cyclePath = [...path, depKey].join(' -> ');
        throw new WorkflowTemplateValidationError(`Cyclic dependency detected in workflow DAG: ${cyclePath}`);
      }
      if (state === 0) {
        dfs(depKey, path);
      }
    }

    path.pop();
    visited.set(currentKey, 2);
  }

  for (const step of steps) {
    if (visited.get(step.key) === 0) {
      dfs(step.key, []);
    }
  }
}

const MAX_STRING_LENGTH = 10000;
const MAX_ITEM_LENGTH = 2000;
const MAX_ARRAY_LENGTH = 100;

/**
 * Validates a structured Recovery Preview contract.
 * Throws WorkflowTemplateValidationError if the contract is violated.
 */
export function validateRecoveryPreview(preview: RecoveryPreview): void {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    throw new WorkflowTemplateValidationError('RecoveryPreview must be a non-null object.');
  }

  if (preview.version !== 1) {
    throw new WorkflowTemplateValidationError(
      `RecoveryPreview version must be 1, received: ${(preview as any).version}.`,
    );
  }

  const requiredStringFields: (keyof RecoveryPreview)[] = ['problem', 'proposedAction', 'why'];
  for (const field of requiredStringFields) {
    const val = preview[field];
    if (typeof val !== 'string' || val.trim().length === 0) {
      throw new WorkflowTemplateValidationError(
        `RecoveryPreview "${field}" must be a non-empty string.`,
      );
    }
    if (val.length > MAX_STRING_LENGTH) {
      throw new WorkflowTemplateValidationError(
        `RecoveryPreview "${field}" exceeds max length of ${MAX_STRING_LENGTH} characters.`,
      );
    }
  }

  const requiredArrayFields: (keyof RecoveryPreview)[] = [
    'safetyChecks',
    'changes',
    'nonChanges',
    'systems',
    'risks',
  ];
  for (const field of requiredArrayFields) {
    const arr = preview[field];
    if (!Array.isArray(arr)) {
      throw new WorkflowTemplateValidationError(
        `RecoveryPreview "${field}" must be an array of strings.`,
      );
    }
    if (arr.length > MAX_ARRAY_LENGTH) {
      throw new WorkflowTemplateValidationError(
        `RecoveryPreview "${field}" exceeds maximum array length of ${MAX_ARRAY_LENGTH}.`,
      );
    }
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new WorkflowTemplateValidationError(
          `RecoveryPreview "${field}[${i}]" must be a non-empty string.`,
        );
      }
      if (item.length > MAX_ITEM_LENGTH) {
        throw new WorkflowTemplateValidationError(
          `RecoveryPreview "${field}[${i}]" exceeds max item length of ${MAX_ITEM_LENGTH} characters.`,
        );
      }
    }
  }

  const optionalStringFields: (keyof RecoveryPreview)[] = [
    'recoveryLevel',
    'caseReference',
    'orderReference',
    'expectedVerification',
  ];
  for (const field of optionalStringFields) {
    const val = preview[field];
    if (val !== undefined && val !== null) {
      if (typeof val !== 'string') {
        throw new WorkflowTemplateValidationError(
          `RecoveryPreview "${field}" must be a string if provided.`,
        );
      }
      if (val.length > MAX_ITEM_LENGTH) {
        throw new WorkflowTemplateValidationError(
          `RecoveryPreview "${field}" exceeds max length of ${MAX_ITEM_LENGTH} characters.`,
        );
      }
    }
  }
}
