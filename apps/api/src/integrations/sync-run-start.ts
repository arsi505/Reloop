import { Prisma, PrismaClient } from '@prisma/client';

export interface InitialSyncRunInput {
  integrationId: string;
  organizationId: string;
  syncRunId: string;
  jobType: 'SHOPIFY_SYNC_ORDERS' | 'SHIPSTATION_SYNC_SHIPMENTS';
  payload: Prisma.InputJsonObject;
  idempotencyKey: string;
}

export async function withSyncRunProjectionTransaction<T>(
  prisma: PrismaClient,
  integrationId: string,
  syncRunId: string | undefined,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ current: boolean; result?: T }> {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ configuration: Prisma.JsonValue | null }>>(
        Prisma.sql`SELECT configuration FROM integrations WHERE id = ${integrationId}::uuid FOR UPDATE`,
      );
      if (locked.length === 0) return { current: false };
      const configuration =
        locked[0].configuration && typeof locked[0].configuration === 'object'
          ? (locked[0].configuration as Record<string, unknown>)
          : {};
      const activeSyncRunId = configuration.activeSyncRunId;
      const current = syncRunId
        ? activeSyncRunId === syncRunId
        : typeof activeSyncRunId !== 'string';
      if (!current) return { current: false };
      return { current: true, result: await work(tx) };
    },
    { maxWait: 5_000, timeout: 30_000 },
  );
}

export async function establishExistingSyncJobRun(
  prisma: PrismaClient,
  integrationId: string,
  syncRunId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ configuration: Prisma.JsonValue | null }>>(
      Prisma.sql`SELECT configuration FROM integrations WHERE id = ${integrationId}::uuid FOR UPDATE`,
    );
    if (locked.length === 0) return false;
    const configuration =
      locked[0].configuration && typeof locked[0].configuration === 'object'
        ? (locked[0].configuration as Record<string, unknown>)
        : {};
    if (typeof configuration.activeSyncRunId === 'string') {
      return configuration.activeSyncRunId === syncRunId;
    }
    await tx.integration.update({
      where: { id: integrationId },
      data: {
        configuration: {
          ...configuration,
          activeSyncRunId: syncRunId,
          initialSyncStatus: 'SYNCING',
        },
      },
    });
    return true;
  });
}

export async function activateSyncRunWithInitialJob(
  prisma: PrismaClient,
  input: InitialSyncRunInput,
): Promise<void> {
  await prisma.$transaction((tx) =>
    activateSyncRunWithInitialJobInTransaction(tx, input),
  );
}

export async function activateSyncRunWithInitialJobInTransaction(
  tx: Prisma.TransactionClient,
  input: InitialSyncRunInput,
): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ configuration: Prisma.JsonValue | null }>>(
    Prisma.sql`SELECT configuration FROM integrations WHERE id = ${input.integrationId}::uuid AND organization_id = ${input.organizationId}::uuid FOR UPDATE`,
  );
  if (locked.length === 0) {
    throw new Error(`Integration ${input.integrationId} not found while starting sync`);
  }
  const configuration =
    locked[0].configuration && typeof locked[0].configuration === 'object'
      ? (locked[0].configuration as Record<string, unknown>)
      : {};
  await tx.integration.update({
    where: { id: input.integrationId },
    data: {
      configuration: {
        ...configuration,
        activeSyncRunId: input.syncRunId,
        initialSyncStatus: 'SYNCING',
      },
    },
  });
  await tx.job.create({
    data: {
      id: input.syncRunId,
      organizationId: input.organizationId,
      type: input.jobType,
      status: 'QUEUED',
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      nextRunAt: new Date(),
    },
  });
}
