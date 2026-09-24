-- CreateIndex
CREATE INDEX "integration_events_status_created_at_idx" ON "integration_events"("status", "created_at");

-- CreateIndex
CREATE INDEX "integration_events_status_updated_at_idx" ON "integration_events"("status", "updated_at");
