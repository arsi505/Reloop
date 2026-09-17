-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('SHOPIFY', 'SHIPSTATION', 'GENERIC_3PL', 'SIMULATOR');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'DEGRADED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "OperationalMode" AS ENUM ('OBSERVE', 'RECOMMEND', 'APPROVAL', 'SAFE_AUTO_RECOVERY');

-- CreateEnum
CREATE TYPE "ExternalOrderStatus" AS ENUM ('PENDING', 'READY_FOR_FULFILLMENT', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IntegrationEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED_DUPLICATE');

-- CreateEnum
CREATE TYPE "RecoveryCaseType" AS ENUM ('TEMPORARY_API_FAILURE', 'TRACKING_MISSING_IN_SHOPIFY', 'STUCK_ORDER', 'ORDER_MISSING_AT_3PL', 'SHIPPED_AT_3PL_UNFULFILLED_AT_SHOPIFY', 'INVENTORY_MISMATCH', 'DUPLICATE_RISK', 'INVALID_ORDER_DATA');

-- CreateEnum
CREATE TYPE "RecoveryLevel" AS ENUM ('AUTO_RECOVER', 'AUTO_INVESTIGATE', 'REQUIRE_APPROVAL', 'BLOCK');

-- CreateEnum
CREATE TYPE "RecoveryCaseStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'READY_FOR_RECOVERY', 'AUTO_RECOVERING', 'WAITING_APPROVAL', 'RECOVERING', 'VERIFYING', 'RESOLVED', 'BLOCKED', 'FAILED');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowStepStatus" AS ENUM ('PENDING', 'READY', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'CLAIMED', 'RUNNING', 'RETRY_WAITING', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'DEAD_LETTERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobAttemptStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "JobErrorCategory" AS ENUM ('TRANSIENT', 'RATE_LIMITED', 'BUSINESS_ERROR', 'AUTH_ERROR', 'NOT_FOUND', 'DUPLICATE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('ONLINE', 'BUSY', 'DRAINING', 'OFFLINE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'CONNECTED',
    "mode" "OperationalMode" NOT NULL DEFAULT 'OBSERVE',
    "configuration" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "primary_integration_id" UUID,
    "external_order_number" TEXT NOT NULL,
    "customer_reference" TEXT,
    "status" "ExternalOrderStatus" NOT NULL DEFAULT 'PENDING',
    "currency" VARCHAR(3),
    "total_amount" DECIMAL(12,2),
    "source_created_at" TIMESTAMP(3),
    "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_references" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "external_order_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "provider_event_id" TEXT,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "IntegrationEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_cases" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "external_order_id" UUID,
    "source_integration_id" UUID,
    "assigned_user_id" UUID,
    "type" "RecoveryCaseType" NOT NULL,
    "recovery_level" "RecoveryLevel" NOT NULL,
    "status" "RecoveryCaseStatus" NOT NULL DEFAULT 'OPEN',
    "summary" TEXT NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recovery_case_id" UUID NOT NULL,
    "template_key" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL DEFAULT 1,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" "WorkflowStepStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "depends_on_step_id" UUID,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID,
    "workflow_step_id" UUID,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" TEXT NOT NULL,
    "claimed_by_worker_id" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" UUID NOT NULL,
    "worker_key" TEXT NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'ONLINE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stopped_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_attempts" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "worker_id" UUID,
    "attempt_number" INTEGER NOT NULL,
    "status" "JobAttemptStatus" NOT NULL DEFAULT 'STARTED',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "error_category" "JobErrorCategory",
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recovery_case_id" UUID NOT NULL,
    "workflow_id" UUID,
    "workflow_step_id" UUID,
    "requested_by_user_id" UUID,
    "decided_by_user_id" UUID,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integrations_organization_id_idx" ON "integrations"("organization_id");

-- CreateIndex
CREATE INDEX "integrations_organization_id_status_idx" ON "integrations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "integrations_organization_id_provider_idx" ON "integrations"("organization_id", "provider");

-- CreateIndex
CREATE INDEX "external_orders_organization_id_idx" ON "external_orders"("organization_id");

-- CreateIndex
CREATE INDEX "external_orders_organization_id_status_idx" ON "external_orders"("organization_id", "status");

-- CreateIndex
CREATE INDEX "external_orders_primary_integration_id_idx" ON "external_orders"("primary_integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_orders_organization_id_external_order_number_key" ON "external_orders"("organization_id", "external_order_number");

-- CreateIndex
CREATE INDEX "external_references_organization_id_idx" ON "external_references"("organization_id");

-- CreateIndex
CREATE INDEX "external_references_external_order_id_idx" ON "external_references"("external_order_id");

-- CreateIndex
CREATE INDEX "external_references_integration_id_idx" ON "external_references"("integration_id");

-- CreateIndex
CREATE INDEX "external_references_organization_id_external_id_idx" ON "external_references"("organization_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_references_organization_id_integration_id_resource_key" ON "external_references"("organization_id", "integration_id", "resource_type", "external_id");

-- CreateIndex
CREATE INDEX "integration_events_organization_id_status_idx" ON "integration_events"("organization_id", "status");

-- CreateIndex
CREATE INDEX "integration_events_integration_id_idx" ON "integration_events"("integration_id");

-- CreateIndex
CREATE INDEX "integration_events_received_at_idx" ON "integration_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_events_integration_id_provider_event_id_key" ON "integration_events"("integration_id", "provider_event_id");

-- CreateIndex
CREATE INDEX "recovery_cases_organization_id_status_idx" ON "recovery_cases"("organization_id", "status");

-- CreateIndex
CREATE INDEX "recovery_cases_organization_id_type_idx" ON "recovery_cases"("organization_id", "type");

-- CreateIndex
CREATE INDEX "recovery_cases_external_order_id_idx" ON "recovery_cases"("external_order_id");

-- CreateIndex
CREATE INDEX "recovery_cases_source_integration_id_idx" ON "recovery_cases"("source_integration_id");

-- CreateIndex
CREATE INDEX "recovery_cases_assigned_user_id_idx" ON "recovery_cases"("assigned_user_id");

-- CreateIndex
CREATE INDEX "recovery_cases_detected_at_idx" ON "recovery_cases"("detected_at");

-- CreateIndex
CREATE INDEX "workflows_organization_id_idx" ON "workflows"("organization_id");

-- CreateIndex
CREATE INDEX "workflows_recovery_case_id_idx" ON "workflows"("recovery_case_id");

-- CreateIndex
CREATE INDEX "workflows_organization_id_status_idx" ON "workflows"("organization_id", "status");

-- CreateIndex
CREATE INDEX "workflow_steps_workflow_id_position_idx" ON "workflow_steps"("workflow_id", "position");

-- CreateIndex
CREATE INDEX "workflow_steps_organization_id_idx" ON "workflow_steps"("organization_id");

-- CreateIndex
CREATE INDEX "workflow_steps_depends_on_step_id_idx" ON "workflow_steps"("depends_on_step_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_workflow_id_key_key" ON "workflow_steps"("workflow_id", "key");

-- CreateIndex
CREATE INDEX "jobs_status_next_run_at_idx" ON "jobs"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "jobs_organization_id_status_idx" ON "jobs"("organization_id", "status");

-- CreateIndex
CREATE INDEX "jobs_workflow_id_idx" ON "jobs"("workflow_id");

-- CreateIndex
CREATE INDEX "jobs_workflow_step_id_idx" ON "jobs"("workflow_step_id");

-- CreateIndex
CREATE INDEX "jobs_lease_expires_at_idx" ON "jobs"("lease_expires_at");

-- CreateIndex
CREATE INDEX "jobs_claimed_by_worker_id_idx" ON "jobs"("claimed_by_worker_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_organization_id_idempotency_key_key" ON "jobs"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "workers_worker_key_key" ON "workers"("worker_key");

-- CreateIndex
CREATE INDEX "workers_status_last_heartbeat_at_idx" ON "workers"("status", "last_heartbeat_at");

-- CreateIndex
CREATE INDEX "job_attempts_job_id_idx" ON "job_attempts"("job_id");

-- CreateIndex
CREATE INDEX "job_attempts_worker_id_idx" ON "job_attempts"("worker_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_attempts_job_id_attempt_number_key" ON "job_attempts"("job_id", "attempt_number");

-- CreateIndex
CREATE INDEX "approvals_organization_id_status_idx" ON "approvals"("organization_id", "status");

-- CreateIndex
CREATE INDEX "approvals_recovery_case_id_idx" ON "approvals"("recovery_case_id");

-- CreateIndex
CREATE INDEX "approvals_workflow_id_idx" ON "approvals"("workflow_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_idx" ON "audit_logs"("actor_user_id");

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_orders" ADD CONSTRAINT "external_orders_primary_integration_id_fkey" FOREIGN KEY ("primary_integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_references" ADD CONSTRAINT "external_references_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_references" ADD CONSTRAINT "external_references_external_order_id_fkey" FOREIGN KEY ("external_order_id") REFERENCES "external_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_references" ADD CONSTRAINT "external_references_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_external_order_id_fkey" FOREIGN KEY ("external_order_id") REFERENCES "external_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_source_integration_id_fkey" FOREIGN KEY ("source_integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_recovery_case_id_fkey" FOREIGN KEY ("recovery_case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_depends_on_step_id_fkey" FOREIGN KEY ("depends_on_step_id") REFERENCES "workflow_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workflow_step_id_fkey" FOREIGN KEY ("workflow_step_id") REFERENCES "workflow_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_claimed_by_worker_id_fkey" FOREIGN KEY ("claimed_by_worker_id") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_recovery_case_id_fkey" FOREIGN KEY ("recovery_case_id") REFERENCES "recovery_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workflow_step_id_fkey" FOREIGN KEY ("workflow_step_id") REFERENCES "workflow_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
