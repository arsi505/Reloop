import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { execSync } from 'child_process';
import { AppModule } from '../../apps/api/src/app.module';

function run(cmd: string) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
}

function waitForPostgres(maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      run('docker exec reloop-postgres pg_isready -U reloop -d reloop');
      return true;
    } catch {
      run('node -e "setTimeout(() => {}, 1000)"');
    }
  }
  throw new Error('PostgreSQL did not become ready in time');
}

function waitForRedis(maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = run('docker exec reloop-redis redis-cli ping').trim();
      if (res === 'PONG') return true;
    } catch {
      run('node -e "setTimeout(() => {}, 1000)"');
    }
  }
  throw new Error('Redis did not become ready in time');
}

async function main() {
  console.log('=== HEALTH ENDPOINT ACTUAL BEHAVIOR VERIFICATION ===\n');

  // Compile NestJS app
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app: INestApplication = moduleRef.createNestApplication();
  await app.init();
  const server = app.getHttpServer();

  try {
    // -------------------------------------------------------------
    // Test A: Both PostgreSQL and Redis available
    // -------------------------------------------------------------
    console.log('[Test A] Testing /health with PostgreSQL and Redis UP...');
    const resA = await request(server).get('/health');
    console.log(`  HTTP Status: ${resA.status}`);
    console.log(`  Payload: ${JSON.stringify(resA.body)}`);

    if (
      resA.status !== 200 ||
      resA.body.status !== 'ok' ||
      resA.body.components?.database?.status !== 'ok' ||
      resA.body.components?.redis?.status !== 'ok'
    ) {
      throw new Error(`Test A FAILED: Expected 200 ok, got ${resA.status}`);
    }
    console.log('  [PASS] Test A: HTTP 200 with DB and Redis healthy.\n');

    // -------------------------------------------------------------
    // Test B: PostgreSQL temporarily unavailable
    // -------------------------------------------------------------
    console.log('[Test B] Temporarily stopping PostgreSQL container...');
    run('docker stop reloop-postgres');
    try {
      console.log('  Querying /health while PostgreSQL is DOWN...');
      const resB = await request(server).get('/health');
      console.log(`  HTTP Status: ${resB.status}`);
      console.log(`  Payload: ${JSON.stringify(resB.body)}`);

      if (
        resB.status !== 503 ||
        resB.body.status === 'ok' ||
        resB.body.components?.database?.status !== 'down'
      ) {
        throw new Error(`Test B FAILED: Expected 503 with database down, got ${resB.status}`);
      }
      console.log('  [PASS] Test B: HTTP 503 with database down verified.');
    } finally {
      console.log('  Restoring PostgreSQL container immediately...');
      run('docker start reloop-postgres');
      waitForPostgres();
      console.log('  PostgreSQL container restored and healthy.\n');
    }

    // -------------------------------------------------------------
    // Test C: Redis temporarily unavailable
    // -------------------------------------------------------------
    console.log('[Test C] Temporarily stopping Redis container...');
    run('docker stop reloop-redis');
    try {
      console.log('  Querying /health while Redis is DOWN...');
      const resC = await request(server).get('/health');
      console.log(`  HTTP Status: ${resC.status}`);
      console.log(`  Payload: ${JSON.stringify(resC.body)}`);

      if (
        resC.status !== 503 ||
        resC.body.status === 'ok' ||
        resC.body.components?.redis?.status !== 'down'
      ) {
        throw new Error(`Test C FAILED: Expected 503 with redis down, got ${resC.status}`);
      }
      console.log('  [PASS] Test C: HTTP 503 with redis down verified.');
    } finally {
      console.log('  Restoring Redis container immediately...');
      run('docker start reloop-redis');
      waitForRedis();
      console.log('  Redis container restored and healthy.\n');
    }

    // -------------------------------------------------------------
    // Final check: Both restored and healthy
    // -------------------------------------------------------------
    console.log('[Restoration Check] Verifying /health after all restorations...');
    const resFinal = await request(server).get('/health');
    console.log(`  HTTP Status: ${resFinal.status}`);
    console.log(`  Payload: ${JSON.stringify(resFinal.body)}`);

    if (
      resFinal.status !== 200 ||
      resFinal.body.status !== 'ok' ||
      resFinal.body.components?.database?.status !== 'ok' ||
      resFinal.body.components?.redis?.status !== 'ok'
    ) {
      throw new Error(`Restoration Check FAILED: Expected 200 ok, got ${resFinal.status}`);
    }
    console.log('  [PASS] Final Check: Fully recovered to HTTP 200.\n');

    console.log('======================================================');
    console.log('ALL HEALTH ENDPOINT BEHAVIOR ASSERTIONS PASSED (A, B, C)');
    console.log('======================================================');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Fatal health verification error:', err);
  process.exit(1);
});
