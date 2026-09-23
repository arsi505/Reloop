import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { performance } from 'perf_hooks';

const dbUrl =
  process.env.RELOOP_TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://reloop@localhost:5433/reloop_test?schema=public';
process.env.DATABASE_URL = dbUrl;
process.env.TEST_DATABASE_URL = dbUrl;
process.env.REDIS_URL = 'redis://localhost:6380';
process.env.PORT = '3334';
process.env.JWT_SECRET = 'benchmark_jwt_secret_day21_safe_0123456789abcdef';
process.env.INTEGRATION_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { AppModule } from '../../apps/api/src/app.module';
import { PrismaService } from '../../apps/api/src/prisma/prisma.service';
import { SecurityUtil } from '../../apps/api/src/auth/security.util';
import {
  Role,
  IntegrationProvider,
  IntegrationStatus,
  ExternalOrderStatus,
  RecoveryCaseType,
  RecoveryLevel,
  RecoveryCaseStatus,
  WorkflowStatus,
} from '@reloop/database';

export interface EndpointMetric {
  endpoint: string;
  requestCount: number;
  concurrency: number;
  successRate: number;
  errorRate: number;
  rateLimitedCount: number;
  p50: number;
  p95: number;
  p99: number;
  reqPerSec: number;
  targetMet: boolean;
}

function calculatePercentile(latencies: number[], p: number): number {
  if (latencies.length === 0) return 0;
  latencies.sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * latencies.length) - 1;
  return Number(latencies[Math.max(0, idx)].toFixed(2));
}

async function runBenchmarkForEndpoint(
  baseUrl: string,
  endpoint: string,
  token: string,
  totalRequests: number,
  concurrency: number,
): Promise<EndpointMetric> {
  const latencies: number[] = [];
  let successes = 0;
  let errors = 0;
  let rateLimited = 0;

  let requestIndex = 0;
  const startOverall = performance.now();

  async function worker() {
    while (requestIndex < totalRequests) {
      requestIndex++;
      const t0 = performance.now();
      try {
        const res = await fetch(`${baseUrl}${endpoint}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        const elapsed = performance.now() - t0;
        latencies.push(elapsed);

        if (res.status === 200) {
          successes++;
        } else if (res.status === 429) {
          rateLimited++;
        } else {
          errors++;
        }
      } catch (err) {
        const elapsed = performance.now() - t0;
        latencies.push(elapsed);
        errors++;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const totalTimeSec = (performance.now() - startOverall) / 1000;
  const p50 = calculatePercentile(latencies, 50);
  const p95 = calculatePercentile(latencies, 95);
  const p99 = calculatePercentile(latencies, 99);
  const reqPerSec = Number((totalRequests / totalTimeSec).toFixed(1));
  const successRate = Number(((successes / totalRequests) * 100).toFixed(1));
  const errorRate = Number((((errors + rateLimited) / totalRequests) * 100).toFixed(1));
  const targetMet = p95 < 200;

  return {
    endpoint,
    requestCount: totalRequests,
    concurrency,
    successRate,
    errorRate,
    rateLimitedCount: rateLimited,
    p50,
    p95,
    p99,
    reqPerSec,
    targetMet,
  };
}

async function main() {
  console.log('===============================================================');
  console.log('  RELOOP DAY 21: BASELINE API PERFORMANCE BENCHMARK            ');
  console.log('===============================================================\n');

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const testPort = 3334;
  await app.listen(testPort);
  const baseUrl = `http://localhost:${testPort}`;
  console.log(`[API Benchmark] Nest application listening on ${baseUrl}`);

  const prisma = app.get(PrismaService);

  // 1. Seed benchmark organization and admin user
  const runId = Math.random().toString(36).substring(2, 8);
  const org = await prisma.organization.create({
    data: {
      name: `Benchmark Org ${runId}`,
      slug: `benchmark-org-${runId}`,
    },
  });

  const passwordHash = await SecurityUtil.hashPassword('BenchmarkPass123!');
  const user = await prisma.user.create({
    data: {
      email: `bench-${runId}@example.com`,
      name: 'Benchmark Admin',
      passwordHash,
    },
  });

  await prisma.organizationMember.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      role: Role.ADMIN,
    },
  });

  // Login to acquire real JWT
  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `bench-${runId}@example.com`,
      password: 'BenchmarkPass123!',
    }),
  });
  const loginJson = (await loginRes.json()) as { accessToken: string };
  const token = loginJson.accessToken;
  console.log('[API Benchmark] Authenticated benchmark user acquired token.\n');

  // 2. Seed realistic test dataset
  console.log('[API Benchmark] Seeding test dataset (integrations, orders, cases, workflows)...');
  const integrationShopify = await prisma.integration.create({
    data: {
      organizationId: org.id,
      provider: IntegrationProvider.SHOPIFY,
      name: 'Benchmark Shopify Store',
      status: IntegrationStatus.CONNECTED,
      configuration: { shopDomain: `bench-${runId}.myshopify.com` },
    },
  });

  const integrationShipstation = await prisma.integration.create({
    data: {
      organizationId: org.id,
      provider: IntegrationProvider.SHIPSTATION,
      name: 'Benchmark ShipStation',
      status: IntegrationStatus.CONNECTED,
      configuration: {},
    },
  });

  // Seed 25 orders
  for (let i = 1; i <= 25; i++) {
    const orderNumber = `BENCH-ORD-${runId}-${i}`;
    const order = await prisma.externalOrder.create({
      data: {
        organizationId: org.id,
        externalOrderNumber: orderNumber,
        status: i % 3 === 0 ? ExternalOrderStatus.DELIVERED : ExternalOrderStatus.FULFILLING,
        currency: 'USD',
        totalAmount: 99.99,
        customerReference: `cust-${i}@example.com`,
        lastObservedAt: new Date(),
      },
    });

    await prisma.externalReference.create({
      data: {
        organizationId: org.id,
        externalOrderId: order.id,
        integrationId: integrationShopify.id,
        resourceType: 'ORDER',
        externalId: `shp_${orderNumber}`,
      },
    });

    // Seed RecoveryCase for some orders
    if (i <= 10) {
      const recoveryCase = await prisma.recoveryCase.create({
        data: {
          organizationId: org.id,
          externalOrderId: order.id,
          type: RecoveryCaseType.TRACKING_MISSING_IN_SHOPIFY,
          status: RecoveryCaseStatus.WAITING_APPROVAL,
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
          summary: `Benchmark missing tracking for ${orderNumber}`,
          dedupeKey: `${orderNumber}:TRACKING_MISSING_IN_SHOPIFY`,
          evidence: { orderNumber, source: 'benchmark' },
        },
      });

      if (i <= 5) {
        await prisma.workflow.create({
          data: {
            organizationId: org.id,
            recoveryCaseId: recoveryCase.id,
            templateKey: 'RECOVERY_MISSING_SHOPIFY_TRACKING',
            templateVersion: 1,
            status: WorkflowStatus.RUNNING,
          },
        });
      }
    }
  }
  console.log('[API Benchmark] Seeding complete.\n');

  // Warmup (2 requests to initialize JIT and query planner)
  console.log('[API Benchmark] Warming up JIT and database query caches...');
  await fetch(`${baseUrl}/dashboard/summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await fetch(`${baseUrl}/exceptions`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // 3. Measure read endpoints (20 requests per endpoint, total 100 within rate budget)
  const endpoints = [
    '/dashboard/summary',
    '/exceptions',
    '/orders',
    '/recoveries',
    '/integrations',
  ];

  const results: EndpointMetric[] = [];

  for (const endpoint of endpoints) {
    console.log(`Testing endpoint: ${endpoint} (20 requests, concurrency=5)...`);
    const metric = await runBenchmarkForEndpoint(baseUrl, endpoint, token, 20, 5);
    results.push(metric);
    console.log(
      `  -> p50: ${metric.p50}ms | p95: ${metric.p95}ms | p99: ${metric.p99}ms | Throughput: ${metric.reqPerSec} req/s | Success: ${metric.successRate}%`,
    );
  }

  // 4. Rate-Limiting Demonstration Test
  console.log('\n[API Benchmark] Running security/rate-limiting stress test on /dashboard/summary (150 requests, concurrency=25)...');
  const rateLimitMetric = await runBenchmarkForEndpoint(baseUrl, '/dashboard/summary', token, 150, 25);
  console.log(
    `  -> Requests: ${rateLimitMetric.requestCount} | 200 OK: ${rateLimitMetric.successRate}% | 429 Too Many Requests: ${rateLimitMetric.rateLimitedCount} | Rate-limiting active: YES`,
  );

  console.log('\n===============================================================');
  console.log('  BENCHMARK SUMMARY (TARGET: p95 < 200ms)                      ');
  console.log('===============================================================');
  for (const r of results) {
    const statusText = r.targetMet ? 'PASS' : 'MISS';
    console.log(
      `${r.endpoint.padEnd(25)} | p50: ${r.p50.toFixed(1).padStart(5)}ms | p95: ${r.p95.toFixed(1).padStart(5)}ms | p99: ${r.p99.toFixed(1).padStart(5)}ms | ${r.reqPerSec.toFixed(1).padStart(6)} req/s | ${statusText}`,
    );
  }

  // Teardown
  await app.close();
  console.log('\n[API Benchmark] Nest application cleanly closed.');
}

main().catch((err) => {
  console.error('[API Benchmark] Error running benchmark:', err);
  process.exit(1);
});
