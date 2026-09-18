import { JobErrorCategory } from '@prisma/client';
import { JobExecutionError } from './errors';

export interface JobContext {
  jobId: string;
  attemptNumber: number;
  type: string;
  payload: unknown;
  workerId: string;
  organizationId: string;
}

export type JobHandler = (context: JobContext) => Promise<unknown>;

export class JobExecutorRegistry {
  private handlers = new Map<string, JobHandler>();

  constructor() {
    this.registerDefaultHandlers();
  }

  register(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  has(jobType: string): boolean {
    return this.handlers.has(jobType);
  }

  async execute(jobType: string, context: JobContext): Promise<unknown> {
    const handler = this.handlers.get(jobType);
    if (!handler) {
      throw new Error(`No registered handler for job type: "${jobType}"`);
    }

    return await handler(context);
  }

  private registerDefaultHandlers(): void {
    // SYSTEM_NOOP: Development/infrastructure no-op handler
    this.register('SYSTEM_NOOP', async (_context: JobContext) => {
      return { success: true, executedAt: new Date().toISOString() };
    });

    // SYSTEM_DELAY: Development/infrastructure concurrency and lease delay handler
    this.register('SYSTEM_DELAY', async (context: JobContext) => {
      let delayMs = 1000;
      if (
        context.payload !== null &&
        typeof context.payload === 'object' &&
        'delayMs' in context.payload &&
        typeof (context.payload as { delayMs: unknown }).delayMs === 'number'
      ) {
        const parsed = (context.payload as { delayMs: number }).delayMs;
        // Bounded between 0 and 60,000ms for safety
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 60000) {
          delayMs = parsed;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { success: true, delayedMs: delayMs };
    });

    // SYSTEM_FAIL_TRANSIENT: Development/infrastructure transient error simulation
    this.register('SYSTEM_FAIL_TRANSIENT', async (_context: JobContext) => {
      throw new JobExecutionError({
        category: JobErrorCategory.TRANSIENT,
        code: 'NETWORK_TIMEOUT',
        message: 'Transient simulation network error',
        retryable: true,
      });
    });

    // SYSTEM_FAIL_RATE_LIMITED: Development/infrastructure rate limit simulation
    this.register('SYSTEM_FAIL_RATE_LIMITED', async (context: JobContext) => {
      let retryAfterMs = 500;
      if (
        context.payload !== null &&
        typeof context.payload === 'object' &&
        'retryAfterMs' in context.payload &&
        typeof (context.payload as { retryAfterMs: unknown }).retryAfterMs === 'number'
      ) {
        const parsed = (context.payload as { retryAfterMs: number }).retryAfterMs;
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 3600000) {
          retryAfterMs = parsed;
        }
      }
      throw new JobExecutionError({
        category: JobErrorCategory.RATE_LIMITED,
        code: 'RATE_LIMITED_429',
        message: 'Provider rate limit encountered',
        retryable: true,
        retryAfterMs,
      });
    });

    // SYSTEM_FAIL_PERMANENT: Development/infrastructure permanent error simulation
    this.register('SYSTEM_FAIL_PERMANENT', async (_context: JobContext) => {
      throw new JobExecutionError({
        category: JobErrorCategory.BUSINESS_ERROR,
        code: 'INVALID_DATA',
        message: 'Permanent validation failure in business payload',
        retryable: false,
      });
    });
  }
}