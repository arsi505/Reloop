import { PrismaClient } from '@prisma/client';
import { JobExecutionError, classifyJobError, sanitizeErrorMessage } from './errors';

export { sanitizeErrorMessage };

export interface ClaimResult {
  claimed: boolean;
  job?: {
    id: string;
    organizationId: string;
    type: string;
    payload: unknown;
    attemptCount: number;
    maxAttempts: number;
  };
  attemptId?: string;
  attemptNumber?: number;
}

export class JobClaimService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Atomically claims an eligible job in PostgreSQL and creates the JobAttempt
   * in a single interactive transaction.
   *
   * Multiple workers can race for the same job; exactly one will update 1 row.
   * Losing workers update 0 rows and return { claimed: false }.
   */
  async atomicClaimJob(
    jobId: string,
    workerDbId: string,
    leaseDurationMs: number,
  ): Promise<ClaimResult> {
    return await this.prisma.$transaction(async (tx) => {
      // 1. Conditional Atomic Claim
      const claimedRows = await tx.$queryRaw<
        Array<{
          id: string;
          organizationId: string;
          type: string;
          payload: unknown;
          attemptCount: number;
          maxAttempts: number;
        }>
      >`
        UPDATE jobs
        SET
          status = 'CLAIMED'::"JobStatus",
          claimed_by_worker_id = ${workerDbId}::uuid,
          lease_expires_at = NOW() + (${leaseDurationMs.toString()} || ' milliseconds')::interval,
          attempt_count = attempt_count + 1,
          updated_at = NOW()
        WHERE
          id = ${jobId}::uuid
          AND status IN ('QUEUED'::"JobStatus", 'RETRY_WAITING'::"JobStatus")
          AND (next_run_at IS NULL OR next_run_at <= NOW())
        RETURNING
          id,
          organization_id as "organizationId",
          type,
          payload,
          attempt_count as "attemptCount",
          max_attempts as "maxAttempts"
      `;

      if (!claimedRows || claimedRows.length === 0) {
        return { claimed: false };
      }

      const job = claimedRows[0];

      // 2. Create JobAttempt in the same transaction
      const attemptRows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO job_attempts (
          id,
          job_id,
          worker_id,
          attempt_number,
          status,
          started_at,
          created_at
        )
        VALUES (
          gen_random_uuid(),
          ${job.id}::uuid,
          ${workerDbId}::uuid,
          ${job.attemptCount},
          'STARTED'::"JobAttemptStatus",
          NOW(),
          NOW()
        )
        RETURNING id
      `;

      return {
        claimed: true,
        job,
        attemptId: attemptRows[0].id,
        attemptNumber: job.attemptCount,
      };
    });
  }

  /**
   * Transition CLAIMED -> RUNNING before handler execution.
   * Verifies worker ownership and active unexpired lease.
   */
  async transitionToRunning(jobId: string, workerDbId: string): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE jobs
      SET
        status = 'RUNNING'::"JobStatus",
        updated_at = NOW()
      WHERE
        id = ${jobId}::uuid
        AND claimed_by_worker_id = ${workerDbId}::uuid
        AND status = 'CLAIMED'::"JobStatus"
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > NOW()
    `;

    return updated === 1;
  }

  /**
   * Renews job lease while job is executing.
   * Verifies worker ownership, valid status, and unexpired lease (cannot revive expired lease).
   */
  async renewLease(
    jobId: string,
    workerDbId: string,
    leaseDurationMs: number,
  ): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE jobs
      SET
        lease_expires_at = NOW() + (${leaseDurationMs.toString()} || ' milliseconds')::interval,
        updated_at = NOW()
      WHERE
        id = ${jobId}::uuid
        AND claimed_by_worker_id = ${workerDbId}::uuid
        AND status IN ('CLAIMED'::"JobStatus", 'RUNNING'::"JobStatus")
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > NOW()
    `;

    return updated === 1;
  }

  /**
   * Marks Job and JobAttempt as SUCCEEDED in a single transaction.
   * Verifies worker ownership and unexpired lease.
   */
  async markJobSucceeded(
    jobId: string,
    attemptId: string,
    workerDbId: string,
    durationMs: number,
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const jobUpdated = await tx.$executeRaw`
          UPDATE jobs
          SET
            status = 'SUCCEEDED'::"JobStatus",
            completed_at = NOW(),
            lease_expires_at = NULL,
            claimed_by_worker_id = NULL,
            updated_at = NOW()
          WHERE
            id = ${jobId}::uuid
            AND claimed_by_worker_id = ${workerDbId}::uuid
            AND status = 'RUNNING'::"JobStatus"
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > NOW()
        `;

        if (jobUpdated === 0) {
          throw new Error(`Ownership fence failed: Job ${jobId} not in RUNNING or lease expired`);
        }

        const attemptUpdated = await tx.$executeRaw`
          UPDATE job_attempts
          SET
            status = 'SUCCEEDED'::"JobAttemptStatus",
            finished_at = NOW(),
            duration_ms = ${durationMs}
          WHERE
            id = ${attemptId}::uuid
        `;

        if (attemptUpdated === 0) {
          throw new Error(`JobAttempt ${attemptId} not found`);
        }

        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * Marks Job as RETRY_WAITING and current JobAttempt as FAILED in a single transaction.
   * Fenced with ownership and active lease check.
   * If fenced Job update affects 0 rows, throws inside transaction to guarantee complete rollback.
   */
  async markJobRetryWaiting(
    jobId: string,
    attemptId: string,
    workerDbId: string,
    durationMs: number,
    error: JobExecutionError,
    nextRunAt: Date,
  ): Promise<boolean> {
    const sanitizedMessage = sanitizeErrorMessage(error.message);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const jobUpdated = await tx.$executeRaw`
          UPDATE jobs
          SET
            status = 'RETRY_WAITING'::"JobStatus",
            next_run_at = ${nextRunAt}::timestamptz,
            claimed_by_worker_id = NULL,
            lease_expires_at = NULL,
            completed_at = NULL,
            updated_at = NOW()
          WHERE
            id = ${jobId}::uuid
            AND claimed_by_worker_id = ${workerDbId}::uuid
            AND status = 'RUNNING'::"JobStatus"
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > NOW()
        `;

        if (jobUpdated === 0) {
          throw new Error(`Ownership fence failed: Job ${jobId} not in RUNNING or lease expired`);
        }

        const attemptUpdated = await tx.$executeRaw`
          UPDATE job_attempts
          SET
            status = 'FAILED'::"JobAttemptStatus",
            finished_at = NOW(),
            duration_ms = ${durationMs},
            error_category = ${error.category}::"JobErrorCategory",
            error_code = ${error.code},
            error_message = ${sanitizedMessage}
          WHERE
            id = ${attemptId}::uuid
        `;

        if (attemptUpdated === 0) {
          throw new Error(`JobAttempt ${attemptId} not found`);
        }

        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * Marks Job as DEAD_LETTERED and current JobAttempt as FAILED when max attempts are exhausted.
   * Fenced with ownership and active lease check.
   * If fenced Job update affects 0 rows, throws inside transaction to guarantee complete rollback.
   */
  async markJobDeadLettered(
    jobId: string,
    attemptId: string,
    workerDbId: string,
    durationMs: number,
    error: JobExecutionError,
  ): Promise<boolean> {
    const sanitizedMessage = sanitizeErrorMessage(error.message);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const jobUpdated = await tx.$executeRaw`
          UPDATE jobs
          SET
            status = 'DEAD_LETTERED'::"JobStatus",
            next_run_at = NULL,
            claimed_by_worker_id = NULL,
            lease_expires_at = NULL,
            completed_at = NOW(),
            updated_at = NOW()
          WHERE
            id = ${jobId}::uuid
            AND claimed_by_worker_id = ${workerDbId}::uuid
            AND status = 'RUNNING'::"JobStatus"
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > NOW()
        `;

        if (jobUpdated === 0) {
          throw new Error(`Ownership fence failed: Job ${jobId} not in RUNNING or lease expired`);
        }

        const attemptUpdated = await tx.$executeRaw`
          UPDATE job_attempts
          SET
            status = 'FAILED'::"JobAttemptStatus",
            finished_at = NOW(),
            duration_ms = ${durationMs},
            error_category = ${error.category}::"JobErrorCategory",
            error_code = ${error.code},
            error_message = ${sanitizedMessage}
          WHERE
            id = ${attemptId}::uuid
        `;

        if (attemptUpdated === 0) {
          throw new Error(`JobAttempt ${attemptId} not found`);
        }

        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * Marks Job and JobAttempt as FAILED for non-retryable/permanent failure.
   * Fenced with ownership and active lease check.
   * If fenced Job update affects 0 rows, throws inside transaction to guarantee complete rollback.
   */
  async markJobFailed(
    jobId: string,
    attemptId: string,
    workerDbId: string,
    durationMs: number,
    error: unknown,
  ): Promise<boolean> {
    const classified = error instanceof JobExecutionError ? error : classifyJobError(error);
    const sanitizedMessage = sanitizeErrorMessage(classified.message);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const jobUpdated = await tx.$executeRaw`
          UPDATE jobs
          SET
            status = 'FAILED'::"JobStatus",
            next_run_at = NULL,
            claimed_by_worker_id = NULL,
            lease_expires_at = NULL,
            completed_at = NOW(),
            updated_at = NOW()
          WHERE
            id = ${jobId}::uuid
            AND claimed_by_worker_id = ${workerDbId}::uuid
            AND status = 'RUNNING'::"JobStatus"
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > NOW()
        `;

        if (jobUpdated === 0) {
          throw new Error(`Ownership fence failed: Job ${jobId} not in RUNNING or lease expired`);
        }

        const attemptUpdated = await tx.$executeRaw`
          UPDATE job_attempts
          SET
            status = 'FAILED'::"JobAttemptStatus",
            finished_at = NOW(),
            duration_ms = ${durationMs},
            error_category = ${classified.category}::"JobErrorCategory",
            error_code = ${classified.code},
            error_message = ${sanitizedMessage}
          WHERE
            id = ${attemptId}::uuid
        `;

        if (attemptUpdated === 0) {
          throw new Error(`JobAttempt ${attemptId} not found`);
        }

        return true;
      });
    } catch {
      return false;
    }
  }
}