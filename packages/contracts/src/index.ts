export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface ComponentHealth {
  status: HealthStatus;
  latencyMs?: number;
  message?: string;
}

export interface ServiceHealth {
  status: HealthStatus;
  service: string;
  version: string;
  timestamp: string;
  components: {
    database: ComponentHealth;
    redis: ComponentHealth;
  };
}

export type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

export interface UserDto {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface OrganizationMemberDto {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface AuthResponseDto {
  user: UserDto;
  organization: OrganizationDto;
  role: Role;
  accessToken: string;
}

export interface MeResponseDto {
  user: UserDto;
  organization: OrganizationDto;
  role: Role;
}

// ==========================================
// Operations & Reliability Domain Contracts
// ==========================================

export type RecoveryCaseType =
  | 'DUPLICATE_PURCHASE'
  | 'ADDRESS_MISMATCH'
  | 'INVENTORY_SHORTAGE'
  | 'FULFILLMENT_DELAY'
  | 'TRACKING_STALLED'
  | 'CARRIER_EXCEPTION'
  | 'CUSTOMS_HOLD'
  | 'SYSTEM_DESYNC'
  | 'MANUAL_ESCALATION';

export type RecoveryLevel =
  | 'AUTO_INVESTIGATE'
  | 'AUTO_RECOVER'
  | 'REQUIRE_APPROVAL'
  | 'BLOCK'
  | 'IGNORE';

export type RecoveryCaseStatus =
  | 'DETECTED'
  | 'INVESTIGATING'
  | 'WAITING_APPROVAL'
  | 'RECOVERING'
  | 'RECOVERED'
  | 'PARTIALLY_RECOVERED'
  | 'FAILED'
  | 'IGNORED'
  | 'BLOCKED';

export type WorkflowStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING'
  | 'WAITING_FOR_INPUT'
  | 'SUCCEEDED'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

export type IntegrationProvider = 'SHOPIFY' | 'SHIPSTATION' | 'GENERIC_3PL';

export type IntegrationStatus =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'ERROR'
  | 'SUSPENDED'
  | 'PENDING_AUTH';

export type OperationalMode = 'READ_ONLY' | 'MUTATION_ACTIVE' | 'TEST_SIMULATION';

export type ExternalOrderStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export type IntegrationHealthStatus = 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'SYNCING';

export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// Dashboard DTOs
export interface RecentExceptionSummaryDto {
  id: string;
  type: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  status: RecoveryCaseStatus;
  summary: string;
  detectedAt: string;
  externalOrderId: string | null;
  externalOrderNumber: string | null;
}

export interface IntegrationHealthSummaryDto {
  total: number;
  healthy: number;
  degraded: number;
  disconnected: number;
  syncing: number;
}

export interface RecentRecoveryActivityDto {
  workflowId: string;
  recoveryCaseId: string;
  caseType: RecoveryCaseType;
  templateKey: string;
  status: WorkflowStatus;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DashboardSummaryDto {
  openExceptionsCount: number;
  casesRequiringApprovalCount: number;
  blockedCasesCount: number;
  autoInvestigateCasesCount: number;
  autoRecoveryCasesCount: number;
  resolvedCasesCount: number;
  failedCasesCount: number;
  totalExceptionsCount: number;
  recentExceptions: RecentExceptionSummaryDto[];
  integrationHealthSummary: IntegrationHealthSummaryDto;
  recentRecoveryActivity: RecentRecoveryActivityDto[];
}

// Exception DTOs
export interface ExceptionOrderReferenceDto {
  id: string;
  orderNumber: string;
}

export interface ExceptionListItemDto {
  id: string;
  type: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  status: RecoveryCaseStatus;
  summary: string;
  detectedAt: string;
  resolvedAt: string | null;
  order: ExceptionOrderReferenceDto | null;
  provider: IntegrationProvider | null;
  hasActiveWorkflow: boolean;
  workflowStatus: WorkflowStatus | null;
  approvalWaiting: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExceptionDetailOrderDto {
  id: string;
  orderNumber: string;
  status: string;
  currency: string | null;
  totalAmount: string | null;
  sourceCreatedAt: string | null;
}

export interface ExceptionDetailIntegrationDto {
  id: string;
  provider: IntegrationProvider;
  name: string;
  status: string;
}

export interface ExceptionDetailWorkflowStepDto {
  id: string;
  key: string;
  name: string;
  position: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  output?: Record<string, unknown> | null;
}

export interface ExceptionDetailWorkflowDto {
  id: string;
  templateKey: string;
  templateVersion: number;
  status: WorkflowStatus;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExceptionDetailApprovalDto {
  id: string;
  status: ApprovalStatus | string;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  previewSnapshot: Record<string, unknown> | null;
}

export interface ExceptionDetailDto {
  id: string;
  type: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  status: RecoveryCaseStatus;
  summary: string;
  detectedAt: string;
  resolvedAt: string | null;
  dedupeKey: string | null;
  sanitizedEvidence: Record<string, unknown>;
  order: ExceptionDetailOrderDto | null;
  integration: ExceptionDetailIntegrationDto | null;
  workflow: ExceptionDetailWorkflowDto | null;
  workflowSteps: ExceptionDetailWorkflowStepDto[];
  approval: ExceptionDetailApprovalDto | null;
  recoveryResult: { outcome: string; details?: string } | null;
  createdAt: string;
  updatedAt: string;
}

// Order DTOs
export interface OrderListItemDto {
  id: string;
  externalOrderNumber: string;
  customerReference: string | null;
  status: ExternalOrderStatus;
  currency: string | null;
  totalAmount: string | null;
  sourceCreatedAt: string | null;
  lastObservedAt: string;
  primaryProvider: IntegrationProvider | null;
  connectedProviders: IntegrationProvider[];
  activeExceptionCount: number;
  hasOpenException: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShopifyCrossSystemStateDto {
  fulfillmentStatus: string | null;
  financialStatus?: string | null;
  trackingNumbers: string[];
  lastObservedAt: string | null;
}

export interface ShipStationCrossSystemStateDto {
  shipmentStatus: string | null;
  trackingNumbers: string[];
  carrierCodes: string[];
  labelCount: number;
  voidedLabelCount: number;
  lastObservedAt: string | null;
}

export interface Generic3plCrossSystemStateDto {
  warehouseStatus: string | null;
  trackingNumber: string | null;
  lastObservedAt: string | null;
}

export interface OrderExternalReferenceDto {
  id: string;
  provider: IntegrationProvider;
  resourceType: string;
  externalId: string;
  externalReference: string | null;
  createdAt: string;
}

export interface OrderRelatedExceptionDto {
  id: string;
  type: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  status: RecoveryCaseStatus;
  summary: string;
  detectedAt: string;
}

export interface CrossSystemDiscrepancyDto {
  hasDiscrepancy: boolean;
  summary: string | null;
  details: Record<string, unknown>;
}

export interface OrderDetailDto {
  id: string;
  externalOrderNumber: string;
  customerReference: string | null;
  status: ExternalOrderStatus;
  currency: string | null;
  totalAmount: string | null;
  sourceCreatedAt: string | null;
  lastObservedAt: string;
  shopifyState: ShopifyCrossSystemStateDto | null;
  shipstationState: ShipStationCrossSystemStateDto | null;
  generic3plState: Generic3plCrossSystemStateDto | null;
  trackingNumbers: string[];
  externalReferences: OrderExternalReferenceDto[];
  relatedExceptions: OrderRelatedExceptionDto[];
  crossSystemDiscrepancy: CrossSystemDiscrepancyDto | null;
  createdAt: string;
  updatedAt: string;
}

// Recovery DTOs
export interface RecoveryListItemDto {
  id: string;
  recoveryCaseId: string;
  caseType: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  caseSummary: string;
  templateKey: string;
  templateVersion: number;
  status: WorkflowStatus;
  orderNumber: string | null;
  approvalStatus: ApprovalStatus | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TimelineActorDto {
  id: string;
  name: string;
}

export interface TimelineEntryDto {
  id: string;
  timestamp: string;
  eventType: string;
  description: string;
  system: string;
  status: string;
  actor: TimelineActorDto | null;
  metadata: Record<string, unknown>;
}

export interface RecoveryDetailApprovalDto {
  id: string;
  status: ApprovalStatus;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  previewSnapshot: Record<string, unknown> | null;
}

export interface RecoveryDetailDto {
  id: string;
  recoveryCaseId: string;
  caseType: RecoveryCaseType;
  recoveryLevel: RecoveryLevel;
  caseSummary: string;
  templateKey: string;
  templateVersion: number;
  status: WorkflowStatus;
  order: { id: string; orderNumber: string } | null;
  approval: RecoveryDetailApprovalDto | null;
  timeline: TimelineEntryDto[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Integration DTOs
export interface IntegrationLastErrorDto {
  category: 'RATE_LIMITED' | 'AUTHENTICATION' | 'PROVIDER_UNAVAILABLE' | 'SYNC_FAILED' | 'UNKNOWN';
  occurredAt: string;
  summary: string;
}

export interface IntegrationCardDto {
  id: string;
  provider: IntegrationProvider;
  name: string;
  status: IntegrationStatus;
  mode: OperationalMode;
  health: IntegrationHealthStatus;
  safeIdentifier: string;
  readCapability: boolean;
  mutationCapability: boolean;
  lastSuccessfulSync: string | null;
  lastError: IntegrationLastErrorDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationRecentSyncJobDto {
  id: string;
  type: string;
  status: string;
  attemptCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface IntegrationOperationsDetailDto extends IntegrationCardDto {
  recentSyncJobs: IntegrationRecentSyncJobDto[];
  recentEventsCount: number;
  associatedCasesCount: number;
  activeCasesCount: number;
  safeConfiguration: Record<string, unknown>;
}