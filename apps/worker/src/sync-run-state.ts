import { Prisma, PrismaClient } from '@prisma/client';

export type SyncConfiguration = Record<string, unknown>;

export function asSyncConfiguration(value: unknown): SyncConfiguration {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as SyncConfiguration)
    : {};
}

export async function establishSyncRun(
  prisma: PrismaClient,
  integrationId: string,
  configuredRunId: unknown,
  fallbackRunId: string,
): Promise<{ syncRunId: string; current: boolean; configuration: SyncConfiguration }> {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { configuration: true },
  });
  const configuration = asSyncConfiguration(integration?.configuration);
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
  await prisma.integration.update({
    where: { id: integrationId },
    data: { configuration: nextConfiguration as Prisma.InputJsonValue },
  });
  return { syncRunId, current: true, configuration: nextConfiguration };
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
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { configuration: true },
  });
  const configuration = asSyncConfiguration(integration?.configuration);
  if (configuration.activeSyncRunId !== syncRunId) {
    return false;
  }

  const updated = await prisma.integration.updateMany({
    where: {
      id: integrationId,
      configuration: {
        path: ['activeSyncRunId'],
        equals: syncRunId,
      },
    },
    data: {
      configuration: {
        ...configuration,
        ...patch,
        activeSyncRunId: syncRunId,
      } as Prisma.InputJsonValue,
    },
  });
  return updated.count === 1;
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
