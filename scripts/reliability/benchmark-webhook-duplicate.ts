import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { PrismaClient, IntegrationStatus } from '@prisma/client';
import { SimulatorWebhookAdapter } from '@reloop/connector-simulator';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from '../../apps/api/src/app.module';

const dbUrl =
  process.env.RELOOP_TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://reloop@localhost:5433/reloop_test?schema=public';
process.env.DATABASE_URL = dbUrl;
process.env.TEST_DATABASE_URL = dbUrl;
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'benchmark_jwt_secret_day21_safe_0123456789abcdef';
process.env.INTEGRATION_ENCRYPTION_KEY =
  process.env.INTEGRATION_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

async function main() {
  console.log('===============================================================');
  console.log('  RELOOP DAY 21: WEBHOOK DUPLICATE DETERMINISTIC DRILL         ');
  console.log('===============================================================\n');

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await prisma.$connect();

  const runId = Math.random().toString(36).substring(2, 8);
  const org = await prisma.organization.create({
    data: {
      name: `Webhook Duplicate Org ${runId}`,
      slug: `webhook-dupe-org-${runId}`,
    },
  });

  const testSecret = 'reloop_test_webhook_secret_dev_123';
  const integration = await prisma.integration.create({
    data: {
      organizationId: org.id,
      provider: 'SIMULATOR',
      status: IntegrationStatus.CONNECTED,
      name: 'Simulator Test Connection',
      configuration: { webhookSecret: testSecret },
    },
  });

  // Disable ThrottlerGuard directly on prototype for this benchmark script
  ThrottlerGuard.prototype.canActivate = async () => true;

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app: INestApplication = moduleFixture.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.init();

  const adapter = new SimulatorWebhookAdapter();
  const orderNumber = `ORD-DUPE-TEST-${runId}`;
  const payload = {
    orderNumber,
    externalOrderId: `ext_${orderNumber}`,
    status: 'PAID',
    currency: 'USD',
    totalAmount: 99.99,
  };
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = adapter.signPayload(rawBody, testSecret);
  const providerEventId = `evt_dupe_${runId}_${Date.now()}`;

  const concurrentDeliveries = 20;
  console.log(`[Webhook Duplicate Drill] Dispatching ${concurrentDeliveries} concurrent identical deliveries...`);

  const deliveryPromises = Array.from({ length: concurrentDeliveries }, () =>
    request(app.getHttpServer())
      .post(`/webhooks/simulator/${integration.id}`)
      .set('Content-Type', 'application/json')
      .set('x-reloop-signature', signature)
      .set('x-reloop-event-id', providerEventId)
      .set('x-reloop-event-type', 'ORDER_CREATED')
      .send(payload),
  );

  const responses = await Promise.all(deliveryPromises);

  const acceptedResponses = responses.filter((r) => r.body?.status === 'accepted');
  const duplicateResponses = responses.filter((r) => r.body?.status === 'ignored_duplicate');

  const statusMap: Record<string, number> = {};
  for (const r of responses) {
    const key = `${r.status}: ${r.body?.status || JSON.stringify(r.body)}`;
    statusMap[key] = (statusMap[key] || 0) + 1;
  }
  console.log('[Webhook Responses Distribution]:', statusMap);

  // Allow in-flight processing to settle
  await new Promise((r) => setTimeout(r, 1000));

  // Count durable IntegrationEvent records created in PostgreSQL
  const integrationEventsCount = await prisma.integrationEvent.count({
    where: { integrationId: integration.id, providerEventId },
  });

  // Count ExternalOrder rows created downstream
  const externalOrdersCount = await prisma.externalOrder.count({
    where: { organizationId: org.id, externalOrderNumber: orderNumber },
  });

  // Count RecoveryCases created downstream
  const recoveryCasesCount = await prisma.recoveryCase.count({
    where: { organizationId: org.id },
  });

  const duplicateBusinessEffects = externalOrdersCount > 1 ? externalOrdersCount - 1 : 0;

  console.log('\n===============================================================');
  console.log('  WEBHOOK DUPLICATE DETERMINISTIC DRILL RESULTS                ');
  console.log('===============================================================');
  console.log(`Deliveries Sent:                     ${concurrentDeliveries}`);
  console.log(`Requests Accepted:                   ${acceptedResponses.length}`);
  console.log(`Duplicate Responses:                 ${duplicateResponses.length}`);
  console.log(`IntegrationEvent Rows Created:       ${integrationEventsCount} (Target: 1)`);
  console.log(`Downstream Executions (Orders):      ${externalOrdersCount}`);
  console.log(`RecoveryCases Created:               ${recoveryCasesCount}`);
  console.log(`Duplicate Business Effects:          ${duplicateBusinessEffects} (MUST BE 0)`);
  console.log(
    `Verdict:                             ${
      acceptedResponses.length === 1 &&
      duplicateResponses.length === 19 &&
      integrationEventsCount === 1 &&
      duplicateBusinessEffects === 0
        ? 'PASS'
        : 'FAIL'
    }`,
  );
  console.log('===============================================================\n');

  await app.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[Webhook Duplicate Drill] Error:', err);
  process.exit(1);
});
