import { PrismaClient, JobStatus } from '@prisma/client';

export interface DeadLetterSummary {
  jobId: string;
  type: string;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCategory?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  createdAt: Date;
  completedAt?: Date | null;
}

/**
 * Development inspection helper to inspect DEAD_LETTERED jobs.
 * Retrieves safe metadata without exposing secrets.
 */
export async function inspectDeadLetterJobs(
  prisma: PrismaClient,
  options: { organizationId?: string; limit?: number } = {},
): Promise<DeadLetterSummary[]> {
  const limit = options.limit ?? 50;

  const jobs = await prisma.job.findMany({
    where: {
      status: JobStatus.DEAD_LETTERED,
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    include: {
      attempts: {
        orderBy: { attemptNumber: 'desc' },
        take: 1,
      },
    },
  });

  return jobs.map((j) => {
    const lastAttempt = j.attempts[0];
    return {
      jobId: j.id,
      type: j.type,
      attemptCount: j.attemptCount,
      maxAttempts: j.maxAttempts,
      lastErrorCategory: lastAttempt?.errorCategory ?? null,
      lastErrorCode: lastAttempt?.errorCode ?? null,
      lastErrorMessage: lastAttempt?.errorMessage ?? null,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
    };
  });
}
