import { WorkflowCondition } from './types';

/**
 * Pure, deterministic condition evaluation.
 * Evaluates declarative conditions without dynamic code execution, eval(), or Function().
 */
export function evaluateCondition(
  condition: WorkflowCondition | undefined | null,
  stepOutputs: Record<string, unknown>,
): boolean {
  if (!condition || condition.type === 'ALWAYS') {
    return true;
  }

  if (condition.type === 'STEP_OUTPUT_EQUALS') {
    const upstreamOutput = stepOutputs[condition.stepKey];
    if (
      upstreamOutput === undefined ||
      upstreamOutput === null ||
      typeof upstreamOutput !== 'object'
    ) {
      return false;
    }

    const outputObj = upstreamOutput as Record<string, unknown>;
    const actualVal = outputObj[condition.field];

    return actualVal === condition.value;
  }

  return false;
}
