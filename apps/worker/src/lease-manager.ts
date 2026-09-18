import { WorkerConfig } from './config';
import { JobClaimService } from './job-claim';

interface ActiveLease {
  jobId: string;
  timer: NodeJS.Timeout;
  ownershipLost: boolean;
}

export class LeaseManager {
  private config: WorkerConfig;
  private claimService: JobClaimService;
  private workerDbId: string;
  private activeLeases = new Map<string, ActiveLease>();

  constructor(
    config: WorkerConfig,
    claimService: JobClaimService,
    workerDbId: string,
  ) {
    this.config = config;
    this.claimService = claimService;
    this.workerDbId = workerDbId;
  }

  startRenewal(jobId: string): void {
    if (this.activeLeases.has(jobId)) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const renewed = await this.claimService.renewLease(
          jobId,
          this.workerDbId,
          this.config.jobLeaseDurationMs,
        );

        if (!renewed) {
          console.warn(
            `[LeaseManager] Worker ${this.workerDbId} lost lease ownership for job ${jobId}`,
          );
          const lease = this.activeLeases.get(jobId);
          if (lease) {
            lease.ownershipLost = true;
            clearInterval(lease.timer);
          }
        }
      } catch (err) {
        console.error(`[LeaseManager] Error renewing lease for job ${jobId}:`, err);
      }
    }, this.config.jobLeaseRenewIntervalMs);

    this.activeLeases.set(jobId, {
      jobId,
      timer,
      ownershipLost: false,
    });
  }

  stopRenewal(jobId: string): void {
    const lease = this.activeLeases.get(jobId);
    if (lease) {
      clearInterval(lease.timer);
      this.activeLeases.delete(jobId);
    }
  }

  hasLostOwnership(jobId: string): boolean {
    const lease = this.activeLeases.get(jobId);
    return lease ? lease.ownershipLost : false;
  }

  stopAll(): void {
    for (const lease of this.activeLeases.values()) {
      clearInterval(lease.timer);
    }
    this.activeLeases.clear();
  }

  getActiveLeaseCount(): number {
    return this.activeLeases.size;
  }
}