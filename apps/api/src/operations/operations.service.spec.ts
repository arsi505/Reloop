import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from './services/dashboard.service';
import { ExceptionsService } from './services/exceptions.service';
import { OrdersService } from './services/orders.service';
import { RecoveriesService } from './services/recoveries.service';
import { IntegrationHealthService } from './services/integration-health.service';
import {
  IntegrationProvider,
  IntegrationStatus,
  JobStatus,
  RecoveryCaseStatus,
  RecoveryLevel,
  RecoveryCaseType,
  WorkflowStatus,
  ApprovalStatus,
} from '@reloop/database';

describe('Operations Module Services Unit Tests', () => {
  let dashboardService: DashboardService;
  let exceptionsService: ExceptionsService;
  let ordersService: OrdersService;
  let recoveriesService: RecoveriesService;
  let healthService: IntegrationHealthService;
  let prisma: any;

  const mockOrgId = 'org-day17-test-1111';

  beforeEach(async () => {
    prisma = {
      recoveryCase: {
        count: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      workflow: {
        count: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      externalOrder: {
        count: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      integration: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      job: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      jobAttempt: {
        findFirst: jest.fn(),
      },
      integrationEvent: {
        count: jest.fn(),
      },
      auditLog: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        ExceptionsService,
        OrdersService,
        RecoveriesService,
        IntegrationHealthService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    dashboardService = module.get<DashboardService>(DashboardService);
    exceptionsService = module.get<ExceptionsService>(ExceptionsService);
    ordersService = module.get<OrdersService>(OrdersService);
    recoveriesService = module.get<RecoveriesService>(RecoveriesService);
    healthService = module.get<IntegrationHealthService>(IntegrationHealthService);
  });

  describe('Integration Health Derivation', () => {
    it('derives DISCONNECTED when integration status is DISCONNECTED', () => {
      const integration: any = {
        status: IntegrationStatus.DISCONNECTED,
        provider: IntegrationProvider.SHOPIFY,
      };
      expect(healthService.deriveHealth(integration, null)).toBe('DISCONNECTED');
    });

    it('derives DEGRADED when integration status is DEGRADED or ERROR', () => {
      const degraded: any = { status: IntegrationStatus.DEGRADED };
      const error: any = { status: IntegrationStatus.ERROR };
      expect(healthService.deriveHealth(degraded, null)).toBe('DEGRADED');
      expect(healthService.deriveHealth(error, null)).toBe('DEGRADED');
    });

    it('derives SYNCING when latest sync job is RUNNING or CLAIMED', () => {
      const integration: any = { status: IntegrationStatus.CONNECTED };
      const runningJob: any = { status: JobStatus.RUNNING };
      const claimedJob: any = { status: JobStatus.CLAIMED };
      expect(healthService.deriveHealth(integration, runningJob)).toBe('SYNCING');
      expect(healthService.deriveHealth(integration, claimedJob)).toBe('SYNCING');
    });

    it('does NOT mark connected-but-failing sync as HEALTHY (derives DEGRADED)', () => {
      const integration: any = { status: IntegrationStatus.CONNECTED };
      const failedJob: any = { status: JobStatus.FAILED };
      const deadLetteredJob: any = { status: JobStatus.DEAD_LETTERED };
      expect(healthService.deriveHealth(integration, failedJob)).toBe('DEGRADED');
      expect(healthService.deriveHealth(integration, deadLetteredJob)).toBe('DEGRADED');
    });

    it('derives HEALTHY when CONNECTED and latest sync job is SUCCEEDED or null', () => {
      const integration: any = { status: IntegrationStatus.CONNECTED };
      const succeededJob: any = { status: JobStatus.SUCCEEDED };
      expect(healthService.deriveHealth(integration, succeededJob)).toBe('HEALTHY');
      expect(healthService.deriveHealth(integration, null)).toBe('HEALTHY');
    });

    it('derives authoritative lastSuccessfulSync from job completedAt or configuration watermark', () => {
      const jobDate = new Date('2026-09-20T12:00:00Z');
      const watermarkDate = '2026-09-20T10:00:00Z';

      const job: any = { completedAt: jobDate };
      const integration: any = {
        configuration: { lastSuccessfulSyncWatermark: watermarkDate },
      };

      // Job takes precedence
      expect(healthService.deriveLastSuccessfulSync(integration, job)).toEqual(jobDate);

      // Falls back to watermark if job is null
      expect(healthService.deriveLastSuccessfulSync(integration, null)).toEqual(new Date(watermarkDate));
    });
  });

  describe('Evidence PII & Secret Sanitization', () => {
    it('recursively strips customer PII and redacts secrets', () => {
      const rawEvidence = {
        orderId: '1001',
        customerName: 'Alice Smith',
        customerEmail: 'alice@example.com',
        phone: '+1-555-0199',
        shippingAddress: {
          street: '123 Main St',
          city: 'Anytown',
          zip: '12345',
        },
        credentials: {
          apiKey: 'ss_live_secret_key_12345',
          accessToken: 'shpat_secret_token_9999',
          unrelatedField: 'safeValue',
        },
      };

      const sanitized = exceptionsService.sanitizeEvidence(rawEvidence);

      // PII stripped
      expect(sanitized.customerName).toBeUndefined();
      expect(sanitized.customerEmail).toBeUndefined();
      expect(sanitized.phone).toBeUndefined();
      expect(sanitized.shippingAddress).toBeUndefined();

      // Secrets redacted
      expect(sanitized.credentials.apiKey).toBe('[REDACTED]');
      expect(sanitized.credentials.accessToken).toBe('[REDACTED]');
      expect(sanitized.credentials.unrelatedField).toBe('safeValue');
      expect(sanitized.orderId).toBe('1001');
    });
  });

  describe('Dashboard DB Aggregations', () => {
    it('uses aggregate count queries without loading all cases into memory', async () => {
      prisma.recoveryCase.count
        .mockResolvedValueOnce(15) // total
        .mockResolvedValueOnce(6)  // open
        .mockResolvedValueOnce(2)  // requiring approval
        .mockResolvedValueOnce(1)  // blocked
        .mockResolvedValueOnce(3)  // auto-investigate
        .mockResolvedValueOnce(2)  // auto-recover
        .mockResolvedValueOnce(8)  // resolved
        .mockResolvedValueOnce(1); // failed

      prisma.recoveryCase.findMany.mockResolvedValueOnce([]);
      prisma.workflow.findMany.mockResolvedValueOnce([]);
      prisma.integration.findMany.mockResolvedValueOnce([]);

      const summary = await dashboardService.getDashboardSummary(mockOrgId);

      expect(summary.totalExceptionsCount).toBe(15);
      expect(summary.openExceptionsCount).toBe(6);
      expect(summary.casesRequiringApprovalCount).toBe(2);
      expect(summary.blockedCasesCount).toBe(1);
      expect(summary.autoInvestigateCasesCount).toBe(3);
      expect(summary.autoRecoveryCasesCount).toBe(2);
      expect(summary.resolvedCasesCount).toBe(8);
      expect(summary.failedCasesCount).toBe(1);
      expect(prisma.recoveryCase.count).toHaveBeenCalledTimes(8);
    });
  });

  describe('Flight Recorder Chronological Timeline Construction', () => {
    it('builds a factual chronological timeline strictly from durable records', async () => {
      const detectedDate = new Date('2026-09-20T10:00:00Z');
      const wfCreatedDate = new Date('2026-09-20T10:01:00Z');
      const wfStartedDate = new Date('2026-09-20T10:02:00Z');
      const stepStartDate = new Date('2026-09-20T10:03:00Z');
      const stepEndDate = new Date('2026-09-20T10:04:00Z');
      const approvalReqDate = new Date('2026-09-20T10:05:00Z');
      const approvalDecDate = new Date('2026-09-20T10:06:00Z');

      const mockWfId = '11111111-1111-1111-1111-111111111111';
      const mockCaseId = '22222222-2222-2222-2222-222222222222';

      const mockWorkflow: any = {
        id: mockWfId,
        organizationId: mockOrgId,
        recoveryCaseId: mockCaseId,
        templateKey: 'STUCK_ORDER_RESOLVE',
        templateVersion: 1,
        status: WorkflowStatus.RUNNING,
        startedAt: wfStartedDate,
        completedAt: null,
        createdAt: wfCreatedDate,
        updatedAt: wfCreatedDate,
        recoveryCase: {
          id: mockCaseId,
          type: RecoveryCaseType.STUCK_ORDER,
          recoveryLevel: RecoveryLevel.REQUIRE_APPROVAL,
          summary: 'Order stuck in unfulfilled state',
          status: RecoveryCaseStatus.WAITING_APPROVAL,
          detectedAt: detectedDate,
          resolvedAt: null,
          externalOrder: { id: 'eo-1', externalOrderNumber: '1001' },
        },
        steps: [
          {
            id: 'step-1',
            key: 'VERIFY_ORDER',
            name: 'Verify Order State',
            position: 1,
            status: 'SUCCEEDED',
            startedAt: stepStartDate,
            completedAt: stepEndDate,
          },
        ],
        approvals: [
          {
            id: 'app-1',
            status: ApprovalStatus.APPROVED,
            reason: null,
            requestedAt: approvalReqDate,
            decidedAt: approvalDecDate,
            requestedByUser: { id: 'u-1', name: 'System Admin' },
            decidedByUser: { id: 'u-2', name: 'Lead Operator' },
            previewSnapshot: { action: 'RELEASE_HOLD' },
          },
        ],
        jobs: [],
      };

      prisma.workflow.findFirst.mockResolvedValueOnce(mockWorkflow);

      const detail = await recoveriesService.getRecoveryDetail(mockOrgId, mockWfId);

      expect(detail.id).toBe(mockWfId);
      expect(detail.timeline.length).toBe(7); // case detected, wf created, wf started, step started, step succeeded, app req, app decided
      expect(detail.timeline[0].eventType).toBe('CASE_DETECTED');
      expect(detail.timeline[1].eventType).toBe('WORKFLOW_CREATED');
      expect(detail.timeline[2].eventType).toBe('WORKFLOW_STARTED');
      expect(detail.timeline[3].eventType).toBe('STEP_STARTED');
      expect(detail.timeline[4].eventType).toBe('STEP_SUCCEEDED');
      expect(detail.timeline[5].eventType).toBe('APPROVAL_REQUESTED');

      // Verify strict chronological ordering
      for (let i = 1; i < detail.timeline.length; i++) {
        expect(detail.timeline[i].timestamp.getTime()).toBeGreaterThanOrEqual(
          detail.timeline[i - 1].timestamp.getTime(),
        );
      }
    });
  });

  describe('Exceptions Pagination & Search', () => {
    it('applies pagination parameters and calculates totalPages correctly', async () => {
      prisma.recoveryCase.count.mockResolvedValueOnce(55);
      prisma.recoveryCase.findMany.mockResolvedValueOnce([]);

      const result = await exceptionsService.listExceptions(mockOrgId, {
        page: 2,
        pageSize: 20,
        sortOrder: 'desc',
      });

      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(20);
      expect(result.total).toBe(55);
      expect(result.totalPages).toBe(3); // ceil(55 / 20) = 3
    });

    it('enforces maximum pageSize of 100', async () => {
      prisma.recoveryCase.count.mockResolvedValueOnce(250);
      prisma.recoveryCase.findMany.mockResolvedValueOnce([]);

      const result = await exceptionsService.listExceptions(mockOrgId, {
        page: 1,
        pageSize: 500, // exceeds max 100
        sortOrder: 'desc',
      });

      expect(result.pageSize).toBe(100);
      expect(result.totalPages).toBe(3); // ceil(250 / 100) = 3
    });
  });
});
