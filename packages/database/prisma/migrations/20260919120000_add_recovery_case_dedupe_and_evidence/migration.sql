-- AlterTable
ALTER TABLE "recovery_cases" ADD COLUMN "dedupe_key" TEXT,
ADD COLUMN "evidence" JSONB DEFAULT '{}';

-- CreateIndex
CREATE INDEX "recovery_cases_organization_id_dedupe_key_idx" ON "recovery_cases"("organization_id", "dedupe_key");
