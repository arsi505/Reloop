import { PrismaClient } from '@prisma/client';
import { JobExecutionError, classifyJobError, sanitizeErrorMessage } from './errors';

export { sanitizeErrorMessage };

export interface ClaimResult {
  claimed: boolean;
  job?: {
    id: string;
    organizationId: string;
    workflowId?: string | null;
    workflowStepId?: string | null;
    type: string;
    payload: unknown;
    attemptCount: number;
    maxAttempts: number;
  };
  attemptId?: string;
  attemptNumber?: number;
}

export interface RecoverClaimedResult {
  recovered: boolean;
  execute: boolean;
  deadLettered?: boolean;
  job?: {
    id: string;
    organizationId: string;
    workflowId?: string | null;
    workflowStepId?: string | null;
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
          workflowId: string | null;
          workflowStepId: string | null;
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
          workflow_id as "workflowId",
          workflow_step_id as "workflowStepId",
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
   * Stores execution result durably into job payload under 'result' key if provided.
   */
  async markJobSucceeded(
    jobId: string,
    attemptId: string,
    workerDbId: string,
    durationMs: number,
    result?: unknown,
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const jobUpdated = result !== undefined
          ? await tx.$executeRaw`
            UPDATE jobs
            SET
              status = 'SUCCEEDED'::"JobStatus",
              payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{result}', ${JSON.stringify(result ?? null)}::jsonb, true),
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
          `
          : await tx.$executeRaw`
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

  /**
   * Recovers a job stuck in CLAIMED whose lease has expired.
   * Atomic, row-locked transaction:
   * - If attempts remain (attemptCount < maxAttempts):
   *     Marks previous attempt as ABANDONED (WORKER_LEASE_EXPIRED_BEFORE_EXECUTION)
   *     Transfers claim to recovering worker with new lease and incremented attemptCount
   *     Creates new JobAttempt in STARTED status
   *     Returns { recovered: true, execute: true, job, attemptId, attemptNumber }
   * - If maxAttempts exhausted:
   *     Marks previous attempt as ABANDONED
   *     Transitions Job to DEAD_LETTERED with completedAt = NOW()
   *     Returns { recovered: true, execute: false, deadLettered: true }
   * - If 0 rows match (lease valid or another worker won):
   *     Returns { recovered: false, execute: false }
   */
  async recoverExpiredClaimedJob(
    jobId: string,
    workerDbId: string,
    leaseDurationMs: number,
  ): Promise<RecoverClaimedResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Lock and inspect eligible expired CLAIMED job
        const lockedRows = await tx.$queryRaw<
          Array<{
            id: string;
            organizationId: string;
            workflowId: string | null;
            workflowStepId: string | null;
            type: string;
            payload: unknown;
            attemptCount: number;
            maxAttempts: number;
          }>
        >`
          SELECT
            id,
            organization_id as "organizationId",
            workflow_id as "workflowId",
            workflow_step_id as "workflowStepId",
            type,
            payload,
            attempt_count as "attemptCount",
            max_attempts as "maxAttempts"
          FROM jobs
          WHERE
            id = ${jobId}::uuid
            AND status = 'CLAIMED'::"JobStatus"
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= NOW()
          FOR UPDATE
        `;

        if (!lockedRows || lockedRows.length === 0) {
          return { recovered: false, execute: false };
        }

        const currentJob = lockedRows[0];
        const previousAttemptNumber = currentJob.attemptCount;

        // 2. Mark previous attempt as ABANDONED
        await tx.$executeRaw`
          UPDATE job_attempts
          SET
            status = 'ABANDONED'::"JobAttemptStatus",
            finished_at = NOW(),
            duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int),
            error_category = 'UNKNOWN'::"JobErrorCategory",
            error_code = 'WORKER_LEASE_EXPIRED_BEFORE_EXECUTION',
            error_message = 'Worker lease expired before handler execution began'
          WHERE
            job_id = ${jobId}::uuid
            AND attempt_number = ${previousAttemptNumber}
            AND status = 'STARTED'::"JobAttemptStatus"
        `;

        // 3. Check if attempts remain
        if (currentJob.attemptCount < currentJob.maxAttempts) {
          const newAttemptCount = currentJob.attemptCount + 1;

          const updatedRows = await tx.$queryRaw<
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
              attempt_count = ${newAttemptCount},
              next_run_at = NULL,
              completed_at = NULL,
              updated_at = NOW()
            WHERE
              id = ${jobId}::uuid
            RETURNING
              id,
              organization_id as "organizationId",
              type,
              payload,
              attempt_count as "attemptCount",
              max_attempts as "maxAttempts"
          `;

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
              ${jobId}::uuid,
              ${workerDbId}::uuid,
              ${newAttemptCount},
              'STARTED'::"JobAttemptStatus",
              NOW(),
              NOW()
            )
            RETURNING id
          `;

          return {
            recovered: true,
            execute: true,
            job: updatedRows[0],
            attemptId: attemptRows[0].id,
            attemptNumber: newAttemptCount,
          };
        } else {
          // Max attempts exhausted: transition to DEAD_LETTERED
          await tx.$executeRaw`
            UPDATE jobs
            SET
              status = 'DEAD_LETTERED'::"JobStatus",
              claimed_by_worker_id = NULL,
              lease_expires_at = NULL,
              next_run_at = NULL,
              completed_at = NOW(),
              updated_at = NOW()
            WHERE
              id = ${jobId}::uuid
          `;

          return {
            recovered: true,
            execute: false,
            deadLettered: true,
          };
        }
      });
    } catch {
      return { recovered: false, execute: false };
    }
  }

  /**
   * Recovers a job stuck in RUNNING whose lease has expired.
   * Because execution began, the outcome is ambiguous (e.g. external mutation may have succeeded).
   * It is NEVER blindly re-executed.
   *
   * In a single row-locked transaction:
   * - Marks current attempt as ABANDONED with error code AMBIGUOUS_WORKER_CRASH
   * - Transitions Job to BLOCKED with completedAt = NULL
   * - Returns true if recovered, false if race lost or lease valid
   */
  async recoverExpiredRunningJob(jobId: string): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const lockedRows = await tx.$queryRaw<Array<{ id: string; attemptCount: number }>>`
          SELECT
            id,
            attempt_count as "attemptCount"
          FROM jobs
          WHERE
            id = ${jobId}::uuid
            AND status = 'RUNNING'::"JobStatus"
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= NOW()
          FOR UPDATE
        `;

        if (!lockedRows || lockedRows.length === 0) {
          return false;
        }

        const job = lockedRows[0];

        // 1. Mark current attempt as ABANDONED
        await tx.$executeRaw`
          UPDATE job_attempts
          SET
            status = 'ABANDONED'::"JobAttemptStatus",
            finished_at = NOW(),
            duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int),
            error_category = 'UNKNOWN'::"JobErrorCategory",
            error_code = 'AMBIGUOUS_WORKER_CRASH',
            error_message = 'Worker crashed while executing job handler; ambiguous state requires external verification'
          WHERE
            job_id = ${jobId}::uuid
            AND attempt_number = ${job.attemptCount}
            AND status = 'STARTED'::"JobAttemptStatus"
        `;

        // 2. Transition Job to BLOCKED (completedAt stays null)
        await tx.$executeRaw`
          UPDATE jobs
          SET
            status = 'BLOCKED'::"JobStatus",
            claimed_by_worker_id = NULL,
            lease_expires_at = NULL,
            next_run_at = NULL,
            completed_at = NULL,
            updated_at = NOW()
          WHERE
            id = ${jobId}::uuid
        `;

        return true;
      });
    } catch {
      return false;
    }
  }
}