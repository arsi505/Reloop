import { JobExecutionError } from './errors';

export interface RetryPolicyOptions {
  delaysMs?: number[];
  jitterPercent?: number;
  randomFn?: () => number;
}

export class RetryPolicy {
  readonly delaysMs: number[];
  readonly jitterPercent: number;
  private readonly randomFn: () => number;

  constructor(options: RetryPolicyOptions = {}) {
    this.delaysMs = options.delaysMs ?? [30000, 120000, 600000, 1800000];
    this.jitterPercent = options.jitterPercent ?? 15;
    this.randomFn = options.randomFn ?? Math.random;

    if (!Array.isArray(this.delaysMs) || this.delaysMs.length === 0) {
      throw new Error('RetryPolicy requires at least one delay in delaysMs');
    }
    for (const d of this.delaysMs) {
      if (!Number.isFinite(d) || d <= 0) {
        throw new Error(`Invalid retry delay: ${d}. Delays must be positive numbers.`);
      }
    }
    if (!Number.isFinite(this.jitterPercent) || this.jitterPercent < 0 || this.jitterPercent > 100) {
      throw new Error(`Invalid jitter percent: ${this.jitterPercent}. Must be between 0 and 100.`);
    }
  }

  /**
   * Evaluates if an error should trigger a retry attempt.
   * Both error.retryable must be true AND total physical attempts (attemptNumber) must be strictly less than maxAttempts.
   */
  shouldRetry(error: JobExecutionError, attemptNumber: number, maxAttempts: number): boolean {
    if (!error.retryable) {
      return false;
    }
    return attemptNumber < maxAttempts;
  }

  /**
   * Computes the backoff delay in milliseconds for a given attempt.
   *
   * attemptNumber: 1-indexed attempt number that just completed.
   * e.g., after attempt 1 fails -> uses delaysMs[0] (30s).
   * after attempt 2 fails -> uses delaysMs[1] (2m).
   * after attempt 3 fails -> uses delaysMs[2] (10m).
   * after attempt 4+ fails -> uses delaysMs[3] (30m cap).
   *
   * Applies bounded jitter: +/- jitterPercent (default +/- 15%).
   * If retryAfterMs is specified, effective delay is max(jitteredDelay, retryAfterMs).
   * Delay is guaranteed to be strictly positive (> 0).
   */
  calculateDelay(attemptNumber: number, retryAfterMs?: number): number {
    const index = Math.max(0, Math.min(attemptNumber - 1, this.delaysMs.length - 1));
    const baseDelay = this.delaysMs[index];

    // Jitter range: [-jitterPercent, +jitterPercent]
    const rand = this.randomFn();
    const jitterFactor = (rand * 2 - 1) * (this.jitterPercent / 100);
    let delay = Math.round(baseDelay * (1 + jitterFactor));

    // Delay must always stay positive
    if (delay <= 0) {
      delay = 1;
    }

    // Rate-limit precedence: never schedule earlier than provider Retry-After
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      delay = Math.max(delay, Math.round(retryAfterMs));
    }

    return delay;
  }

  /**
   * Calculates nextRunAt timestamp using calculateDelay.
   */
  calculateNextRunAt(attemptNumber: number, retryAfterMs?: number, fromDate: Date = new Date()): Date {
    const delayMs = this.calculateDelay(attemptNumber, retryAfterMs);
    return new Date(fromDate.getTime() + delayMs);
  }
}
