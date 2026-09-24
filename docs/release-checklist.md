# Reloop Production Release Checklist

**Target Version:** v1.0.0
**Current Phase:** Day 23 Complete (Release Candidate Prepared)
**Baseline Security Freeze Commit:** `8ec17c5`

---

## 1. Development & Hardening Milestones

- [x] **Day 1–20: Core Platform & Operational Invariants**
  - [x] Multi-channel webhook ingestion & deduplication.
  - [x] Reconciliation core & typed discrepancy detector.
  - [x] Workflow DAG engine with cycle detection and condition evaluation.
  - [x] Redlock-backed distributed workers and lease management.
  - [x] Next.js 15.5 operational UI with Flight Recorder timeline.
  - [x] Socket.IO realtime invalidation signals.
- [x] **Day 21: Benchmark Repeatability & Reliability Validation**
  - [x] 10,000-job sustained throughput benchmark executed across three independent runs.
  - [x] Median throughput verified at 339.1 completed jobs/sec (local benchmark).
  - [x] 0 duplicate business mutations, 0 dropped jobs, 0 unhandled failures.
  - [x] Chaos drills verified: worker crash recovery, lock lease recovery, split-brain isolation.
- [x] **Day 22: Security Hardening & Zero-Vulnerability Freeze**
  - [x] Controlled migration of `@reloop/web` to `next@15.5.24` (0 critical npm audit findings).
  - [x] Tenant data isolation verified via composite keys across all Prisma models.
  - [x] Ephemeral JWT access tokens (15m) + HTTP-only rotating refresh cookies.
  - [x] AES-256-GCM envelope encryption for third-party connector credentials.
  - [x] HMAC-SHA256 signature verification and 5-minute replay window for webhooks.
  - [x] 41/41 automated assertions in security audit matrix PASS.
  - [x] Deep health probe (`/health`) reporting real PostgreSQL and Redis connectivity.
- [x] **Day 23: Release Candidate Preparation & Documentation**
  - [x] Authoritative `README.md` with system diagrams, quickstart, and non-goals.
  - [x] System architecture specification (`docs/architecture.md`).
  - [x] Human acceptance runbook (`docs/manual-acceptance-test.md`).
  - [x] Portfolio engineering notes (`docs/portfolio-notes.md`).
  - [x] Synthetic demonstration dataset (`scripts/seed-rich-demo-data.ts`) with clear non-production classification.
  - [x] 7 unscaled live application UI screenshots (`docs/assets/screenshots/`).

---

## 2. Release Candidate Verification Gates

- [x] Monorepo linting passes with 0 errors across 14 workspaces (`npm run lint`).
- [x] Monorepo TypeScript typecheck passes with 0 errors across 14 packages (`npm run typecheck`).
- [x] 478 unit and integration tests passing across 45 suites (`npm run test`).
- [x] 150 API E2E tests passing across 10 suites (`npm run test:e2e --workspace=@reloop/api`).
- [x] 17 simulator E2E tests passing (`npm run test:e2e --workspace=@reloop/simulator`).
- [x] Monorepo production build completes with 0 errors (`npm run build`).
- [x] Automated audit blockers RA-01, RA-02, and RA-03 remediated; automated acceptance baseline green.
- [x] Zero `.env` files tracked in git (`git ls-files | Select-String -Pattern "\.env$"`).
- [x] Working tree clean and free of whitespace warnings (`git diff --check`).

---

## 3. Pending Release Stages (Unchecked — Do NOT Mark Complete Early)

- [ ] **Day 24: Human Manual Acceptance Testing**
  - [ ] Complete Sections A through T in `docs/manual-acceptance-test.md`.
  - [ ] Validate real simulator flows (discrepancy creation, auto-investigation, approval, rejection, and independent verification).
  - [ ] Verify two-browser realtime synchronization.
  - [ ] Verify service resilience under API, worker, scheduler, and Redis restarts.
- [ ] **Manual Defects Triage & Remediation**
  - [ ] Fix any real bugs discovered during manual acceptance testing.
- [ ] **Final Pre-Release Monorepo Regression**
  - [ ] Full test suite execution.
  - [ ] Dependency security verification (`npm audit --json`).
- [ ] **Public GitHub Push**
  - [ ] Authenticate remote origin.
  - [ ] Push `main` branch to GitHub.
- [ ] **Git Tag Creation**
  - [ ] Create signed annotated tag `v1.0.0`.
- [ ] **GitHub Release Publication**
  - [ ] Publish official GitHub Release with release notes and embedded screenshots.
