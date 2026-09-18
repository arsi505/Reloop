import { PrismaClient, WorkerStatus } from '@prisma/client';
import { WorkerConfig } from './config';

export class WorkerHeartbeat {
  private prisma: PrismaClient;
  private config: WorkerConfig;
  private workerDbId: string;
  private getActiveJobCount: () => number;
  private getIsDraining: () => boolean;

  private timer: NodeJS.Timeout | null = null;
  private lastRecordedStatus: WorkerStatus = WorkerStatus.ONLINE;
  private isRunning: boolean = false;

  constructor(
    prisma: PrismaClient,
    config: WorkerConfig,
    workerDbId: string,
    getActiveJobCount: () => number,
    getIsDraining: () => boolean,
  ) {
    this.prisma = prisma;
    this.config = config;
    this.workerDbId = workerDbId;
    this.getActiveJobCount = getActiveJobCount;
    this.getIsDraining = getIsDraining;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.timer = setInterval(async () => {
      await this.sendHeartbeat().catch((err) => {
        console.error('[WorkerHeartbeat] Heartbeat pulse failed:', err);
      });
    }, this.config.workerHeartbeatIntervalMs);
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sendHeartbeat(): Promise<void> {
    const isDraining = this.getIsDraining();
    const activeJobs = this.getActiveJobCount();

    let targetStatus: WorkerStatus;
    if (isDraining) {
      targetStatus = WorkerStatus.DRAINING;
    } else if (activeJobs > 0) {
      targetStatus = WorkerStatus.BUSY;
    } else {
      targetStatus = WorkerStatus.ONLINE;
    }

    this.lastRecordedStatus = targetStatus;

    await this.prisma.worker.update({
      where: { id: this.workerDbId },
      data: {
        lastHeartbeatAt: new Date(),
        status: targetStatus,
      },
    });
  }

  async syncStatusOnActivityChange(): Promise<void> {
    if (!this.isRunning) return;

    const isDraining = this.getIsDraining();
    const activeJobs = this.getActiveJobCount();

    let targetStatus: WorkerStatus;
    if (isDraining) {
      targetStatus = WorkerStatus.DRAINING;
    } else if (activeJobs > 0) {
      targetStatus = WorkerStatus.BUSY;
    } else {
      targetStatus = WorkerStatus.ONLINE;
    }

    if (targetStatus !== this.lastRecordedStatus) {
      await this.sendHeartbeat().catch((err) => {
        console.error('[WorkerHeartbeat] Status change sync failed:', err);
      });
    }
  }

  getLastRecordedStatus(): WorkerStatus {
    return this.lastRecordedStatus;
  }
}