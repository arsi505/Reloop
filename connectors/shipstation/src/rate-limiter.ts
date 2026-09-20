export interface ShipStationRateLimiterOptions {
  /** Maximum number of concurrent in-flight requests. Default: 5 */
  maxConcurrency?: number;
  /** Minimum delay in milliseconds between dispatched requests. Default: 20ms */
  minIntervalMs?: number;
}

/**
 * Shared provider-wide request budget and rate coordinator for ShipStation V2.
 *
 * Guarantees:
 * - Bounded request concurrency (prevents socket / connection flooding)
 * - Paced dispatch intervals
 * - Centralized 429 Retry-After handling: pauses all queued and incoming requests across callers
 * - Thundering-herd prevention: smoothly drains queue once backoff expires
 */
export class ShipStationRateLimiter {
  private static defaultInstance: ShipStationRateLimiter | null = null;

  /**
   * Returns the process-wide shared default rate limiter instance.
   */
  public static getDefault(): ShipStationRateLimiter {
    if (!ShipStationRateLimiter.defaultInstance) {
      ShipStationRateLimiter.defaultInstance = new ShipStationRateLimiter();
    }
    return ShipStationRateLimiter.defaultInstance;
  }

  /**
   * Resets the default shared instance (primarily for testing).
   */
  public static resetDefault(): void {
    ShipStationRateLimiter.defaultInstance = null;
  }

  private readonly maxConcurrency: number;
  private readonly minIntervalMs: number;
  private activeCount = 0;
  private lastDispatchTime = 0;
  private blockedUntil = 0;
  private readonly waitQueue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(options: ShipStationRateLimiterOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 5;
    this.minIntervalMs = options.minIntervalMs ?? 20;
  }

  /**
   * Records a 429 Rate Limit event with the specified Retry-After duration in seconds.
   * Extends blockedUntil to guarantee no subsequent requests are dispatched before then.
   */
  recordRateLimit(retryAfterSeconds: number): void {
    const durationMs = Math.max(1, retryAfterSeconds) * 1000;
    const until = Date.now() + durationMs;
    if (until > this.blockedUntil) {
      this.blockedUntil = until;
    }
  }

  /**
   * Checks whether the rate limiter is currently paused due to a 429 response.
   */
  isBlocked(): boolean {
    return Date.now() < this.blockedUntil;
  }

  /**
   * Returns remaining milliseconds of active 429 backoff delay.
   */
  getRemainingBlockMs(): number {
    return Math.max(0, this.blockedUntil - Date.now());
  }

  /**
   * Returns number of requests currently in flight.
   */
  getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * Returns number of callers currently waiting in queue.
   */
  getQueueLength(): number {
    return this.waitQueue.length;
  }

  /**
   * Acquires a dispatch slot, respecting concurrency limits, 429 backoff, and dispatch pacing.
   */
  private async acquireSlot(): Promise<void> {
    // If at concurrency limit or callers are already queued, wait in line
    if (this.activeCount >= this.maxConcurrency || this.waitQueue.length > 0) {
      await new Promise<void>((resolve, reject) => {
        this.waitQueue.push({ resolve, reject });
      });
    }

    // If 429 block is active, wait until it expires before dispatching
    while (this.isBlocked()) {
      const delay = this.getRemainingBlockMs();
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Enforce minimum interval spacing between consecutive dispatches
    const now = Date.now();
    const elapsed = now - this.lastDispatchTime;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }

    this.lastDispatchTime = Date.now();
    this.activeCount++;
  }

  /**
   * Releases an active slot and dequeues the next waiting caller.
   */
  private releaseSlot(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) {
        next.resolve();
      }
    }
  }

  /**
   * Executes a provider HTTP operation through the shared rate coordinator.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }
}
