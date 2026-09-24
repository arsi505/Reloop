import { PrismaClient } from '@prisma/client';
import {
  WorkflowTemplateRegistry,
  registerSystemTemplates,
  registerRecoveryTemplates,
} from '@reloop/workflow-core';
import { SchedulerConfig, loadSchedulerConfig } from './config';
import { RedisPublisher } from './redis-publisher';
import { SchedulerService } from './scheduler-service';
import { WorkflowCoordinator } from './workflow-coordinator';
import { WorkflowCreationService } from './workflow-creator';
import { RecoveryRouterService } from './recovery-router/recovery-router.service';
import { RecoveryRouterScanner } from './recovery-router-scanner';
import { CaseDetectionService } from './case-detection/case-detection.service';
import { ReconciliationScanner, OrderSnapshotProvider } from './reconciliation-scanner';
import { CaseResolutionService } from './case-resolution/case-resolution.service';

export interface SchedulerRuntime {
  config: SchedulerConfig;
  prisma: PrismaClient;
  publisher: RedisPublisher;
  templateRegistry: WorkflowTemplateRegistry;
  caseResolutionService: CaseResolutionService;
  workflowCreator: WorkflowCreationService;
  routerService: RecoveryRouterService;
  caseDetectionService: CaseDetectionService;
  coordinator: WorkflowCoordinator;
  schedulerService: SchedulerService;
  reconciliationScanner: ReconciliationScanner;
  recoveryRouterScanner: RecoveryRouterScanner;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface CreateSchedulerRuntimeOptions {
  config?: Partial<SchedulerConfig>;
  prisma?: PrismaClient;
  snapshotProvider?: OrderSnapshotProvider;
}

/**
 * Creates the authoritative production scheduler runtime shared between production entrypoint and tests.
 */
export function createSchedulerRuntime(
  options: CreateSchedulerRuntimeOptions = {},
): SchedulerRuntime {
  const config = loadSchedulerConfig(options.config);
  const prisma = options.prisma ?? new PrismaClient();

  const templateRegistry = new WorkflowTemplateRegistry();
  registerSystemTemplates(templateRegistry);
  registerRecoveryTemplates(templateRegistry);

  const caseResolutionService = new CaseResolutionService(prisma);
  const workflowCreator = new WorkflowCreationService(prisma, templateRegistry);
  const routerService = new RecoveryRouterService(prisma, workflowCreator);
  const recoveryRouterScanner = new RecoveryRouterScanner(prisma, routerService, config);

  const caseDetectionService = new CaseDetectionService(prisma);
  const reconciliationScanner = new ReconciliationScanner(
    prisma,
    caseDetectionService,
    config,
    options.snapshotProvider,
  );

  const publisher = new RedisPublisher(config);
  const coordinator = new WorkflowCoordinator(
    prisma,
    templateRegistry,
    config,
    caseResolutionService,
  );
  const schedulerService = new SchedulerService(config, prisma, publisher, coordinator);

  let isStarted = false;

  return {
    config,
    prisma,
    publisher,
    templateRegistry,
    caseResolutionService,
    workflowCreator,
    routerService,
    caseDetectionService,
    coordinator,
    schedulerService,
    reconciliationScanner,
    recoveryRouterScanner,
    start: async () => {
      if (isStarted) return;
      isStarted = true;

      // 1. Start core scheduler engine (publishes jobs, runs coordinator)
      await schedulerService.start();

      // 2. Start Day 13 recovery policy router scanner
      recoveryRouterScanner.start();

      // 3. Start Day 12 reconciliation scanner
      reconciliationScanner.start();
    },
    stop: async () => {
      if (!isStarted) return;
      isStarted = false;

      // Clean, controlled teardown of all loops without timer leaks
      await recoveryRouterScanner.stop();
      await reconciliationScanner.stop();
      await schedulerService.stop();

      if (!options.prisma) {
        await prisma.$disconnect();
      }
    },
  };
}
