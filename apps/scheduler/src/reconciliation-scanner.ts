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

export const RECONCILIATION_ORGANIZATION_BATCH_SIZE = 20;

type TenantFailureCategory = 'snapshot_fetch' | 'reconciliation' | 'timeout';

class TenantScanFailure extends Error {
  constructor(readonly category: TenantFailureCategory) {
    super(`Reconciliation tenant scan failed: ${category}`);
    this.name = 'TenantScanFailure';
  }
}

interface TenantScanResult {
  scannedOrders: number;
  findingsCount: number;
  casesCount: number;
}

export class ReconciliationScanner {
  private isRunning = false;
  private isScanning = false;
  private timer: NodeJS.Timeout | null = null;
  private organizationScanCursor: string | null = null;

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

  getIsRunning(): boolean {
    return this.isRunning;
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

      // Walk organizations in stable, bounded primary-key pages. Once the final page
      // completes, restart the cycle so newly inserted lower IDs are eventually visited.
      const page = await this.prisma.organization.findMany({
        where: this.organizationScanCursor
          ? { id: { gt: this.organizationScanCursor } }
          : undefined,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: RECONCILIATION_ORGANIZATION_BATCH_SIZE + 1,
      });
      const hasMore = page.length > RECONCILIATION_ORGANIZATION_BATCH_SIZE;
      const orgs = page.slice(0, RECONCILIATION_ORGANIZATION_BATCH_SIZE);

      for (const org of orgs) {
        try {
          const tenantResult = await this.scanOrganization(org.id);
          scannedOrders += tenantResult.scannedOrders;
          findingsCount += tenantResult.findingsCount;
          casesCount += tenantResult.casesCount;
        } catch (error: unknown) {
          const category =
            error instanceof TenantScanFailure
              ? error.category
              : 'reconciliation';
          console.error(
            `[Reloop ReconciliationScanner] organization=${org.id} category=${category}`,
          );
        }
      }

      const lastOrganization = orgs[orgs.length - 1];
      this.organizationScanCursor =
        hasMore && lastOrganization ? lastOrganization.id : null;
    } finally {
      this.isScanning = false;
    }

    return { scannedOrders, findingsCount, casesCount };
  }

  private async scanOrganization(organizationId: string): Promise<TenantScanResult> {
    const deadlineAt = Date.now() + this.config.reconciliationTenantTimeoutMs;
    let snapshots: NormalizedOrderSnapshot[];
    try {
      snapshots = await this.runWithinTenantDeadline(
        () =>
          this.snapshotProvider!.fetchSnapshots(
            organizationId,
            this.config.reconciliationScanBatchSize,
          ),
        deadlineAt,
      );
    } catch (error: unknown) {
      if (error instanceof TenantScanFailure) throw error;
      throw new TenantScanFailure('snapshot_fetch');
    }

    const result: TenantScanResult = {
      scannedOrders: 0,
      findingsCount: 0,
      casesCount: 0,
    };

    for (const snapshot of snapshots) {
      let findings;
      try {
        findings = reconcileOrder(snapshot);
      } catch {
        throw new TenantScanFailure('reconciliation');
      }

      let persistedCases: RecoveryCase[] = [];
      if (findings.length > 0) {
        try {
          persistedCases = await this.runWithinTenantDeadline(
            () =>
              this.caseDetectionService.persistFindings(
                organizationId,
                findings,
                snapshot.externalOrderId,
              ),
            deadlineAt,
          );
        } catch (error: unknown) {
          if (error instanceof TenantScanFailure) throw error;
          throw new TenantScanFailure('reconciliation');
        }
      }

      result.scannedOrders++;
      result.findingsCount += findings.length;
      result.casesCount += persistedCases.length;
    }

    return result;
  }

  private async runWithinTenantDeadline<T>(
    work: () => Promise<T>,
    deadlineAt: number,
  ): Promise<T> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new TenantScanFailure('timeout');
    }

    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new TenantScanFailure('timeout')),
        remainingMs,
      );
    });

    try {
      return await Promise.race([Promise.resolve().then(work), timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
