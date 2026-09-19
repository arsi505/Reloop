import {
  WorkflowTemplateRegistry,
  validateWorkflowTemplate,
  validateRecoveryPreview,
  WorkflowTemplateValidationError,
  evaluateCondition,
  registerSystemTemplates,
  SYSTEM_LINEAR_V1,
  SYSTEM_PARALLEL_JOIN_V1,
  SYSTEM_CONDITIONAL_V1,
  SYSTEM_RETRY_V1,
  SYSTEM_APPROVAL_V1,
  WorkflowTemplate,
} from '../src';

describe('WorkflowTemplateRegistry & DAG Validation', () => {
  let registry: WorkflowTemplateRegistry;

  beforeEach(() => {
    registry = new WorkflowTemplateRegistry();
  });

  describe('System Templates Validation', () => {
    it('validates and registers all system templates cleanly', () => {
      registerSystemTemplates(registry);

      expect(registry.has('SYSTEM_LINEAR', 1)).toBe(true);
      expect(registry.has('SYSTEM_PARALLEL_JOIN', 1)).toBe(true);
      expect(registry.has('SYSTEM_CONDITIONAL', 1)).toBe(true);
      expect(registry.has('SYSTEM_RETRY', 1)).toBe(true);
      expect(registry.has('SYSTEM_APPROVAL', 1)).toBe(true);

      const all = registry.getAll();
      expect(all).toHaveLength(5);
    });

    it('retrieves registered templates by key and version', () => {
      registry.register(SYSTEM_LINEAR_V1);
      const retrieved = registry.get('SYSTEM_LINEAR', 1);
      expect(retrieved).toBeDefined();
      expect(retrieved?.key).toBe('SYSTEM_LINEAR');
      expect(retrieved?.version).toBe(1);
      expect(retrieved?.steps).toHaveLength(3);
    });

    it('returns undefined for unregistered template or version', () => {
      registry.register(SYSTEM_LINEAR_V1);
      expect(registry.get('SYSTEM_LINEAR', 2)).toBeUndefined();
      expect(registry.get('UNKNOWN_TEMPLATE', 1)).toBeUndefined();
    });
  });

  describe('Immutability & Versioning', () => {
    it('rejects re-registration of the same template key and version', () => {
      registry.register(SYSTEM_LINEAR_V1);

      expect(() => {
        registry.register(SYSTEM_LINEAR_V1);
      }).toThrow(WorkflowTemplateValidationError);
      expect(() => {
        registry.register(SYSTEM_LINEAR_V1);
      }).toThrow(/already registered/);
    });

    it('allows registering a new version of an existing template key without mutating v1', () => {
      registry.register(SYSTEM_LINEAR_V1);

      const linearV2: WorkflowTemplate = {
        key: 'SYSTEM_LINEAR',
        version: 2,
        name: 'System Test Linear Workflow V2',
        steps: [
          {
            key: 'STEP_A',
            name: 'Step A',
            handlerKey: 'OUTPUT',
            dependsOn: [],
          },
          {
            key: 'STEP_B',
            name: 'Step B',
            handlerKey: 'OUTPUT',
            dependsOn: ['STEP_A'],
          },
        ],
      };

      registry.register(linearV2);

      expect(registry.has('SYSTEM_LINEAR', 1)).toBe(true);
      expect(registry.has('SYSTEM_LINEAR', 2)).toBe(true);
      expect(registry.get('SYSTEM_LINEAR', 1)?.steps).toHaveLength(3);
      expect(registry.get('SYSTEM_LINEAR', 2)?.steps).toHaveLength(2);
    });

    it('deep freezes registered templates and prevents caller mutations from altering registry', () => {
      const original: WorkflowTemplate = {
        key: 'MUTABLE_TEST',
        version: 1,
        name: 'Mutable Test',
        steps: [
          {
            key: 'STEP_1',
            name: 'Step 1',
            handlerKey: 'NOOP',
            dependsOn: [],
            condition: { type: 'ALWAYS' },
          },
        ],
      };

      registry.register(original);

      // Mutating the caller's original object
      original.name = 'Hacked Name';
      original.steps.push({ key: 'STEP_2', name: 'Step 2', handlerKey: 'NOOP' });

      const retrieved = registry.get('MUTABLE_TEST', 1)!;
      expect(retrieved.name).toBe('Mutable Test');
      expect(retrieved.steps).toHaveLength(1);
      expect(Object.isFrozen(retrieved)).toBe(true);
      expect(Object.isFrozen(retrieved.steps)).toBe(true);
      expect(Object.isFrozen(retrieved.steps[0])).toBe(true);
      expect(Object.isFrozen(retrieved.steps[0].dependsOn)).toBe(true);
      expect(Object.isFrozen(retrieved.steps[0].condition)).toBe(true);

      // Mutating the retrieved object should throw in strict mode
      expect(() => {
        (retrieved as any).name = 'Cannot Mutate';
      }).toThrow();
      expect(() => {
        (retrieved.steps as any).push({ key: 'STEP_3' });
      }).toThrow();
    });
  });

  describe('DAG Validation & Structural Rules', () => {
    it('rejects template with empty key or name', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: '',
          version: 1,
          name: 'Invalid',
          steps: [{ key: 'A', name: 'A', handlerKey: 'NOOP' }],
        });
      }).toThrow('Template key must be a non-empty string.');

      expect(() => {
        validateWorkflowTemplate({
          key: 'VALID',
          version: 1,
          name: '',
          steps: [{ key: 'A', name: 'A', handlerKey: 'NOOP' }],
        });
      }).toThrow('Template name must be a non-empty string.');
    });

    it('rejects template with invalid version (< 1 or non-integer)', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'VALID',
          version: 0,
          name: 'Invalid',
          steps: [{ key: 'A', name: 'A', handlerKey: 'NOOP' }],
        });
      }).toThrow(/version must be a positive integer/);

      expect(() => {
        validateWorkflowTemplate({
          key: 'VALID',
          version: 1.5,
          name: 'Invalid',
          steps: [{ key: 'A', name: 'A', handlerKey: 'NOOP' }],
        });
      }).toThrow(/version must be a positive integer/);
    });

    it('rejects template with empty steps array', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'VALID',
          version: 1,
          name: 'No Steps',
          steps: [],
        });
      }).toThrow('Template must contain at least one step.');
    });

    it('rejects duplicate step keys within a template', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'DUP_STEPS',
          version: 1,
          name: 'Duplicate Step Keys',
          steps: [
            { key: 'STEP_1', name: 'First', handlerKey: 'NOOP' },
            { key: 'STEP_1', name: 'Second', handlerKey: 'NOOP' },
          ],
        });
      }).toThrow(/Duplicate step key detected: "STEP_1"/);
    });

    it('rejects self-dependency', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'SELF_DEP',
          version: 1,
          name: 'Self Dep',
          steps: [
            { key: 'STEP_A', name: 'Self', handlerKey: 'NOOP', dependsOn: ['STEP_A'] },
          ],
        });
      }).toThrow(/cannot depend on itself/);
    });

    it('rejects dependency on nonexistent step', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'MISSING_DEP',
          version: 1,
          name: 'Missing Dep',
          steps: [
            { key: 'STEP_A', name: 'A', handlerKey: 'NOOP', dependsOn: ['GHOST_STEP'] },
          ],
        });
      }).toThrow(/depends on nonexistent step "GHOST_STEP"/);
    });

    it('rejects direct cyclic dependencies (A -> B -> A)', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'DIRECT_CYCLE',
          version: 1,
          name: 'Direct Cycle',
          steps: [
            { key: 'A', name: 'A', handlerKey: 'NOOP', dependsOn: ['B'] },
            { key: 'B', name: 'B', handlerKey: 'NOOP', dependsOn: ['A'] },
          ],
        });
      }).toThrow(/Cyclic dependency detected in workflow DAG/);
    });

    it('rejects transitive cyclic dependencies (A -> B -> C -> A)', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'TRANSITIVE_CYCLE',
          version: 1,
          name: 'Transitive Cycle',
          steps: [
            { key: 'A', name: 'A', handlerKey: 'NOOP', dependsOn: ['C'] },
            { key: 'B', name: 'B', handlerKey: 'NOOP', dependsOn: ['A'] },
            { key: 'C', name: 'C', handlerKey: 'NOOP', dependsOn: ['B'] },
          ],
        });
      }).toThrow(/Cyclic dependency detected in workflow DAG/);
    });

    it('rejects invalid step maxAttempts (< 1)', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'INVALID_ATTEMPTS',
          version: 1,
          name: 'Invalid Attempts',
          steps: [
            { key: 'A', name: 'A', handlerKey: 'NOOP', maxAttempts: 0 },
          ],
        });
      }).toThrow(/invalid maxAttempts: 0/);
    });

    it('rejects condition referencing nonexistent upstream step', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'BAD_COND_TARGET',
          version: 1,
          name: 'Bad Condition Target',
          steps: [
            {
              key: 'A',
              name: 'A',
              handlerKey: 'NOOP',
              condition: {
                type: 'STEP_OUTPUT_EQUALS',
                stepKey: 'NON_EXISTENT',
                field: 'status',
                value: 'ok',
              },
            },
          ],
        });
      }).toThrow(/condition references nonexistent step "NON_EXISTENT"/);
    });

    it('rejects condition referencing its own step output', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'SELF_COND',
          version: 1,
          name: 'Self Condition',
          steps: [
            {
              key: 'A',
              name: 'A',
              handlerKey: 'NOOP',
              condition: {
                type: 'STEP_OUTPUT_EQUALS',
                stepKey: 'A',
                field: 'status',
                value: 'ok',
              },
            },
          ],
        });
      }).toThrow(/cannot reference its own output/);
    });

    it('rejects condition referencing a downstream step', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'DOWNSTREAM_COND',
          version: 1,
          name: 'Downstream Condition',
          steps: [
            {
              key: 'A',
              name: 'A',
              handlerKey: 'NOOP',
              dependsOn: [],
              condition: {
                type: 'STEP_OUTPUT_EQUALS',
                stepKey: 'B',
                field: 'status',
                value: 'ok',
              },
            },
            {
              key: 'B',
              name: 'B',
              handlerKey: 'NOOP',
              dependsOn: ['A'],
            },
          ],
        });
      }).toThrow(/not a transitive upstream dependency in the DAG/);
    });

    it('rejects condition referencing an unlinked sibling branch', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'SIBLING_COND',
          version: 1,
          name: 'Sibling Condition',
          steps: [
            { key: 'A', name: 'A', handlerKey: 'NOOP', dependsOn: [] },
            { key: 'B', name: 'B', handlerKey: 'NOOP', dependsOn: ['A'] },
            { key: 'C', name: 'C', handlerKey: 'NOOP', dependsOn: ['A'] },
            {
              key: 'D',
              name: 'D',
              handlerKey: 'NOOP',
              dependsOn: ['B'],
              condition: {
                type: 'STEP_OUTPUT_EQUALS',
                stepKey: 'C', // C is not in D's transitive ancestry (D -> B -> A)
                field: 'status',
                value: 'ok',
              },
            },
          ],
        });
      }).toThrow(/not a transitive upstream dependency in the DAG/);
    });

    it('accepts condition referencing a valid transitive upstream ancestor', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'VALID_TRANSITIVE_COND',
          version: 1,
          name: 'Valid Transitive Condition',
          steps: [
            { key: 'A', name: 'A', handlerKey: 'NOOP', dependsOn: [] },
            { key: 'B', name: 'B', handlerKey: 'NOOP', dependsOn: ['A'] },
            {
              key: 'C',
              name: 'C',
              handlerKey: 'NOOP',
              dependsOn: ['B'],
              condition: {
                type: 'STEP_OUTPUT_EQUALS',
                stepKey: 'A', // A is an ancestor of C via B
                field: 'approved',
                value: true,
              },
            },
          ],
        });
      }).not.toThrow();
    });
  });

  describe('Safe Declarative Condition Evaluation', () => {
    it('evaluates undefined condition or ALWAYS as true', () => {
      expect(evaluateCondition(undefined, {})).toBe(true);
      expect(evaluateCondition(null, {})).toBe(true);
      expect(evaluateCondition({ type: 'ALWAYS' }, {})).toBe(true);
    });

    it('evaluates STEP_OUTPUT_EQUALS as true when field matches expected primitive', () => {
      const outputs = {
        STEP_A: { continue: true, count: 42, label: 'test' },
      };

      expect(
        evaluateCondition(
          { type: 'STEP_OUTPUT_EQUALS', stepKey: 'STEP_A', field: 'continue', value: true },
          outputs,
        ),
      ).toBe(true);

      expect(
        evaluateCondition(
          { type: 'STEP_OUTPUT_EQUALS', stepKey: 'STEP_A', field: 'count', value: 42 },
          outputs,
        ),
      ).toBe(true);

      expect(
        evaluateCondition(
          { type: 'STEP_OUTPUT_EQUALS', stepKey: 'STEP_A', field: 'label', value: 'test' },
          outputs,
        ),
      ).toBe(true);
    });

    it('evaluates STEP_OUTPUT_EQUALS as false when field value mismatches', () => {
      const outputs = {
        STEP_A: { continue: false },
      };

      expect(
        evaluateCondition(
          { type: 'STEP_OUTPUT_EQUALS', stepKey: 'STEP_A', field: 'continue', value: true },
          outputs,
        ),
      ).toBe(false);
    });

    it('evaluates STEP_OUTPUT_EQUALS as false when upstream output or field is missing', () => {
      expect(
        evaluateCondition(
          { type: 'STEP_OUTPUT_EQUALS', stepKey: 'STEP_A', field: 'continue', value: true },
          {},
        ),
      ).toBe(false);

      expect(
        evaluateCondition(
          { type: 'STEP_OUTPUT_EQUALS', stepKey: 'STEP_A', field: 'missingField', value: true },
          { STEP_A: { other: 123 } },
        ),
      ).toBe(false);
    });
  });

  describe('Approval Step & Recovery Preview Validation', () => {
    const validPreview = {
      version: 1 as const,
      problem: 'Order packaging error',
      proposedAction: 'Reship with express carrier',
      why: 'Original shipment returned by carrier',
      safetyChecks: ['Check inventory availability', 'Confirm address'],
      changes: ['Create new fulfillment shipment'],
      nonChanges: ['Do not refund credit card'],
      systems: ['Shopify', 'ShipStation'],
      risks: ['Carrier delay during holiday season'],
      recoveryLevel: 'L2',
      caseReference: 'CASE-001',
      orderReference: 'ORD-123',
      expectedVerification: 'Tracking active in 10 mins',
    };

    it('accepts an APPROVAL step without handlerKey and with valid preview', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'VALID_APPROVAL',
          version: 1,
          name: 'Valid Approval',
          steps: [
            {
              key: 'STEP_APPROVAL',
              name: 'Approval Step',
              type: 'APPROVAL',
              preview: validPreview,
            },
          ],
        });
      }).not.toThrow();
    });

    it('accepts an APPROVAL step without preview', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'VALID_APPROVAL_NO_PREVIEW',
          version: 1,
          name: 'Valid Approval No Preview',
          steps: [
            {
              key: 'STEP_APPROVAL',
              name: 'Approval Step',
              type: 'APPROVAL',
            },
          ],
        });
      }).not.toThrow();
    });

    it('rejects an EXECUTION step when handlerKey is missing or empty', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'INVALID_EXECUTION',
          version: 1,
          name: 'Invalid Execution',
          steps: [
            {
              key: 'STEP_1',
              name: 'Step 1',
              type: 'EXECUTION',
            } as any,
          ],
        });
      }).toThrow(/must have a non-empty handlerKey/);

      expect(() => {
        validateWorkflowTemplate({
          key: 'INVALID_EXECUTION_EMPTY',
          version: 1,
          name: 'Invalid Execution Empty',
          steps: [
            {
              key: 'STEP_1',
              name: 'Step 1',
              type: 'EXECUTION',
              handlerKey: '   ',
            },
          ],
        });
      }).toThrow(/must have a non-empty handlerKey/);
    });

    it('rejects an unknown step type', () => {
      expect(() => {
        validateWorkflowTemplate({
          key: 'INVALID_TYPE',
          version: 1,
          name: 'Invalid Type',
          steps: [
            {
              key: 'STEP_1',
              name: 'Step 1',
              type: 'UNKNOWN' as any,
              handlerKey: 'NOOP',
            },
          ],
        });
      }).toThrow(/has invalid type "UNKNOWN"/);
    });

    it('validates RecoveryPreview requires non-null object', () => {
      expect(() => validateRecoveryPreview(null as any)).toThrow(/must be a non-null object/);
      expect(() => validateRecoveryPreview([] as any)).toThrow(/must be a non-null object/);
      expect(() => validateRecoveryPreview('string' as any)).toThrow(/must be a non-null object/);
    });

    it('validates RecoveryPreview version must be 1', () => {
      expect(() => validateRecoveryPreview({ ...validPreview, version: 2 as any })).toThrow(
        /version must be 1/,
      );
    });

    it('validates RecoveryPreview string fields must be non-empty', () => {
      expect(() => validateRecoveryPreview({ ...validPreview, problem: '' })).toThrow(
        /RecoveryPreview "problem" must be a non-empty string/,
      );
      expect(() => validateRecoveryPreview({ ...validPreview, proposedAction: '   ' })).toThrow(
        /RecoveryPreview "proposedAction" must be a non-empty string/,
      );
      expect(() => validateRecoveryPreview({ ...validPreview, why: undefined as any })).toThrow(
        /RecoveryPreview "why" must be a non-empty string/,
      );
    });

    it('validates RecoveryPreview array fields must be string arrays with non-empty items', () => {
      expect(() => validateRecoveryPreview({ ...validPreview, safetyChecks: 'not-an-array' as any })).toThrow(
        /RecoveryPreview "safetyChecks" must be an array of strings/,
      );
      expect(() => validateRecoveryPreview({ ...validPreview, safetyChecks: ['valid', ''] })).toThrow(
        /RecoveryPreview "safetyChecks\[1\]" must be a non-empty string/,
      );
      expect(() => validateRecoveryPreview({ ...validPreview, systems: [123 as any] })).toThrow(
        /RecoveryPreview "systems\[0\]" must be a non-empty string/,
      );
    });

    it('validates RecoveryPreview deep freezes inside registry', () => {
      const template: WorkflowTemplate = {
        key: 'PREVIEW_FREEZE_TEST',
        version: 1,
        name: 'Preview Freeze Test',
        steps: [
          {
            key: 'APPROVAL_STEP',
            name: 'Approval Step',
            type: 'APPROVAL',
            preview: { ...validPreview, safetyChecks: ['Check 1', 'Check 2'] },
          },
        ],
      };

      registry.register(template);
      const retrieved = registry.get('PREVIEW_FREEZE_TEST', 1)!;
      expect(retrieved.steps[0].preview).toBeDefined();
      expect(Object.isFrozen(retrieved.steps[0].preview)).toBe(true);
      expect(Object.isFrozen(retrieved.steps[0].preview?.safetyChecks)).toBe(true);

      // Modifying caller's preview does not affect registry
      (template.steps[0].preview!.safetyChecks as string[]).push('Hacked Check');
      expect(retrieved.steps[0].preview?.safetyChecks).toHaveLength(2);
    });
  });
});
