import { PrismaClient } from '@prisma/client';
import { SchedulerConfig } from './config';
import { JobScanner } from './job-scanner';
import { RedisPublisher } from './redis-publisher';

export interface SchedulerMetrics {
  scannedCount: number;
  publishedCount: number;
  suppressedCount: number;
  errorCount: number;
  lastTickDurationMs: number;
  lastTickAt: Date | null;
}

export interface TickResult {
  scanned: number;
  published: number;
  suppressed: number;
  durationMs: number;
  errors: number;
}

export class SchedulerService {
  private config: SchedulerConfig;
  private prisma: PrismaClient;
  private publisher: RedisPublisher;
  private scanner: JobScanner;

  private isRunning: boolean = false;
  private isTickRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  private metrics: SchedulerMetrics = {
    scannedCount: 0,
    publishedCount: 0,
    suppressedCount: 0,
    errorCount: 0,
    lastTickDurationMs: 0,
    lastTickAt: null,
  };

  constructor(
    config: SchedulerConfig,
    prisma: PrismaClient,
    publisher: RedisPublisher,
  ) {
    this.config = config;
    this.prisma = prisma;
    this.publisher = publisher;
    this.scanner = new JobScanner(prisma, config);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    await this.publisher.connect();
    await this.publisher.ensureConsumerGroup();
    this.isRunning = true;

    console.log(`[Reloop Scheduler] Service started with interval ${this.config.schedulerIntervalMs}ms, batch size ${this.config.schedulerBatchSize}, marker TTL ${this.config.dispatchMarkerTtlMs}ms`);

    // Run first tick immediately, then schedule subsequent ticks
    this.scheduleNextTick(0);
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.isRunning) return;

    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        console.error('[Reloop Scheduler] Unhandled error during tick:', err);
      } finally {
        if (this.isRunning) {
          this.scheduleNextTick(this.config.schedulerIntervalMs);
        }
      }
    }, delayMs);
  }

  /**
   * Execute a single scan and dispatch pass.
   * Ensures non-overlapping execution via `isTickRunning`.
   */
  async tick(): Promise<TickResult> {
    if (this.isTickRunning) {
      console.warn('[Reloop Scheduler] Previous tick still in progress; skipping tick.');
      return { scanned: 0, published: 0, suppressed: 0, durationMs: 0, errors: 0 };
    }

    this.isTickRunning = true;
    const startTime = Date.now();
    let scanned = 0;
    let published = 0;
    let suppressed = 0;
    let errors = 0;
    let durationMs = 0;

    try {
      const eligibleJobs = await this.scanner.scanEligibleJobs();
      scanned = eligibleJobs.length;

      for (const job of eligibleJobs) {
        try {
          // Redis Lua script atomically sets dispatch marker and XADDs to stream if not marked
          const wasPublished = await this.publisher.publishJob(job.id);
          if (wasPublished) {
            published++;
          } else {
            suppressed++;
          }
        } catch (jobErr) {
          errors++;
          console.error(`[Reloop Scheduler] Error publishing job ${job.id}:`, jobErr);
        }
      }
    } catch (tickErr) {
      errors++;
      console.error('[Reloop Scheduler] Error scanning eligible jobs:', tickErr);
    } finally {
      durationMs = Date.now() - startTime;
      this.isTickRunning = false;

      this.metrics.scannedCount += scanned;
      this.metrics.publishedCount += published;
      this.metrics.suppressedCount += suppressed;
      this.metrics.errorCount += errors;
      this.metrics.lastTickDurationMs = durationMs;
      this.metrics.lastTickAt = new Date();

      if (scanned > 0 || errors > 0) {
        console.log(
          `[Reloop Scheduler] Tick completed in ${durationMs}ms: scanned=${scanned}, published=${published}, suppressed=${suppressed}, errors=${errors}`,
        );
      }
    }

    return { scanned, published, suppressed, durationMs, errors };
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Wait if a tick is currently running
    const maxWaitMs = 5000;
    const pollIntervalMs = 50;
    let waited = 0;
    while (this.isTickRunning && waited < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      waited += pollIntervalMs;
    }

    await this.publisher.close();
    console.log('[Reloop Scheduler] Service stopped cleanly.');
  }

  getMetrics(): SchedulerMetrics {
    return { ...this.metrics };
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }
}