import 'reflect-metadata';
import path from 'path';
import dotenv from 'dotenv';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import Redis from 'ioredis';
import {
  JobStatus,
  PrismaClient,
  RecoveryCaseStatus,
  RecoveryCaseType,
  WorkflowStepStatus,
  WorkflowStatus,
} from '@prisma/client';
import { AppModule as SimulatorAppModule } from '../../simulator/src/app.module';
import {
  createSchedulerRuntime,
  SchedulerRuntime,
} from '../src/runtime';
import {
  createWorkerRuntime,
  WorkerRuntime,
} from '../../worker/src/runtime';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://reloop_app:change_me@localhost:5433/reloop_test?schema=public';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
const DURABLE_STATE_WAIT_TIMEOUT_MS = 20_000;
const PRODUCTION_COMPOSITION_TEST_TIMEOUT_MS = DURABLE_STATE_WAIT_TIMEOUT_MS + 5_000;

interface TestContext {
  organizationId: string;
  orderNumber: string;
  trackingNumber: string;
  streamKey: string;
  groupKey: string;
  workerKey: string;
  scheduler?: SchedulerRuntime;
  worker?: WorkerRuntime;
}

describe('N-01 production recovery composition', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let simulatorApp: INestApplication;
  let simulatorBaseUrl: string;
  let context: TestContext | undefined;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: testDatabaseUrl } },
    });
    await prisma.$connect();
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

    simulatorApp = await NestFactory.create(SimulatorAppModule, {
      logger: false,
    });
    await simulatorApp.listen(0, '127.0.0.1');
    simulatorBaseUrl = await simulatorApp.getUrl();
  });

  afterAll(async () => {
    await simulatorApp?.close();
    await redis?.quit().catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
  });

  afterEach(async () => {
    if (!context) return;

    await context.worker?.stop().catch(() => undefined);
    await context.scheduler?.stop().catch(() => undefined);

    const jobs = await prisma.job.findMany({
      where: { organizationId: context.organizationId },
      select: { id: true },
    });
    if (jobs.length > 0) {
      await redis.del(
        ...jobs.map((job) => `reloop:dispatch:${job.id}`),
      );
    }
    await redis.del(context.streamKey);

    await prisma.jobAttempt.deleteMany({
      where: { job: { organizationId: context.organizationId } },
    });
    await prisma.job.deleteMany({
      where: { organizationId: context.organizationId },
    });
    await prisma.approval.deleteMany({
      where: { organizationId: context.organizationId },
    });
    await prisma.workflowStep.deleteMany({
      where: { organizationId: context.organizationId },
    });
    await prisma.workflow.deleteMany({
      where: { organizationId: context.organizationId },
    });
    await prisma.recoveryCase.deleteMany({
      where: { organizationId: context.organizationId },
    });
    await prisma.externalReference.deleteMany({
      where: { organizationId: context.organizationId },
    });
    await prisma.externalOrder.deleteMany({
      where: { organizationId: context.organizationId },
    });
    await prisma.integrationEvent.deleteMany({
      where: { organizationId: context.organizationId },
    });
    await prisma.integration.deleteMany({
      where: { organizationId: context.organizationId },
    });
    await prisma.organization.delete({
      where: { id: context.organizationId },
    });
    await prisma.worker.deleteMany({
      where: { workerKey: context.workerKey },
    });
    await requestJson('/_simulator/reset', { method: 'POST' });
    context = undefined;
  });

  it('detects, routes, dispatches, mutates, verifies, and resolves through production factories', async () => {
    context = await createContext('success');
    await seedTrackingDiscrepancy(context.orderNumber, context.trackingNumber);
    await createExternalOrder(context.organizationId, context.orderNumber);
    composeProductionRuntimes(context);

    await context.worker!.start();
    await context.scheduler!.start();

    const recoveryCase = await waitFor(async () =>
      prisma.recoveryCase.findFirst({
        where: {
          organizationId: context!.organizationId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
        },
      }),
    );
    expect(recoveryCase.externalOrderId).not.toBeNull();

    const resolvedCase = await waitFor(async () => {
      const current = await prisma.recoveryCase.findUnique({
        where: { id: recoveryCase.id },
      });
      return current?.status === RecoveryCaseStatus.RESOLVED
        ? current
        : null;
    });
    expect(resolvedCase.resolvedAt).not.toBeNull();

    const workflow = await prisma.workflow.findFirstOrThrow({
      where: { recoveryCaseId: recoveryCase.id },
      include: {
        steps: { orderBy: { position: 'asc' } },
        jobs: { include: { attempts: true } },
      },
    });
    expect(workflow.status).toBe(WorkflowStatus.SUCCEEDED);
    expect(workflow.jobs).toHaveLength(3);
    expect(workflow.jobs.every((job) => job.status === JobStatus.SUCCEEDED)).toBe(true);
    expect(workflow.jobs.every((job) => job.attempts.length === 1)).toBe(true);

    const verifyStep = workflow.steps.find((step) => step.key === 'VERIFY');
    expect(verifyStep?.status).toBe(WorkflowStepStatus.SUCCEEDED);
    expect(verifyStep?.output).toMatchObject({
      verified: true,
      invariantPassed: 'TRACKING_CONSISTENCY',
    });

    const shopifyOrder = await requestJson<{ trackingNumber?: string }>(
      `/shopify/orders/${encodeURIComponent(context.orderNumber)}`,
    );
    const warehouseOrder = await requestJson<{ trackingNumber?: string }>(
      `/3pl/orders/search?orderNumber=${encodeURIComponent(context.orderNumber)}`,
    );
    expect(shopifyOrder.trackingNumber).toBe(context.trackingNumber);
    expect(shopifyOrder.trackingNumber).toBe(warehouseOrder.trackingNumber);
  });

  it('does not resolve when the simulator returns success without changing authoritative state', async () => {
    context = await createContext('wrong-state');
    await seedTrackingDiscrepancy(context.orderNumber, context.trackingNumber);
    await createExternalOrder(context.organizationId, context.orderNumber);
    await requestJson('/_simulator/faults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fault: 'SUCCESS_WITHOUT_COMMIT',
        provider: 'shopify',
        method: 'PATCH',
        pathPattern: '/shopify/orders/',
        remainingCount: 1,
      }),
    });
    composeProductionRuntimes(context);

    await context.worker!.start();
    await context.scheduler!.start();

    const outcome = await waitFor(async () => {
      const recoveryCase = await prisma.recoveryCase.findFirst({
        where: {
          organizationId: context!.organizationId,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
        },
      });
      if (!recoveryCase) return null;

      const step = await prisma.workflowStep.findFirst({
        where: {
          workflow: { recoveryCaseId: recoveryCase.id },
          key: 'VERIFY',
        },
      });
      return step?.status === WorkflowStepStatus.FAILED
        ? { recoveryCase, verifyStep: step }
        : null;
    }, DURABLE_STATE_WAIT_TIMEOUT_MS);
    const { recoveryCase, verifyStep } = outcome;
    expect(verifyStep.status).toBe(WorkflowStepStatus.FAILED);

    const executeStep = await prisma.workflowStep.findFirstOrThrow({
      where: {
        workflow: { recoveryCaseId: recoveryCase.id },
        key: 'EXECUTE',
      },
    });
    expect(executeStep.status).toBe(WorkflowStepStatus.SUCCEEDED);

    const finalCase = await prisma.recoveryCase.findUniqueOrThrow({
      where: { id: recoveryCase.id },
    });
    expect(finalCase.status).not.toBe(RecoveryCaseStatus.RESOLVED);
    expect(finalCase.resolvedAt).toBeNull();

    const shopifyOrder = await requestJson<{ trackingNumber?: string }>(
      `/shopify/orders/${encodeURIComponent(context.orderNumber)}`,
    );
    expect(shopifyOrder.trackingNumber).toBeUndefined();
  }, PRODUCTION_COMPOSITION_TEST_TIMEOUT_MS);

  async function createContext(suffix: string): Promise<TestContext> {
    const runId = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const organization = await prisma.organization.create({
      data: {
        name: `N-01 ${runId}`,
        slug: `n01-${runId}`,
      },
    });
    return {
      organizationId: organization.id,
      orderNumber: `ORD-N01-${runId}`,
      trackingNumber: `TRK-N01-${runId}`,
      streamKey: `reloop:test:n01:${runId}:jobs`,
      groupKey: `n01-group-${runId}`,
      workerKey: `n01-worker-${runId}`,
    };
  }

  function composeProductionRuntimes(current: TestContext): void {
    current.scheduler = createSchedulerRuntime({
      prisma,
      config: {
        redisUrl,
        simulatorBaseUrl,
        jobStreamKey: current.streamKey,
        jobConsumerGroup: current.groupKey,
        schedulerIntervalMs: 25,
        workflowScanIntervalMs: 25,
        reconciliationScanIntervalMs: 25,
        recoveryRouterScanIntervalMs: 25,
        dispatchMarkerTtlMs: 250,
      },
    });
    current.worker = createWorkerRuntime({
      prisma,
      config: {
        redisUrl,
        simulatorBaseUrl,
        jobStreamKey: current.streamKey,
        jobConsumerGroup: current.groupKey,
        workerConsumerName: current.workerKey,
        workerKey: current.workerKey,
        workerConcurrency: 1,
        blockTimeoutMs: 100,
        workerRecoveryScanIntervalMs: 100,
      },
    });
  }

  async function createExternalOrder(
    organizationId: string,
    orderNumber: string,
  ): Promise<void> {
    await prisma.externalOrder.create({
      data: {
        organizationId,
        externalOrderNumber: orderNumber,
        status: 'FULFILLING',
      },
    });
  }

  async function seedTrackingDiscrepancy(
    orderNumber: string,
    trackingNumber: string,
  ): Promise<void> {
    await requestJson('/_simulator/reset', { method: 'POST' });
    const now = new Date().toISOString();
    const customer = { name: 'N-01 Customer', email: 'n01@example.com' };
    const shippingAddress = {
      street: '1 Production Way',
      city: 'Seattle',
      state: 'WA',
      postalCode: '98101',
      country: 'US',
    };
    const lineItems = [
      { sku: 'SKU-N01', name: 'Production Composition Item', quantity: 1, price: 42 },
    ];

    await requestJson('/shopify/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: `shp-${orderNumber}`,
        orderNumber,
        customer,
        shippingAddress,
        lineItems,
        paymentStatus: 'PAID',
        fulfillmentStatus: 'UNFULFILLED',
        createdAt: now,
      }),
    });
    await requestJson('/3pl/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: `wh-${orderNumber}`,
        orderNumber,
        externalReference: orderNumber,
        customer,
        shippingAddress,
        lineItems,
        status: 'PACKED',
        trackingNumber,
        carrier: 'UPS',
        createdAt: now,
      }),
    });
  }

  async function requestJson<T = unknown>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const response = await fetch(`${simulatorBaseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`Simulator request ${path} failed with HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async function waitFor<T>(
    operation: () => Promise<T | null | undefined>,
    timeoutMs = DURABLE_STATE_WAIT_TIMEOUT_MS,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await operation();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Condition was not met within ${timeoutMs}ms`);
  }
});
