import { Prisma, PrismaClient } from '@prisma/client';

export type SyncConfiguration = Record<string, unknown>;

export function asSyncConfiguration(value: unknown): SyncConfiguration {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as SyncConfiguration)
    : {};
}

async function lockIntegrationConfiguration(
  tx: Prisma.TransactionClient,
  integrationId: string,
): Promise<SyncConfiguration | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM integrations WHERE id = ${integrationId}::uuid FOR UPDATE`,
  );
  if (locked.length === 0) return null;

  const integration = await tx.integration.findUnique({
    where: { id: integrationId },
    select: { configuration: true },
  });
  return integration ? asSyncConfiguration(integration.configuration) : null;
}

export async function withCurrentSyncRunTransaction<T>(
  prisma: PrismaClient,
  integrationId: string,
  syncRunId: string,
  work: (
    tx: Prisma.TransactionClient,
    configuration: SyncConfiguration,
  ) => Promise<T>,
): Promise<{ current: boolean; result?: T }> {
  return prisma.$transaction(
    async (tx) => {
      const configuration = await lockIntegrationConfiguration(tx, integrationId);
      if (!configuration || configuration.activeSyncRunId !== syncRunId) {
        return { current: false };
      }
      return { current: true, result: await work(tx, configuration) };
    },
    { maxWait: 5_000, timeout: 30_000 },
  );
}

export async function establishSyncRun(
  prisma: PrismaClient,
  integrationId: string,
  configuredRunId: unknown,
  fallbackRunId: string,
): Promise<{ syncRunId: string; current: boolean; configuration: SyncConfiguration }> {
  return prisma.$transaction(async (tx) => {
    const configuration =
      (await lockIntegrationConfiguration(tx, integrationId)) || {};
    const activeSyncRunId =
      typeof configuration.activeSyncRunId === 'string'
        ? configuration.activeSyncRunId
        : undefined;
    const explicitRunId =
      typeof configuredRunId === 'string' && configuredRunId.trim()
        ? configuredRunId.trim()
        : undefined;
    const syncRunId = explicitRunId || activeSyncRunId || fallbackRunId;

    if (activeSyncRunId) {
      return { syncRunId, current: activeSyncRunId === syncRunId, configuration };
    }

    const nextConfiguration = {
      ...configuration,
      activeSyncRunId: syncRunId,
      initialSyncStatus: 'SYNCING',
    };
    await tx.integration.update({
      where: { id: integrationId },
      data: { configuration: nextConfiguration as Prisma.InputJsonValue },
    });
    return { syncRunId, current: true, configuration: nextConfiguration };
  });
}

export async function isCurrentSyncRun(
  prisma: PrismaClient,
  integrationId: string,
  syncRunId: string,
): Promise<boolean> {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { configuration: true },
  });
  return asSyncConfiguration(integration?.configuration).activeSyncRunId === syncRunId;
}

export async function updateCurrentSyncRun(
  prisma: PrismaClient,
  integrationId: string,
  syncRunId: string,
  patch: SyncConfiguration,
): Promise<boolean> {
  const updated = await withCurrentSyncRunTransaction(
    prisma,
    integrationId,
    syncRunId,
    async (tx, configuration) => {
      await tx.integration.update({
        where: { id: integrationId },
        data: {
          configuration: {
            ...configuration,
            ...patch,
            activeSyncRunId: syncRunId,
          } as Prisma.InputJsonValue,
        },
      });
    },
  );
  return updated.current;
}

export async function failCurrentSyncRun(
  prisma: PrismaClient,
  integrationId: string,
  syncRunId: string,
  errorCode: string,
): Promise<boolean> {
  return updateCurrentSyncRun(prisma, integrationId, syncRunId, {
    initialSyncStatus: 'FAILED',
    continuationCursor: null,
    continuationPage: null,
    lastSyncErrorCode: errorCode,
    lastSyncFailedAt: new Date().toISOString(),
  });
}
