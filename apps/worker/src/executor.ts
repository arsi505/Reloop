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
  }
}