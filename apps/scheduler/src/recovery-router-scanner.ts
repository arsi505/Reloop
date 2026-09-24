import { PrismaClient, RecoveryCaseStatus } from '@prisma/client';
import { SchedulerConfig } from './config';
import { RecoveryRouterService } from './recovery-router/recovery-router.service';

export class RecoveryRouterScanner {
  private timer: NodeJS.Timeout | null = null;
  private isScanning = false;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly routerService: RecoveryRouterService,
    private readonly config: SchedulerConfig,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(async () => {
      try {
        await this.tick();
      } catch (err) {
        console.error('[Reloop RecoveryRouterScanner] Error in scan tick:', err);
      }
    }, this.config.recoveryRouterScanIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    while (this.isScanning) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  getIsRunning(): boolean {
    return this.running;
  }

  /**
   * Performs a single scan tick:
   * Finds OPEN recovery cases and routes them using RecoveryRouterService.
   */
  async tick(): Promise<{ scannedCases: number; routedWorkflows: number; blockedCases: number }> {
    if (this.isScanning) {
      return { scannedCases: 0, routedWorkflows: 0, blockedCases: 0 };
    }

    this.isScanning = true;
    let scannedCases = 0;
    let routedWorkflows = 0;
    let blockedCases = 0;

    try {
      const activeCases = await this.prisma.recoveryCase.findMany({
        where: {
          status: {
            in: [RecoveryCaseStatus.OPEN, RecoveryCaseStatus.READY_FOR_RECOVERY],
          },
        },
        take: this.config.recoveryRouterBatchSize,
        orderBy: { detectedAt: 'asc' },
      });

      for (const rCase of activeCases) {
        scannedCases++;
        const result = await this.routerService.routeCase(rCase.id, rCase.organizationId);

        if (result.routed) {
          routedWorkflows++;
        } else if (result.action === 'BLOCKED') {
          blockedCases++;
        }
      }
    } finally {
      this.isScanning = false;
    }

    return { scannedCases, routedWorkflows, blockedCases };
  }
}
