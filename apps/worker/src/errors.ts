import { JobErrorCategory } from '@prisma/client';

export interface JobExecutionErrorOptions {
  message: string;
  category: JobErrorCategory;
  code: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

/**
 * Sanitizes and redacts sensitive credentials, tokens, and secrets from error strings.
 * Caps string length to 500 characters.
 */
export function sanitizeErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error occurred during job execution';
  const rawMsg = err instanceof Error ? err.message : String(err);

  return rawMsg
    .replace(/(password|passwd|secret|token|bearer|key)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/postgresql:\/\/[^@]+@/gi, 'postgresql://[REDACTED]@')
    .replace(/redis:\/\/[^@]+@/gi, 'redis://[REDACTED]@')
    .slice(0, 500);
}

/**
 * Safe internal structured error class for job handlers.
 */
export class JobExecutionError extends Error {
  readonly category: JobErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    messageOrOptions: string | JobExecutionErrorOptions,
    category?: JobErrorCategory,
    code?: string,
    retryAfterMs?: number,
    retryable?: boolean,
  ) {
    const opts: JobExecutionErrorOptions =
      typeof messageOrOptions === 'string'
        ? {
            message: messageOrOptions,
            category: category ?? JobErrorCategory.UNKNOWN,
            code: code ?? 'UNKNOWN_ERROR',
            retryAfterMs,
            retryable,
          }
        : messageOrOptions;

    super(sanitizeErrorMessage(opts.message));
    this.name = 'JobExecutionError';
    this.category = opts.category;
    this.code = opts.code;
    this.retryAfterMs = opts.retryAfterMs;

    // Default retryability: TRANSIENT and RATE_LIMITED are retryable by default.
    // All other categories (BUSINESS_ERROR, AUTH_ERROR, NOT_FOUND, DUPLICATE, UNKNOWN) are false by default.
    if (opts.retryable !== undefined) {
      this.retryable = opts.retryable;
    } else {
      this.retryable = (
        opts.category === JobErrorCategory.TRANSIENT ||
        opts.category === JobErrorCategory.RATE_LIMITED
      );
    }
  }
}

/**
 * Classifies an unknown error caught from a job handler.
 * If already a JobExecutionError, preserves its classification.
 * Unrecognized errors default to UNKNOWN / UNEXPECTED_HANDLER_ERROR with retryable = false.
 * UNKNOWN failures must NOT be blindly retried.
 */
export function classifyJobError(err: unknown): JobExecutionError {
  if (err instanceof JobExecutionError) {
    return err;
  }

  const sanitized = sanitizeErrorMessage(err);
  return new JobExecutionError({
    message: sanitized,
    category: JobErrorCategory.UNKNOWN,
    code: 'UNEXPECTED_HANDLER_ERROR',
    retryable: false,
  });
}
