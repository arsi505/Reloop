import { PrismaClient, RecoveryCase } from '@prisma/client';
import {
  reconcileOrder,
  NormalizedOrderSnapshot,
} from '@reloop/reconciliation-core';
import { CaseDetectionService } from './case-detection/case-detection.service';
import { SchedulerConfig } from './config';

export interface OrderSnapshotProvider {
  fetchSnapshots(organizationId: string, limit: number): Promise<NormalizedOrderSnapshot[]>;
}

export class ReconciliationScanner {
  private isRunning = false;
  private isScanning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly caseDetectionService: CaseDetectionService,
    private readonly config: SchedulerConfig,
    private readonly snapshotProvider?: OrderSnapshotProvider,
  ) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // If a scan tick is actively running, wait for it to conclude cleanly
    while (this.isScanning) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private scheduleNextTick(): void {
    if (!this.isRunning) return;

    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        console.error('[Reloop ReconciliationScanner] Error during tick:', err);
      } finally {
        if (this.isRunning) {
          this.scheduleNextTick();
        }
      }
    }, this.config.reconciliationScanIntervalMs);
  }

  /**
   * Processes a single normalized snapshot, evaluates findings, and persists RecoveryCases.
   */
  async processSnapshot(snapshot: NormalizedOrderSnapshot): Promise<RecoveryCase[]> {
    const findings = reconcileOrder(snapshot);
    if (findings.length === 0) {
      return [];
    }

    return this.caseDetectionService.persistFindings(
      snapshot.organizationId,
      findings,
      snapshot.externalOrderId,
    );
  }

  /**
   * Performs a single scan tick across organizations.
   */
  async tick(): Promise<{ scannedOrders: number; findingsCount: number; casesCount: number }> {
    if (this.isScanning) {
      return { scannedOrders: 0, findingsCount: 0, casesCount: 0 };
    }

    this.isScanning = true;
    let scannedOrders = 0;
    let findingsCount = 0;
    let casesCount = 0;

    try {
      if (!this.snapshotProvider) {
        return { scannedOrders: 0, findingsCount: 0, casesCount: 0 };
      }

      // Fetch active organizations
      const orgs = await this.prisma.organization.findMany({
        select: { id: true },
        take: 20,
      });

      for (const org of orgs) {
        const snapshots = await this.snapshotProvider.fetchSnapshots(
          org.id,
          this.config.reconciliationScanBatchSize,
        );

        for (const snapshot of snapshots) {
          scannedOrders++;
          const findings = reconcileOrder(snapshot);
          findingsCount += findings.length;

          if (findings.length > 0) {
            const cases = await this.caseDetectionService.persistFindings(
              org.id,
              findings,
              snapshot.externalOrderId,
            );
            casesCount += cases.length;
          }
        }
      }
    } finally {
      this.isScanning = false;
    }

    return { scannedOrders, findingsCount, casesCount };
  }
}
