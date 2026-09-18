import { JobErrorCategory } from '@prisma/client';
import { JobExecutionError } from './errors';

export interface WorkflowStepContext {
  workflowId: string;
  workflowStepId: string;
  stepKey: string;
  templateKey: string;
  templateVersion: number;
  attemptNumber: number;
  payload: unknown;
  organizationId: string;
  workerId: string;
}

export type WorkflowStepHandler = (context: WorkflowStepContext) => Promise<{ output?: Record<string, unknown> | null }>;

export class WorkflowStepHandlerRegistry {
  private handlers = new Map<string, WorkflowStepHandler>();

  constructor() {
    this.registerDefaultHandlers();
  }

  register(handlerKey: string, handler: WorkflowStepHandler): void {
    this.handlers.set(handlerKey, handler);
  }

  has(handlerKey: string): boolean {
    return this.handlers.has(handlerKey);
  }

  async execute(handlerKey: string, context: WorkflowStepContext): Promise<{ output?: Record<string, unknown> | null }> {
    const handler = this.handlers.get(handlerKey);
    if (!handler) {
      throw new Error(`No registered workflow step handler for handlerKey: "${handlerKey}"`);
    }
    return await handler(context);
  }

  private registerDefaultHandlers(): void {
    // NOOP: Simple infrastructure no-op
    this.register('NOOP', async () => {
      return { output: { success: true } };
    });

    // DELAY: Infrastructure delay
    this.register('DELAY', async (context: WorkflowStepContext) => {
      let delayMs = 50;
      if (
        context.payload !== null &&
        typeof context.payload === 'object' &&
        'delayMs' in context.payload &&
        typeof (context.payload as { delayMs: unknown }).delayMs === 'number'
      ) {
        delayMs = (context.payload as { delayMs: number }).delayMs;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { output: { success: true, delayedMs: delayMs } };
    });

    // OUTPUT: Echoes output from payload or emits default success record
    this.register('OUTPUT', async (context: WorkflowStepContext) => {
      let output: Record<string, unknown> = {
        completed: true,
        stepKey: context.stepKey,
        attempt: context.attemptNumber,
      };

      if (context.payload !== null && typeof context.payload === 'object') {
        const payloadObj = context.payload as Record<string, unknown>;
        if (payloadObj.output && typeof payloadObj.output === 'object') {
          output = { ...output, ...(payloadObj.output as Record<string, unknown>) };
        }
      }

      return { output };
    });

    // FAIL_TRANSIENT_ONCE: Fails with retryable error on attempt 1, succeeds on attempt >= 2
    this.register('FAIL_TRANSIENT_ONCE', async (context: WorkflowStepContext) => {
      if (context.attemptNumber === 1) {
        throw new JobExecutionError({
          category: JobErrorCategory.TRANSIENT,
          code: 'SIMULATED_TRANSIENT_ERROR',
          message: `Simulated transient error on attempt ${context.attemptNumber} for step ${context.stepKey}`,
          retryable: true,
        });
      }

      return {
        output: {
          success: true,
          resolvedOnAttempt: context.attemptNumber,
          stepKey: context.stepKey,
        },
      };
    });

    // FAIL_PERMANENT: Fails with non-retryable error
    this.register('FAIL_PERMANENT', async (context: WorkflowStepContext) => {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'SIMULATED_PERMANENT_ERROR',
        message: `Simulated permanent non-retryable error for step ${context.stepKey}`,
        retryable: false,
      });
    });
  }
}
