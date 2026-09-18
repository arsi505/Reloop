import { RetryPolicy } from '../src/retry-policy';
import { JobExecutionError } from '../src/errors';
import { JobErrorCategory } from '@prisma/client';

describe('RetryPolicy', () => {
  it('1. calculates exact base delays without jitter when random is 0.5', () => {
    const policy = new RetryPolicy({
      delaysMs: [30000, 120000, 600000, 1800000],
      jitterPercent: 15,
      randomFn: () => 0.5, // 0 jitter
    });

    expect(policy.calculateDelay(1)).toBe(30000);   // Attempt 1: 30s
    expect(policy.calculateDelay(2)).toBe(120000);  // Attempt 2: 2m
    expect(policy.calculateDelay(3)).toBe(600000);  // Attempt 3: 10m
    expect(policy.calculateDelay(4)).toBe(1800000); // Attempt 4: 30m cap
    expect(policy.calculateDelay(5)).toBe(1800000); // Attempt 5+: 30m cap
  });

  it('2. bounds jitter strictly between -15% and +15%', () => {
    // Min jitter (random = 0.0) -> -15%
    const minPolicy = new RetryPolicy({
      delaysMs: [30000, 120000, 600000, 1800000],
      jitterPercent: 15,
      randomFn: () => 0.0,
    });
    expect(minPolicy.calculateDelay(1)).toBe(25500); // 30000 * 0.85 = 25500
    expect(minPolicy.calculateDelay(2)).toBe(102000); // 120000 * 0.85 = 102000

    // Max jitter (random = 1.0) -> +15%
    const maxPolicy = new RetryPolicy({
      delaysMs: [30000, 120000, 600000, 1800000],
      jitterPercent: 15,
      randomFn: () => 1.0,
    });
    expect(maxPolicy.calculateDelay(1)).toBe(34500); // 30000 * 1.15 = 34500
    expect(maxPolicy.calculateDelay(2)).toBe(138000); // 120000 * 1.15 = 138000
  });

  it('3. respects provider Retry-After and never schedules earlier than retryAfterMs', () => {
    // Normal delay is 100ms with 0 jitter
    const policy = new RetryPolicy({
      delaysMs: [100],
      jitterPercent: 15,
      randomFn: () => 0.5,
    });

    // When retryAfterMs (500ms) > normal delay (100ms), returns 500ms
    expect(policy.calculateDelay(1, 500)).toBe(500);

    // When retryAfterMs (50ms) < normal delay (100ms), returns normal delay (100ms)
    expect(policy.calculateDelay(1, 50)).toBe(100);

    // Even with negative jitter, delay never drops below retryAfterMs
    const negJitterPolicy = new RetryPolicy({
      delaysMs: [100],
      jitterPercent: 15,
      randomFn: () => 0.0, // 85ms
    });
    expect(negJitterPolicy.calculateDelay(1, 90)).toBe(90);
  });

  it('4. guarantees delay is always strictly positive', () => {
    const policy = new RetryPolicy({
      delaysMs: [1],
      jitterPercent: 100,
      randomFn: () => 0.0, // -100% would be 0
    });

    expect(policy.calculateDelay(1)).toBeGreaterThan(0);
  });

  it('5. correctly evaluates shouldRetry based on error retryability and attempt bounds', () => {
    const policy = new RetryPolicy();

    const transientError = new JobExecutionError({
      category: JobErrorCategory.TRANSIENT,
      code: 'NETWORK_TIMEOUT',
      message: 'Connection dropped',
    });
    expect(transientError.retryable).toBe(true);

    const businessError = new JobExecutionError({
      category: JobErrorCategory.BUSINESS_ERROR,
      code: 'INVALID_ORDER',
      message: 'Order not valid',
    });
    expect(businessError.retryable).toBe(false);

    // Max attempts = 3
    // Attempt 1: retryable error can retry
    expect(policy.shouldRetry(transientError, 1, 3)).toBe(true);
    // Attempt 2: retryable error can retry
    expect(policy.shouldRetry(transientError, 2, 3)).toBe(true);
    // Attempt 3: exhausted (attempt 3 >= maxAttempts 3)
    expect(policy.shouldRetry(transientError, 3, 3)).toBe(false);

    // Non-retryable error cannot retry even on attempt 1
    expect(policy.shouldRetry(businessError, 1, 3)).toBe(false);
  });

  it('6. validates configuration options', () => {
    expect(() => new RetryPolicy({ delaysMs: [] })).toThrow(/at least one delay/);
    expect(() => new RetryPolicy({ delaysMs: [-10] })).toThrow(/Delays must be positive/);
    expect(() => new RetryPolicy({ jitterPercent: -5 })).toThrow(/Invalid jitter percent/);
    expect(() => new RetryPolicy({ jitterPercent: 120 })).toThrow(/Invalid jitter percent/);
  });
});
