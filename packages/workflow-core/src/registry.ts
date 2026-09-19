import { WorkflowTemplate } from './types';
import { validateWorkflowTemplate, WorkflowTemplateValidationError } from './validation';

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function deepCloneAndFreeze(template: WorkflowTemplate): WorkflowTemplate {
  const cloned: WorkflowTemplate = {
    key: template.key,
    version: template.version,
    name: template.name,
    steps: template.steps.map((step) => ({
      key: step.key,
      name: step.name,
      type: step.type,
      handlerKey: step.handlerKey,
      preview: step.preview
        ? {
            version: step.preview.version,
            problem: step.preview.problem,
            proposedAction: step.preview.proposedAction,
            why: step.preview.why,
            safetyChecks: [...step.preview.safetyChecks],
            changes: [...step.preview.changes],
            nonChanges: [...step.preview.nonChanges],
            systems: [...step.preview.systems],
            risks: [...step.preview.risks],
            recoveryLevel: step.preview.recoveryLevel,
            caseReference: step.preview.caseReference,
            orderReference: step.preview.orderReference,
            expectedVerification: step.preview.expectedVerification,
          }
        : undefined,
      dependsOn: step.dependsOn ? [...step.dependsOn] : undefined,
      condition: step.condition
        ? step.condition.type === 'STEP_OUTPUT_EQUALS'
          ? { ...step.condition }
          : { type: 'ALWAYS' }
        : undefined,
      maxAttempts: step.maxAttempts,
      priority: step.priority,
    })),
  };
  return deepFreeze(cloned);
}

export class WorkflowTemplateRegistry {
  private templates = new Map<string, WorkflowTemplate>();

  private makeRegistryKey(key: string, version: number): string {
    return `${key}:v${version}`;
  }

  /**
   * Registers a workflow template.
   * Validates structure, deep clones to sever external references, and recursively freezes all objects and arrays.
   */
  register(template: WorkflowTemplate): void {
    validateWorkflowTemplate(template);

    const registryKey = this.makeRegistryKey(template.key, template.version);
    if (this.templates.has(registryKey)) {
      throw new WorkflowTemplateValidationError(
        `Template "${template.key}" version ${template.version} is already registered. Workflow templates are immutable.`,
      );
    }

    // Deep clone and recursively deep-freeze to guarantee total immutability
    this.templates.set(registryKey, deepCloneAndFreeze(template));
  }

  get(key: string, version: number): WorkflowTemplate | undefined {
    return this.templates.get(this.makeRegistryKey(key, version));
  }

  has(key: string, version: number): boolean {
    return this.templates.has(this.makeRegistryKey(key, version));
  }

  getAll(): WorkflowTemplate[] {
    return Array.from(this.templates.values());
  }

  clear(): void {
    this.templates.clear();
  }
}
