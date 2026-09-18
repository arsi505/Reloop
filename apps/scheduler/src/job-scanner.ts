import { PrismaClient, JobStatus } from '@prisma/client';
import { SchedulerConfig } from './config';

export interface ScannedJob {
  id: string;
  status: JobStatus;
  priority: number;
  nextRunAt: Date | null;
  createdAt: Date;
}

export class JobScanner {
  private prisma: PrismaClient;
  private config: SchedulerConfig;

  constructor(prisma: PrismaClient, config: SchedulerConfig) {
    this.prisma = prisma;
    this.config = config;
  }

  /**
   * Scan PostgreSQL for jobs ready to be dispatched.
   *
   * Eligibility Criteria:
   * 1. status == 'QUEUED' AND (nextRunAt IS NULL OR nextRunAt <= NOW())
   * 2. OR status == 'RETRY_WAITING' AND nextRunAt <= NOW()
   *
   * All other statuses (CLAIMED, RUNNING, WAITING_APPROVAL, SUCCEEDED,
   * FAILED, BLOCKED, DEAD_LETTERED, CANCELLED) are strictly ignored.
   *
   * Ordering:
   * - priority DESC (higher priority first)
   * - nextRunAt ASC (earliest due first, nulls first for immediate queued jobs)
   * - createdAt ASC (FIFO tie-breaker)
   */
  async scanEligibleJobs(limit?: number): Promise<ScannedJob[]> {
    const batchSize = limit ?? this.config.schedulerBatchSize;
    const now = new Date();

    const jobs = await this.prisma.job.findMany({
      where: {
        OR: [
          { status: JobStatus.QUEUED, nextRunAt: { lte: now } },
          { status: JobStatus.RETRY_WAITING, nextRunAt: { lte: now } },
        ],
      },
      select: {
        id: true,
        status: true,
        priority: true,
        nextRunAt: true,
        createdAt: true,
      },
      orderBy: [
        { priority: 'desc' },
        { nextRunAt: 'asc' },
        { createdAt: 'asc' },
      ],
      take: batchSize,
    });

    return jobs;
  }
}