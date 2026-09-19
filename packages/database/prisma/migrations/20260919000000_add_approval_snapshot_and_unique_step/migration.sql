-- AlterTable
ALTER TABLE "approvals" ADD COLUMN "preview_snapshot" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "approvals_workflow_step_id_key" ON "approvals"("workflow_step_id");
