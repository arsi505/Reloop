import * as os from 'os';
import Redis from 'ioredis';
import { PrismaClient, WorkerStatus } from '@prisma/client';
import { WorkerConfig } from './config';
import { JobExecutorRegistry } from './executor';
import { JobClaimService } from './job-claim';
import { LeaseManager } from './lease-manager';
import { WorkerHeartbeat } from './heartbeat';
import { RetryPolicy } from './retry-policy';
import { classifyJobError } from './errors';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WorkerService {
  private config: WorkerConfig;
  private prisma: PrismaClient;
  private readRedis: Redis;
  private commandRedis: Redis;
  private executorRegistry: JobExecutorRegistry;
  private retryPolicy: RetryPolicy;

  private workerDbId: string = '';
  private claimService!: JobClaimService;
  private leaseManager!: LeaseManager;
  private heartbeat!: WorkerHeartbeat;

  private isRunning: boolean = false;
  private isDraining: boolean = false;
  private activeJobs = new Set<string>();
  private inFlightCount: number = 0;
  private loopPromise: Promise<void> | null = null;

  constructor(
    config: WorkerConfig,
    prisma: PrismaClient,
    options: {
      readRedis?: Redis;
      commandRedis?: Redis;
      executorRegistry?: JobExecutorRegistry;
      retryPolicy?: RetryPolicy;
    } = {},
  ) {
    this.config = config;
    this.prisma = prisma;
    this.executorRegistry = options.executorRegistry ?? new JobExecutorRegistry();
    this.retryPolicy =
      options.retryPolicy ??
      new RetryPolicy({
        delaysMs: config.jobRetryDelaysMs,
        jitterPercent: config.jobRetryJitterPercent,
      });

    this.readRedis =
      options.readRedis ??
      new Redis(config.redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        lazyConnect: true,
      });

    this.commandRedis =
      options.commandRedis ??
      new Redis(config.redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        lazyConnect: true,
      });
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    // 1. Connect Redis clients
    if (this.readRedis.status === 'wait') {
      await this.readRedis.connect();
    }
    if (this.commandRedis.status === 'wait') {
      await this.commandRedis.connect();
    }

    // 2. Ensure consumer group exists
    await this.ensureConsumerGroup();

    // 3. Register Worker row in PostgreSQL
    await this.registerWorker();

    // 4. Initialize services
    this.claimService = new JobClaimService(this.prisma);
    this.leaseManager = new LeaseManager(this.config, this.claimService, this.workerDbId);
    this.heartbeat = new WorkerHeartbeat(
      this.prisma,
      this.config,
      this.workerDbId,
      () => this.activeJobs.size,
      () => this.isDraining,
    );
    this.heartbeat.start();

    this.isRunning = true;
    this.isDraining = false;

    console.log(
      `[Reloop Worker] Started worker: key=${this.config.workerKey}, consumer=${this.config.workerConsumerName}, concurrency=${this.config.workerConcurrency}, lease=${this.config.jobLeaseDurationMs}ms`,
    );

    // 5. Start main consumer loop
    this.loopPromise = this.consumerLoop();
  }

  private async ensureConsumerGroup(): Promise<void> {
    try {
      await this.commandRedis.xgroup(
        'CREATE',
        this.config.jobStreamKey,
        this.config.jobConsumerGroup,
        '$',
        'MKSTREAM',
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('BUSYGROUP')) {
        return;
      }
      if (
        typeof err === 'object' &&
        err !== null &&
        'message' in err &&
        typeof (err as { message: unknown }).message === 'string' &&
        ((err as { message: string }).message).includes('BUSYGROUP')
      ) {
        return;
      }
      throw err;
    }
  }

  private async registerWorker(): Promise<void> {
    const metadata = {
      hostname: os.hostname(),
      pid: process.pid,
      concurrency: this.config.workerConcurrency,
      consumerName: this.config.workerConsumerName,
    };

    const worker = await this.prisma.worker.upsert({
      where: { workerKey: this.config.workerKey },
      update: {
        status: WorkerStatus.ONLINE,
        lastHeartbeatAt: new Date(),
        stoppedAt: null,
        metadata,
      },
      create: {
        workerKey: this.config.workerKey,
        status: WorkerStatus.ONLINE,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        metadata,
      },
    });

    this.workerDbId = worker.id;
  }

  private async consumerLoop(): Promise<void> {
    while (this.isRunning && !this.isDraining) {
      try {
        const availableSlots = this.config.workerConcurrency - (this.activeJobs.size + this.inFlightCount);
        if (availableSlots <= 0) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }

        const response = (await this.readRedis.xreadgroup(
          'GROUP',
          this.config.jobConsumerGroup,
          this.config.workerConsumerName,
          'COUNT',
          availableSlots,
          'BLOCK',
          this.config.blockTimeoutMs,
          'STREAMS',
          this.config.jobStreamKey,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!response || response.length === 0) {
          continue;
        }

        const streamEntries = response[0][1];
        if (!streamEntries || streamEntries.length === 0) {
          continue;
        }

        this.inFlightCount += streamEntries.length;

        for (const [msgId, fields] of streamEntries) {
          if (!this.isRunning || this.isDraining) {
            this.inFlightCount--;
            continue;
          }

          // Dispatch processing without blocking the consumer loop
          this.processStreamEntry(msgId, fields).catch((err) => {
            console.error(`[Reloop Worker] Unexpected error processing message ${msgId}:`, err);
          });
        }
      } catch (err: unknown) {
        if (!this.isRunning || this.isDraining) {
          break;
        }
        console.error('[Reloop Worker] Error in consumer loop:', err);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  private async processStreamEntry(msgId: string, fields: string[]): Promise<void> {
    let inFlightReleased = false;
    const releaseInFlight = () => {
      if (!inFlightReleased) {
        this.inFlightCount--;
        inFlightReleased = true;
      }
    };

    try {
      // 1. Validate stream message structure
      let jobId: string | null = null;
      for (let i = 0; i < fields.length; i += 2) {
        if (fields[i] === 'jobId') {
          jobId = fields[i + 1];
          break;
        }
      }

      if (!jobId || !UUID_REGEX.test(jobId)) {
        console.warn(`[Reloop Worker] Malformed stream message ${msgId}: missing or invalid jobId. Acknowledging.`);
        releaseInFlight();
        await this.commandRedis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
        return;
      }

      // 2. Reread PostgreSQL to verify Job existence and state
      const job = await this.prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          status: true,
          nextRunAt: true,
        },
      });

      if (!job) {
        console.warn(`[Reloop Worker] Job ${jobId} not found in database. Acknowledging stale message.`);
        releaseInFlight();
        await this.commandRedis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
        return;
      }

      // If Job is already in a non-claimable state, ACK and skip
      if (
        job.status === 'SUCCEEDED' ||
        job.status === 'FAILED' ||
        job.status === 'CANCELLED' ||
        job.status === 'DEAD_LETTERED' ||
        job.status === 'BLOCKED' ||
        job.status === 'WAITING_APPROVAL' ||
        job.status === 'CLAIMED' ||
        job.status === 'RUNNING'
      ) {
        releaseInFlight();
        await this.commandRedis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
        return;
      }

      // 3. Attempt Atomic Claim
      const claim = await this.claimService.atomicClaimJob(
        jobId,
        this.workerDbId,
        this.config.jobLeaseDurationMs,
      );

      if (!claim.claimed || !claim.job || !claim.attemptId) {
        // Another worker won the claim or job became unclaimable
        releaseInFlight();
        await this.commandRedis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
        return;
      }

      // 4. Claim won: Track active job
      this.activeJobs.add(jobId);
      releaseInFlight();
      await this.heartbeat.syncStatusOnActivityChange();

      // Start lease renewal (supports CLAIMED or RUNNING)
      this.leaseManager.startRenewal(jobId);

      // Perform conditional transition CLAIMED -> RUNNING immediately before handler execution
      const movedToRunning = await this.claimService.transitionToRunning(jobId, this.workerDbId);
      if (!movedToRunning) {
        console.warn(`[Reloop Worker] Failed transition to RUNNING for job ${jobId}. Ownership lost.`);
        this.leaseManager.stopRenewal(jobId);
        await this.commandRedis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
        return;
      }

      const startTime = Date.now();
      try {
        // Execute handler
        await this.executorRegistry.execute(claim.job.type, {
          jobId,
          attemptNumber: claim.attemptNumber!,
          type: claim.job.type,
          payload: claim.job.payload,
          workerId: this.workerDbId,
          organizationId: claim.job.organizationId,
        });

        const durationMs = Date.now() - startTime;

        if (this.leaseManager.hasLostOwnership(jobId)) {
          console.warn(
            `[Reloop Worker] Worker ${this.workerDbId} lost lease during execution of job ${jobId}. Succeeded update skipped.`,
          );
          this.leaseManager.stopRenewal(jobId);
        } else {
          // Durable success transaction while lease renewal remains active
          let marked = false;
          try {
            marked = await this.claimService.markJobSucceeded(
              jobId,
              claim.attemptId,
              this.workerDbId,
              durationMs,
            );
          } finally {
            this.leaseManager.stopRenewal(jobId);
          }

          if (!marked) {
            console.warn(
              `[Reloop Worker] Worker ${this.workerDbId} lost lease or ownership before marking job ${jobId} SUCCEEDED. Skipping XACK.`,
            );
          } else {
            // Core Rule: POSTGRESQL COMMIT FIRST, THEN XACK
            await this.commandRedis.xack(
              this.config.jobStreamKey,
              this.config.jobConsumerGroup,
              msgId,
            );
          }
        }
      } catch (err: unknown) {
        const durationMs = Date.now() - startTime;

        if (this.leaseManager.hasLostOwnership(jobId)) {
          console.warn(
            `[Reloop Worker] Worker ${this.workerDbId} lost lease during execution of job ${jobId}. Failure update skipped.`,
          );
          this.leaseManager.stopRenewal(jobId);
        } else {
          const classified = classifyJobError(err);
          const attemptNumber = claim.attemptNumber!;
          const maxAttempts = claim.job.maxAttempts;

          let marked = false;
          try {
            if (this.retryPolicy.shouldRetry(classified, attemptNumber, maxAttempts)) {
              // Branch 1: Retryable error and attempts remain -> RETRY_WAITING
              const nextRunAt = this.retryPolicy.calculateNextRunAt(attemptNumber, classified.retryAfterMs);
              marked = await this.claimService.markJobRetryWaiting(
                jobId,
                claim.attemptId,
                this.workerDbId,
                durationMs,
                classified,
                nextRunAt,
              );
            } else if (classified.retryable && attemptNumber >= maxAttempts) {
              // Branch 2: Retryable error but attempts exhausted -> DEAD_LETTERED
              marked = await this.claimService.markJobDeadLettered(
                jobId,
                claim.attemptId,
                this.workerDbId,
                durationMs,
                classified,
              );
            } else {
              // Branch 3: Non-retryable / Permanent failure -> FAILED
              marked = await this.claimService.markJobFailed(
                jobId,
                claim.attemptId,
                this.workerDbId,
                durationMs,
                classified,
              );
            }
          } finally {
            // Stop lease renewal ONLY after durable finalization transaction completes
            this.leaseManager.stopRenewal(jobId);
          }

          if (!marked) {
            console.warn(
              `[Reloop Worker] Worker ${this.workerDbId} lost lease before marking failure for job ${jobId}. Skipping XACK.`,
            );
          } else {
            // Core Rule: POSTGRESQL COMMIT FIRST, THEN XACK
            await this.commandRedis.xack(
              this.config.jobStreamKey,
              this.config.jobConsumerGroup,
              msgId,
            );
          }
        }
      } finally {
        this.activeJobs.delete(jobId);
        await this.heartbeat.syncStatusOnActivityChange();
      }
    } catch (unexpectedErr) {
      releaseInFlight();
      throw unexpectedErr;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning && !this.isDraining) return;

    console.log(`[Reloop Worker] Initiating graceful shutdown for worker ${this.config.workerKey}...`);
    this.isDraining = true;
    this.isRunning = false;

    // 1. Mark worker as DRAINING in PostgreSQL
    if (this.workerDbId) {
      await this.prisma.worker
        .update({
          where: { id: this.workerDbId },
          data: { status: WorkerStatus.DRAINING },
        })
        .catch(() => {});
    }

    // 2. Disconnect read client to break any blocking XREADGROUP call
    try {
      this.readRedis.disconnect();
    } catch {
      // Ignore disconnect errors during shutdown
    }

    // 3. Wait for loop to finish
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }

    // 4. Wait for active jobs to complete up to timeout
    const startTime = Date.now();
    while (this.activeJobs.size > 0 && Date.now() - startTime < this.config.workerShutdownTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (this.activeJobs.size > 0) {
      console.warn(
        `[Reloop Worker] ${this.activeJobs.size} active jobs still running after shutdown timeout (${this.config.workerShutdownTimeoutMs}ms). Exiting cleanly without marking them SUCCEEDED.`,
      );
    }

    // 5. Stop lease renewal timers and heartbeat
    if (this.leaseManager) {
      this.leaseManager.stopAll();
    }
    if (this.heartbeat) {
      this.heartbeat.stop();
    }

    // 6. Mark worker OFFLINE in PostgreSQL
    if (this.workerDbId) {
      await this.prisma.worker
        .update({
          where: { id: this.workerDbId },
          data: {
            status: WorkerStatus.OFFLINE,
            stoppedAt: new Date(),
          },
        })
        .catch(() => {});
    }

    // 7. Disconnect command Redis
    if (this.commandRedis.status !== 'end') {
      try {
        await this.commandRedis.quit();
      } catch {
        this.commandRedis.disconnect();
      }
    }

    console.log(`[Reloop Worker] Worker ${this.config.workerKey} shutdown complete.`);
  }

  getWorkerDbId(): string {
    return this.workerDbId;
  }

  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }

  getIsDraining(): boolean {
    return this.isDraining;
  }

  getExecutorRegistry(): JobExecutorRegistry {
    return this.executorRegistry;
  }
}