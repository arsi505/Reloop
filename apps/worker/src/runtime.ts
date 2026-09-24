import { PrismaClient } from '@prisma/client';
import { WorkerConfig, loadWorkerConfig } from './config';
import { WorkerService } from './worker-service';
import { WorkflowStepHandlerRegistry } from './workflow-step-registry';
import { JobExecutorRegistry } from './executor';
import { RecoveryActionExecutor } from '@reloop/connector-simulator';

export interface WorkerRuntime {
  config: WorkerConfig;
  prisma: PrismaClient;
  workerService: WorkerService;
  stepHandlerRegistry: WorkflowStepHandlerRegistry;
  executorRegistry: JobExecutorRegistry;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface CreateWorkerRuntimeOptions {
  config?: Partial<WorkerConfig>;
  prisma?: PrismaClient;
  actionExecutor?: RecoveryActionExecutor;
}

/**
 * Creates the authoritative worker runtime shared between production entrypoint and tests.
 */
export function createWorkerRuntime(options: CreateWorkerRuntimeOptions = {}): WorkerRuntime {
  const config = loadWorkerConfig(options.config);
  const prisma = options.prisma ?? new PrismaClient();
  const workerService = new WorkerService(config, prisma, {
    actionExecutor: options.actionExecutor,
  });

  return {
    config,
    prisma,
    workerService,
    stepHandlerRegistry: workerService.getStepHandlerRegistry(),
    executorRegistry: workerService.getExecutorRegistry(),
    start: async () => {
      await workerService.start();
    },
    stop: async () => {
      await workerService.stop();
      if (!options.prisma) {
        await prisma.$disconnect();
      }
    },
  };
}
