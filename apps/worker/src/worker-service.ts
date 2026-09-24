import * as os from 'os';
import Redis from 'ioredis';
import { PrismaClient, Prisma, WorkerStatus } from '@prisma/client';
import { WorkerConfig } from './config';
import { JobExecutorRegistry } from './executor';
import { JobClaimService, ClaimedJob } from './job-claim';
import { LeaseManager } from './lease-manager';
import { WorkerHeartbeat } from './heartbeat';
import { RetryPolicy } from './retry-policy';
import { classifyJobError } from './errors';
import { StaleMessageRecoveryService } from './stale-message-recovery';
import { WorkflowStepHandlerRegistry } from './workflow-step-registry';
import { WorkflowStepExecutor } from './workflow-step-executor';
import { ShopifySyncJobExecutor } from './shopify-sync-executor';
import { ShipStationSyncJobExecutor } from './shipstation-sync-executor';
import { SimulatorRecoveryActionAdapter } from '@reloop/connector-simulator';
import { registerRecoveryStepHandlers } from './recovery-step-handlers';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WorkerService {
  private config: WorkerConfig;
  private prisma: PrismaClient;
  private readRedis: Redis;
  private commandRedis: Redis;
  private executorRegistry: JobExecutorRegistry;
  private stepHandlerRegistry: WorkflowStepHandlerRegistry;
  private retryPolicy: RetryPolicy;

  private workerDbId: string = '';
  private claimService!: JobClaimService;
  private leaseManager!: LeaseManager;
  private heartbeat!: WorkerHeartbeat;
  private recoveryService!: StaleMessageRecoveryService;

  private isRunning: boolean = false;
  private isDraining: boolean = false;
  private activeJobs = new Set<string>();
  private inFlightCount: number = 0;
  private recoveryInFlightCount: number = 0;
  private loopPromise: Promise<void> | null = null;

  constructor(
    config: WorkerConfig,
    prisma: PrismaClient,
    options: {
      readRedis?: Redis;
      commandRedis?: Redis;
      executorRegistry?: JobExecutorRegistry;
      stepHandlerRegistry?: WorkflowStepHandlerRegistry;
      retryPolicy?: RetryPolicy;
      shopifySyncExecutor?: ShopifySyncJobExecutor;
      shipstationSyncExecutor?: ShipStationSyncJobExecutor;
      actionExecutor?: any;
      fetchFn?: typeof fetch;
    } = {},
  ) {
    this.config = config;
    this.prisma = prisma;
    this.executorRegistry = options.executorRegistry ?? new JobExecutorRegistry();
    this.stepHandlerRegistry = options.stepHandlerRegistry ?? new WorkflowStepHandlerRegistry();

    if (!this.stepHandlerRegistry.has('RECOVERY_CHECK_TRACKING')) {
      const actionExecutor = options.actionExecutor ?? new SimulatorRecoveryActionAdapter();
      registerRecoveryStepHandlers(this.stepHandlerRegistry, { actionExecutor });
    }

    if (!this.executorRegistry.has('WORKFLOW_STEP')) {
      const stepExecutor = new WorkflowStepExecutor(this.prisma, this.stepHandlerRegistry);
      this.executorRegistry.register('WORKFLOW_STEP', async (ctx) => {
        return await stepExecutor.execute(ctx);
      });
    }

    if (!this.executorRegistry.has('SHOPIFY_SYNC_ORDERS')) {
      const shopifySync =
        options.shopifySyncExecutor ??
        new ShopifySyncJobExecutor(this.prisma, {
          fetchFn: options.fetchFn,
        });
      this.executorRegistry.register('SHOPIFY_SYNC_ORDERS', async (ctx) => {
        return await shopifySync.execute(ctx);
      });
    }

    if (!this.executorRegistry.has('SHIPSTATION_SYNC_SHIPMENTS')) {
      const shipstationSync =
        options.shipstationSyncExecutor ??
        new ShipStationSyncJobExecutor(this.prisma, {
          fetchFn: options.fetchFn,
        });
      this.executorRegistry.register('SHIPSTATION_SYNC_SHIPMENTS', async (ctx) => {
        return await shipstationSync.execute(ctx);
      });
    }

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

    // 5. Initialize and start stale PEL recovery service
    this.recoveryService = new StaleMessageRecoveryService({
      config: this.config,
      prisma: this.prisma,
      commandRedis: this.commandRedis,
      claimService: this.claimService,
      getWorkerDbId: () => this.workerDbId,
      getAvailableConcurrencySlots: () =>
        this.config.workerConcurrency -
        (this.activeJobs.size + this.inFlightCount + this.recoveryInFlightCount),
      reserveSlot: () => {
        if (!this.isRunning || this.isDraining) return false;
        const available =
          this.config.workerConcurrency -
          (this.activeJobs.size + this.inFlightCount + this.recoveryInFlightCount);
        if (available <= 0) return false;
        this.recoveryInFlightCount++;
        return true;
      },
      releaseSlot: () => {
        if (this.recoveryInFlightCount > 0) {
          this.recoveryInFlightCount--;
        }
      },
      isDraining: () => this.isDraining,
      onExecuteClaimedJob: async (job, attemptId, attemptNumber, msgId) => {
        await this.executeClaimedJob(job, attemptId, attemptNumber, msgId, true /* fromRecovery */);
      },
      onExecuteQueuedJob: async (msgId, fields) => {
        await this.processStreamEntry(msgId, fields);
      },
    });
    this.recoveryService.start();

    this.isRunning = true;
    this.isDraining = false;

    console.log(
      `[Reloop Worker] Started worker: key=${this.config.workerKey}, consumer=${this.config.workerConsumerName}, concurrency=${this.config.workerConcurrency}, lease=${this.config.jobLeaseDurationMs}ms`,
    );

    // 6. Start main consumer loop
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
        const availableSlots =
          this.config.workerConcurrency -
          (this.activeJobs.size + this.inFlightCount + this.recoveryInFlightCount);
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

      if (!claim.claimed || !claim.job || !claim.attemptId || claim.attemptNumber === undefined) {
        // Another worker won the claim or job became unclaimable
        releaseInFlight();
        await this.commandRedis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
        return;
      }

      // 4. Claim won: release inFlight tracking and execute claimed job
      releaseInFlight();
      await this.executeClaimedJob(claim.job, claim.attemptId, claim.attemptNumber, msgId);
    } catch (unexpectedErr) {
      releaseInFlight();
      throw unexpectedErr;
    }
  }

  /**
   * Executes a claimed job through the full execution pipeline:
   * 1. Adds to activeJobs and updates worker status
   * 2. Starts lease renewal timer
   * 3. Transitions CLAIMED -> RUNNING in PostgreSQL immediately before handler start
   * 4. Runs handler via JobExecutorRegistry
   * 5. On success: marks job and attempt SUCCEEDED in PostgreSQL, then XACKs Redis message
   * 6. On failure: classifies error, evaluates retry policy:
   *    - RETRY_WAITING (if retryable and attempts remain)
   *    - DEAD_LETTERED (if retryable and attempts exhausted)
   *    - FAILED (if non-retryable)
   *    All finalization transactions are lease-fenced. Redis message is XACKed post-commit.
   * 7. Finally: stops lease renewal, removes from activeJobs, syncs heartbeat
   */
  async executeClaimedJob(
    job: ClaimedJob,
    attemptId: string,
    attemptNumber: number,
    msgId: string,
    fromRecovery: boolean = false,
  ): Promise<void> {
    const jobId = job.id;
    this.activeJobs.add(jobId);
    if (fromRecovery && this.recoveryInFlightCount > 0) {
      this.recoveryInFlightCount--;
    }
    await this.heartbeat.syncStatusOnActivityChange();

    // Start lease renewal (supports CLAIMED or RUNNING)
    this.leaseManager.startRenewal(jobId);

    // Perform conditional transition CLAIMED -> RUNNING immediately before handler execution
    const movedToRunning = await this.claimService.transitionToRunning(jobId, this.workerDbId);
    if (!movedToRunning) {
      console.warn(`[Reloop Worker] Failed transition to RUNNING for job ${jobId}. Ownership lost.`);
      this.leaseManager.stopRenewal(jobId);
      this.activeJobs.delete(jobId);
      await this.heartbeat.syncStatusOnActivityChange();
      await this.commandRedis.xack(this.config.jobStreamKey, this.config.jobConsumerGroup, msgId);
      return;
    }

    const startTime = Date.now();
    try {
      // Execute handler
      const result = await this.executorRegistry.execute(job.type, {
        jobId,
        attemptNumber,
        type: job.type,
        payload: job.payload,
        workerId: this.workerDbId,
        organizationId: job.organizationId,
        workflowId: job.workflowId,
        workflowStepId: job.workflowStepId,
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
            attemptId,
            this.workerDbId,
            durationMs,
            result,
          );
        } finally {
          this.leaseManager.stopRenewal(jobId);
        }

        if (!marked) {
          console.warn(
            `[Reloop Worker] Worker ${this.workerDbId} lost lease or ownership before marking job ${jobId} SUCCEEDED. Skipping XACK.`,
          );
        } else {
          // Authoritative lease confirmed: update WorkflowStep to SUCCEEDED with durable output
          if (job.workflowStepId) {
            try {
              const stepOutput =
                result && typeof result === 'object' && 'output' in result
                  ? (result as { output: unknown }).output
                  : result;

              await this.prisma.workflowStep.update({
                where: { id: job.workflowStepId },
                data: {
                  status: 'SUCCEEDED',
                  output: (stepOutput as Prisma.InputJsonValue) ?? Prisma.JsonNull,
                  completedAt: new Date(),
                },
              });

              if (job.organizationId) {
                try {
                  const eventPayload = JSON.stringify({
                    organizationId: job.organizationId,
                    eventType: 'recovery.updated',
                    resourceId: job.workflowId || job.workflowStepId,
                    resourceType: 'RECOVERY',
                    status: 'SUCCEEDED',
                    changedAt: new Date().toISOString(),
                  });
                  await this.commandRedis.publish('reloop:realtime:events', eventPayload);
                } catch {
                  // Non-blocking invalidation publish
                }
              }
            } catch (stepErr) {
              console.warn(
                `[Reloop Worker] Failed updating workflowStep ${job.workflowStepId} to SUCCEEDED (will be reconciled by coordinator):`,
                stepErr,
              );
            }
          }

          // Core Rule: POSTGRESQL COMMIT FIRST, THEN XACK
          if (job.organizationId && (job.type === 'SHOPIFY_SYNC_ORDERS' || job.type === 'SHIPSTATION_SYNC_SHIPMENTS')) {
            try {
              const provider = job.type === 'SHOPIFY_SYNC_ORDERS' ? 'SHOPIFY' : 'SHIPSTATION';
              const payloadObj = (job.payload as Record<string, any>) || {};
              const integrationId = payloadObj.integrationId || (result as any)?.integrationId;
              const syncEvent = JSON.stringify({
                organizationId: job.organizationId,
                eventType: 'integration.sync_completed',
                resourceId: integrationId,
                resourceType: 'INTEGRATION',
                provider,
                status: 'COMPLETED',
                changedAt: new Date().toISOString(),
              });
              await this.commandRedis.publish('reloop:realtime:events', syncEvent);
            } catch {
              // Non-blocking invalidation publish
            }
          }

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
        const maxAttempts = job.maxAttempts;

        let marked = false;
        let isTerminalFailure = false;
        try {
          if (this.retryPolicy.shouldRetry(classified, attemptNumber, maxAttempts)) {
            // Branch 1: Retryable error and attempts remain -> RETRY_WAITING
            const nextRunAt = this.retryPolicy.calculateNextRunAt(attemptNumber, classified.retryAfterMs);
            marked = await this.claimService.markJobRetryWaiting(
              jobId,
              attemptId,
              this.workerDbId,
              durationMs,
              classified,
              nextRunAt,
            );
          } else if (classified.retryable && attemptNumber >= maxAttempts) {
            // Branch 2: Retryable error but attempts exhausted -> DEAD_LETTERED
            isTerminalFailure = true;
            marked = await this.claimService.markJobDeadLettered(
              jobId,
              attemptId,
              this.workerDbId,
              durationMs,
              classified,
            );
          } else {
            // Branch 3: Non-retryable / Permanent failure -> FAILED
            isTerminalFailure = true;
            marked = await this.claimService.markJobFailed(
              jobId,
              attemptId,
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
          // If terminal failure and job has workflowStepId, reconcile step to FAILED
          if (isTerminalFailure && job.workflowStepId) {
            await this.prisma.workflowStep
              .update({
                where: { id: job.workflowStepId },
                data: {
                  status: 'FAILED',
                  completedAt: new Date(),
                },
              })
              .catch((stepErr) => {
                console.warn(
                  `[Reloop Worker] Failed updating workflowStep ${job.workflowStepId} to FAILED (will be reconciled by coordinator):`,
                  stepErr,
                );
              });
          }

          // Emit integration.sync_failed on terminal sync failure
          if (isTerminalFailure && job.organizationId && (job.type === 'SHOPIFY_SYNC_ORDERS' || job.type === 'SHIPSTATION_SYNC_SHIPMENTS')) {
            try {
              const provider = job.type === 'SHOPIFY_SYNC_ORDERS' ? 'SHOPIFY' : 'SHIPSTATION';
              const payloadObj = (job.payload as Record<string, any>) || {};
              const integrationId = payloadObj.integrationId;
              const syncFailedEvent = JSON.stringify({
                organizationId: job.organizationId,
                eventType: 'integration.sync_failed',
                resourceId: integrationId,
                resourceType: 'INTEGRATION',
                provider,
                status: 'FAILED',
                reason: classified?.code || 'SYNC_FAILED',
                changedAt: new Date().toISOString(),
              });
              await this.commandRedis.publish('reloop:realtime:events', syncFailedEvent);
            } catch {
              // Non-blocking invalidation publish
            }
          }

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
  }

  async stop(): Promise<void> {
    if (!this.isRunning && !this.isDraining) return;

    console.log(`[Reloop Worker] Initiating graceful shutdown for worker ${this.config.workerKey}...`);
    this.isDraining = true;
    this.isRunning = false;

    // 0. Stop recovery scanner immediately
    if (this.recoveryService) {
      this.recoveryService.stop();
    }

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

  getInFlightCount(): number {
    return this.inFlightCount;
  }

  getRecoveryInFlightCount(): number {
    return this.recoveryInFlightCount;
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

  getStepHandlerRegistry(): WorkflowStepHandlerRegistry {
    return this.stepHandlerRegistry;
  }

  getRecoveryService(): StaleMessageRecoveryService {
    return this.recoveryService;
  }
}