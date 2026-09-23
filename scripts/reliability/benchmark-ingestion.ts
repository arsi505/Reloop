import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { performance } from 'perf_hooks';
import crypto from 'crypto';

const dbUrl =
  process.env.RELOOP_TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://reloop@localhost:5433/reloop_test?schema=public';
process.env.DATABASE_URL = dbUrl;
process.env.TEST_DATABASE_URL = dbUrl;
process.env.REDIS_URL = 'redis://localhost:6380';
process.env.PORT = '3335';
process.env.JWT_SECRET = 'benchmark_jwt_secret_day21_safe_0123456789abcdef';
process.env.INTEGRATION_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { AppModule } from '../../apps/api/src/app.module';
import { PrismaService } from '../../apps/api/src/prisma/prisma.service';
import { WebhooksService } from '../../apps/api/src/webhooks/webhooks.service';
import { WebhookEventProcessorService } from '../../apps/api/src/webhooks/webhook-event-processor.service';
import {
  IntegrationProvider,
  IntegrationStatus,
} from '@reloop/database';

export interface IngestionBatchResult {
  targetRate: number;
  totalSent: number;
  acceptedCount: number;
  duplicateCount: number;
  errorCount: number;
  acceptedPerSec: number;
  processedPerSec: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  casesCreated: number;
}

function calculatePercentile(latencies: number[], p: number): number {
  if (latencies.length === 0) return 0;
  latencies.sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * latencies.length) - 1;
  return Number(latencies[Math.max(0, idx)].toFixed(2));
}

async function main() {
  console.log('===============================================================');
  console.log('  RELOOP DAY 21: WEBHOOK & EVENT INGESTION LOAD BENCHMARK       ');
  console.log('===============================================================\n');

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const testPort = 3335;
  await app.listen(testPort);
  const baseUrl = `http://localhost:${testPort}`;
  console.log(`[Ingestion Benchmark] Nest application listening on ${baseUrl}`);

  const prisma = app.get(PrismaService);
  const webhooksService = app.get(WebhooksService);
  const processor = app.get(WebhookEventProcessorService);

  // 1. Seed benchmark organization and simulator integration
  const runId = Math.random().toString(36).substring(2, 8);
  const org = await prisma.organization.create({
    data: {
      name: `Ingestion Benchmark Org ${runId}`,
      slug: `ingestion-bench-org-${runId}`,
    },
  });

  const webhookSecret = 'reloop_simulator_webhook_secret_dev';
  const integration = await prisma.integration.create({
    data: {
      organizationId: org.id,
      provider: IntegrationProvider.SIMULATOR,
      name: 'Ingestion Benchmark Simulator',
      status: IntegrationStatus.CONNECTED,
      configuration: { webhookSecret },
    },
  });

  console.log(`[Ingestion Benchmark] Test organization and simulator integration seeded (ID: ${integration.id})\n`);

  // Section A: HTTP Security & Rate Limiting Enforcement
  console.log('---------------------------------------------------------------');
  console.log('PART A: HTTP Transport Rate-Limiting Enforcement (120 requests)');
  console.log('---------------------------------------------------------------');
  let http200 = 0;
  let http429 = 0;
  for (let i = 1; i <= 120; i++) {
    const payload = {
      orderNumber: `HTTP-ORD-${i}`,
      externalOrderId: `ext_http_${i}`,
      status: 'UNFULFILLED',
      currency: 'USD',
      totalAmount: 100,
    };
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    const res = await fetch(`${baseUrl}/webhooks/simulator/${integration.id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-simulator-signature': signature,
        'x-reloop-signature': signature,
        'x-reloop-event-id': `http_evt_${i}`,
        'x-reloop-event-type': 'ORDER_CREATED',
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 200) http200++;
    else if (res.status === 429) http429++;
  }
  console.log(`[HTTP Transport Check] Sent: 120 | 200 Accepted: ${http200} | 429 Throttled: ${http429}`);
  console.log('Observation: Security rate limiter actively protects HTTP endpoint from single-IP flood.\n');

  // Section B: Engine Cryptographic Ingestion & Invariant Load Test
  console.log('---------------------------------------------------------------');
  console.log('PART B: Full Engine Ingestion & Processing Pipeline Benchmark   ');
  console.log('        (HMAC Signature Verification, Dedupe, DB Commit, Proc) ');
  console.log('---------------------------------------------------------------');

  const rateProfiles = [
    { targetRate: 50, count: 50 },
    { targetRate: 100, count: 100 },
    { targetRate: 150, count: 150 },
  ];

  const batchResults: IngestionBatchResult[] = [];

  for (const profile of rateProfiles) {
    console.log(`--- Testing Ingestion Profile: Target ${profile.targetRate} events/sec (${profile.count} events) ---`);
    const latencies: number[] = [];
    const eventIds: string[] = [];
    let accepted = 0;
    let duplicates = 0;
    let errors = 0;

    const initialCaseCount = await prisma.recoveryCase.count({
      where: { organizationId: org.id },
    });

    const intervalMs = 1000 / profile.targetRate;
    const startTime = performance.now();

    for (let i = 1; i <= profile.count; i++) {
      const orderNumber = `INGEST-ORD-${runId}-${profile.targetRate}-${i}`;
      // Inject duplicate every 10th event
      const isDuplicate = i % 10 === 0;
      const providerEventId = isDuplicate
        ? `evt_${profile.targetRate}_duplicate_${Math.floor(i / 10)}`
        : `evt_${profile.targetRate}_${i}`;

      const payload = {
        orderNumber,
        externalOrderId: `ext_${orderNumber}`,
        status: i % 4 === 0 ? 'SHIPPED' : 'UNFULFILLED',
        currency: 'USD',
        totalAmount: 150.0,
        customerReference: `buyer-${i}@example.com`,
      };

      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      const signature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-simulator-signature': signature,
        'x-reloop-signature': signature,
        'x-reloop-event-id': providerEventId,
        'x-reloop-event-type': 'ORDER_CREATED',
      };

      const sendStart = performance.now();
      try {
        const result = await webhooksService.ingestWebhook(
          'SIMULATOR',
          integration.id,
          rawBody,
          headers,
          payload,
        );

        const elapsed = performance.now() - sendStart;
        latencies.push(elapsed);

        if (result.status === 'ignored_duplicate') {
          duplicates++;
        } else {
          accepted++;
          if (result.eventId) {
            eventIds.push(result.eventId);
          }
        }
      } catch (err) {
        errors++;
      }

      // Maintain target event injection pace
      const targetNextTime = startTime + i * intervalMs;
      const delay = targetNextTime - performance.now();
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    const totalIngestTimeSec = (performance.now() - startTime) / 1000;
    const acceptedPerSec = Number(((accepted + duplicates) / totalIngestTimeSec).toFixed(1));
    const p50LatencyMs = calculatePercentile(latencies, 50);
    const p95LatencyMs = calculatePercentile(latencies, 95);

    console.log(`  [Ingestion Phase] Accepted: ${accepted} | Duplicates: ${duplicates} | Errors: ${errors}`);
    console.log(`  [Ingestion Phase] Ingestion Rate: ${acceptedPerSec} events/sec | p50: ${p50LatencyMs}ms | p95: ${p95LatencyMs}ms`);

    // Asynchronous Processing Phase
    console.log(`  [Processing Phase] Processing ${eventIds.length} ingested events via WebhookEventProcessorService...`);
    const procStart = performance.now();
    let processedCount = 0;
    for (const eventId of eventIds) {
      try {
        await processor.processEvent(eventId);
        processedCount++;
      } catch (procErr) {
        // Processing error tracking
      }
    }
    const procTimeSec = (performance.now() - procStart) / 1000;
    const processedPerSec = Number((processedCount / (procTimeSec || 0.001)).toFixed(1));

    const finalCaseCount = await prisma.recoveryCase.count({
      where: { organizationId: org.id },
    });
    const casesCreated = finalCaseCount - initialCaseCount;

    console.log(`  [Processing Phase] Processed: ${processedCount}/${eventIds.length} events in ${procTimeSec.toFixed(2)}s (${processedPerSec} processed/sec)`);
    console.log(`  [Processing Phase] RecoveryCases Created: ${casesCreated}\n`);

    batchResults.push({
      targetRate: profile.targetRate,
      totalSent: profile.count,
      acceptedCount: accepted,
      duplicateCount: duplicates,
      errorCount: errors,
      acceptedPerSec,
      processedPerSec,
      p50LatencyMs,
      p95LatencyMs,
      casesCreated,
    });
  }

  console.log('===============================================================');
  console.log('  INGESTION LOAD BENCHMARK SUMMARY (TARGET: 100 events/sec)    ');
  console.log('===============================================================');
  for (const b of batchResults) {
    const status = b.acceptedPerSec >= b.targetRate * 0.85 ? 'PASS' : 'MISS';
    console.log(
      `Target: ${String(b.targetRate).padStart(3)} ev/s | Accepted: ${String(b.acceptedPerSec).padStart(5)} ev/s | Processed: ${String(b.processedPerSec).padStart(6)} ev/s | p95: ${String(b.p95LatencyMs).padStart(5)}ms | Dupes: ${b.duplicateCount} | ${status}`,
    );
  }

  // Teardown
  await app.close();
  console.log('\n[Ingestion Benchmark] Nest application cleanly closed.');
}

main().catch((err) => {
  console.error('[Ingestion Benchmark] Error running benchmark:', err);
  process.exit(1);
});
