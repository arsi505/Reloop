import Redis from 'ioredis';
import { PrismaClient, JobStatus } from '@prisma/client';
import { WorkerConfig } from './config';
import { JobClaimService } from './job-claim';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StaleMessageRecoveryOptions {
  config: WorkerConfig;
  prisma: PrismaClient;
  commandRedis: Redis;
  claimService: JobClaimService;
  getWorkerDbId: () => string;
  getAvailableConcurrencySlots: () => number;
  reserveSlot?: () => boolean;
  releaseSlot?: () => void;
  isDraining?: () => boolean;
  onExecuteClaimedJob: (
    job: {
      id: string;
      organizationId: string;
      type: string;
      payload: unknown;
      attemptCount: number;
      maxAttempts: number;
    },
    attemptId: string,
    attemptNumber: number,
    msgId: string,
  ) => Promise<void>;
  onExecuteQueuedJob: (msgId: string, fields: string[]) => Promise<void>;
}

export class StaleMessageRecoveryService {
  private config: WorkerConfig;
  private prisma: PrismaClient;
  private redis: Redis;
  private claimService: JobClaimService;
  private getWorkerDbId: () => string;
  private getAvailableConcurrencySlots: () => number;
  private reserveSlot?: () => boolean;
  private releaseSlot?: () => void;
  private isDraining?: () => boolean;
  private onExecuteClaimedJob: StaleMessageRecoveryOptions['onExecuteClaimedJob'];
  private onExecuteQueuedJob: StaleMessageRecoveryOptions['onExecuteQueuedJob'];

  private cursor: string = '0-0';
  private isRunning: boolean = false;
  private isScanning: boolean = false;
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(options: StaleMessageRecoveryOptions) {
    this.config = options.config;
    this.prisma = options.prisma;
    this.redis = options.commandRedis;
    this.claimService = options.claimService;
    this.getWorkerDbId = options.getWorkerDbId;
    this.getAvailableConcurrencySlots = options.getAvailableConcurrencySlots;
    this.reserveSlot = options.reserveSlot;
    this.releaseSlot = options.releaseSlot;
    this.isDraining = options.isDraining;
    this.onExecuteClaimedJob = options.onExecuteClaimedJob;
    this.onExecuteQueuedJob = options.onExecuteQueuedJob;
  }

  /**
   * Starts periodic recovery scans for stale PEL entries.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.scanTimer = setInterval(() => {
      this.scanOnce().catch((err) => {
        console.error('[Reloop Recovery] Error during recovery scan pass:', err);
      });
    }, this.config.workerRecoveryScanIntervalMs);
  }

  /**
   * Stops recovery scanner and cancels active timer.
   */
  stop(): void {
    this.isRunning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /**
   * Executes a single recovery scan pass.
   * Can be called directly by tests or on interval.
   */
  async scanOnce(): Promise<{
    claimedCount: number;
    recoveredClaimedCount: number;
    blockedRunningCount: number;
    ackedTerminalCount: number;
  }> {
    if (this.isScanning || (this.isDraining && this.isDraining())) {
      return {
        claimedCount: 0,
        recoveredClaimedCount: 0,
        blockedRunningCount: 0,
        ackedTerminalCount: 0,
      };
    }

    this.isScanning = true;
    let claimedCount = 0;
    let recoveredClaimedCount = 0;
    let blockedRunningCount = 0;
    let ackedTerminalCount = 0;

    try {
      // 1. Call XAUTOCLAIM to discover stale PEL candidates
      // Response format: [nextCursor, entries, deletedIds?]
      const rawResult = (await (
        this.redis as unknown as {
          xautoclaim: (...args: (string | number)[]) => Promise<unknown>;
        }
      ).xautoclaim(
        this.config.jobStreamKey,
        this.config.jobConsumerGroup,
        this.config.workerConsumerName,
        this.config.workerPelMinIdleMs,
        this.cursor,
        'COUNT',
        this.config.workerRecoveryBatchSize,
      )) as [string, Array<[string, string[]] | null>, string[]?] | null;

      if (!rawResult || !Array.isArray(rawResult)) {
        return {
          claimedCount,
          recoveredClaimedCount,
          blockedRunningCount,
          ackedTerminalCount,
        };
      }

      const nextCursor = rawResult[0] || '0-0';
      const entries = rawResult[1] || [];
      this.cursor = nextCursor;

      claimedCount = entries.filter((e) => e !== null).length;

      // 2. Process each claimed entry
      for (const entry of entries) {
        if (!entry) continue;
        if (this.isDraining && this.isDraining()) break;
        const [msgId, fields] = entry;

        // 2a. Validate message structure and jobId
        let jobId: string | null = null;
        for (let i = 0; i < fields.length; i += 2) {
          if (fields[i] === 'jobId') {
            jobId = fields[i + 1];
            break;
          }
        }

        if (!jobId || !UUID_REGEX.test(jobId)) {
          console.warn(`[Reloop Recovery] Malformed PEL message ${msgId}: invalid or missing jobId. Acknowledging.`);
          await this.redis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
          ackedTerminalCount++;
          continue;
        }

        // 2b. Authoritative PostgreSQL check: reread durable state
        const job = await this.prisma.job.findUnique({
          where: { id: jobId },
          select: {
            id: true,
            organizationId: true,
            type: true,
            status: true,
            payload: true,
            attemptCount: true,
            maxAttempts: true,
            leaseExpiresAt: true,
            nextRunAt: true,
            claimedByWorkerId: true,
          },
        });

        if (!job) {
          console.warn(`[Reloop Recovery] Stale message ${msgId} references non-existent job ${jobId}. Acknowledging.`);
          await this.redis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
          ackedTerminalCount++;
          continue;
        }

        // 2c. Terminal / non-executable states: obsolete PEL message -> ACK immediately
        if (
          job.status === JobStatus.SUCCEEDED ||
          job.status === JobStatus.FAILED ||
          job.status === JobStatus.DEAD_LETTERED ||
          job.status === JobStatus.CANCELLED ||
          job.status === JobStatus.BLOCKED ||
          job.status === JobStatus.WAITING_APPROVAL
        ) {
          await this.redis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
          ackedTerminalCount++;
          continue;
        }

        // 2d. RETRY_WAITING: Failure already committed, waiting for nextRunAt
        // Stale PEL signal must be ACKed so it does not execute prematurely.
        // The normal scheduler will publish a fresh dispatch when nextRunAt <= NOW().
        if (job.status === JobStatus.RETRY_WAITING) {
          await this.redis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
          ackedTerminalCount++;
          continue;
        }

        // 2e. QUEUED: Worker received Redis message but crashed before PostgreSQL claim
        // Delegate to normal atomic claim path
        if (job.status === JobStatus.QUEUED) {
          await this.onExecuteQueuedJob(msgId, fields);
          continue;
        }

        // 2f. CLAIMED: Previous worker claimed job but crashed before entering RUNNING
        if (job.status === JobStatus.CLAIMED) {
          const now = Date.now();
          const isLeaseActive = job.leaseExpiresAt !== null && job.leaseExpiresAt.getTime() > now;

          if (isLeaseActive) {
            // Active lease! Original worker is still holding/renewing. Leave completely alone.
            continue;
          }

          // Lease expired: Check and reserve execution capacity safely before claiming.
          // This guarantees that a recovered CLAIMED job is NEVER stranded without an execution slot.
          const slotReserved = this.reserveSlot
            ? this.reserveSlot()
            : this.getAvailableConcurrencySlots() > 0;

          if (!slotReserved) {
            // Worker has no execution slot available; defer recovery pass
            continue;
          }

          const workerDbId = this.getWorkerDbId();
          const recoverResult = await this.claimService.recoverExpiredClaimedJob(
            jobId,
            workerDbId,
            this.config.jobLeaseDurationMs,
          );

          if (recoverResult.recovered) {
            recoveredClaimedCount++;
            if (recoverResult.execute && recoverResult.job && recoverResult.attemptId && recoverResult.attemptNumber) {
              // Execute recovered job through worker pipeline (pipeline will transition to RUNNING and XACK on completion)
              // Note: onExecuteClaimedJob handles the activeJobs transition and releases the reserved slot.
              this.onExecuteClaimedJob(
                recoverResult.job,
                recoverResult.attemptId,
                recoverResult.attemptNumber,
                msgId,
              ).catch((err) => {
                console.error(`[Reloop Recovery] Error executing recovered job ${jobId}:`, err);
              });
            } else if (recoverResult.deadLettered) {
              // Max attempts was exhausted; DB committed DEAD_LETTERED -> ACK Redis message
              if (this.releaseSlot) this.releaseSlot();
              await this.redis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
              ackedTerminalCount++;
            } else {
              if (this.releaseSlot) this.releaseSlot();
            }
          } else {
            // Did not recover (e.g. race lost or unexpired) -> release reservation
            if (this.releaseSlot) this.releaseSlot();
          }
          continue;
        }

        // 2g. RUNNING: Previous worker entered RUNNING before crashing
        // Execution started: external effects are ambiguous. NEVER blindly re-execute!
        if (job.status === JobStatus.RUNNING) {
          const now = Date.now();
          const isLeaseActive = job.leaseExpiresAt !== null && job.leaseExpiresAt.getTime() > now;

          if (isLeaseActive) {
            // Active lease! Original worker is running or renewing lease. Leave completely alone.
            continue;
          }

          // Lease expired during RUNNING: Durably mark attempt ABANDONED and Job BLOCKED
          const recovered = await this.claimService.recoverExpiredRunningJob(jobId);
          if (recovered) {
            blockedRunningCount++;
            // Transaction committed BLOCKED -> ACK stale Redis message
            await this.redis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
            ackedTerminalCount++;
          }
          continue;
        }
      }
    } finally {
      this.isScanning = false;
    }

    return {
      claimedCount,
      recoveredClaimedCount,
      blockedRunningCount,
      ackedTerminalCount,
    };
  }
}
