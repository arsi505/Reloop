import { PrismaClient } from '@prisma/client';

const dbUrl =
  process.env.RELOOP_TEST_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://reloop@localhost:5433/reloop_test?schema=public';
process.env.DATABASE_URL = dbUrl;

async function main() {
  console.log('===============================================================');
  console.log('  RELOOP DAY 21: POST-LOAD DATABASE INVARIANT INTEGRITY AUDIT  ');
  console.log('===============================================================\n');

  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  await prisma.$connect();

  let allPassed = true;

  // 1. Orphaned JobAttempts (job_id does not exist in jobs)
  const orphanedAttempts = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count
    FROM job_attempts ja
    LEFT JOIN jobs j ON ja.job_id = j.id
    WHERE j.id IS NULL
  `;
  const orphanedCount = Number(orphanedAttempts[0]?.count ?? 0);
  console.log(`[Invariant 1] Orphaned JobAttempts: ${orphanedCount} (Target: 0) -> ${orphanedCount === 0 ? 'PASS' : 'FAIL'}`);
  if (orphanedCount !== 0) allPassed = false;

  // 2. Duplicate active workflows per case
  const dupActiveWorkflows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count
    FROM (
      SELECT organization_id, recovery_case_id, COUNT(*)
      FROM workflows
      WHERE status IN ('PENDING', 'RUNNING', 'WAITING')
      GROUP BY organization_id, recovery_case_id
      HAVING COUNT(*) > 1
    ) sub
  `;
  const dupActiveWfCount = Number(dupActiveWorkflows[0]?.count ?? 0);
  console.log(`[Invariant 2] Duplicate Active Workflows Per Case: ${dupActiveWfCount} (Target: 0) -> ${dupActiveWfCount === 0 ? 'PASS' : 'FAIL'}`);
  if (dupActiveWfCount !== 0) allPassed = false;

  // 3. Duplicate active cases per dedupe_key
  const dupActiveCases = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count
    FROM (
      SELECT organization_id, dedupe_key, COUNT(*)
      FROM recovery_cases
      WHERE dedupe_key IS NOT NULL
        AND status NOT IN ('RESOLVED', 'FAILED')
      GROUP BY organization_id, dedupe_key
      HAVING COUNT(*) > 1
    ) sub
  `;
  const dupActiveCasesCount = Number(dupActiveCases[0]?.count ?? 0);
  console.log(`[Invariant 3] Duplicate Active Cases Per DedupeKey: ${dupActiveCasesCount} (Target: 0) -> ${dupActiveCasesCount === 0 ? 'PASS' : 'FAIL'}`);
  if (dupActiveCasesCount !== 0) allPassed = false;

  // 4. Duplicate idempotency keys per organization
  const dupIdempKeys = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count
    FROM (
      SELECT organization_id, idempotency_key, COUNT(*)
      FROM jobs
      GROUP BY organization_id, idempotency_key
      HAVING COUNT(*) > 1
    ) sub
  `;
  const dupIdempCount = Number(dupIdempKeys[0]?.count ?? 0);
  console.log(`[Invariant 4] Duplicate Idempotency Keys Per Org: ${dupIdempCount} (Target: 0) -> ${dupIdempCount === 0 ? 'PASS' : 'FAIL'}`);
  if (dupIdempCount !== 0) allPassed = false;

  // 5. Resolved cases lacking verified resolution semantics (resolved_at is null when status = RESOLVED)
  const invalidResolvedCases = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count
    FROM recovery_cases
    WHERE status = 'RESOLVED' AND resolved_at IS NULL
  `;
  const invalidResolvedCount = Number(invalidResolvedCases[0]?.count ?? 0);
  console.log(`[Invariant 5] Resolved Cases Missing resolved_at: ${invalidResolvedCount} (Target: 0) -> ${invalidResolvedCount === 0 ? 'PASS' : 'FAIL'}`);
  if (invalidResolvedCount !== 0) allPassed = false;

  console.log('\n===============================================================');
  console.log(`  OVERALL DATABASE INTEGRITY AUDIT: ${allPassed ? 'ALL INVARIANTS SATISFIED (PASS)' : 'FAILED'}`);
  console.log('===============================================================\n');

  await prisma.$disconnect();

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Invariant Audit Error]:', err);
  process.exit(1);
});
