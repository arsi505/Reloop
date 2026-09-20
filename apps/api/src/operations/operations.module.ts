import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './controllers/dashboard.controller';
import { ExceptionsController } from './controllers/exceptions.controller';
import { OrdersController } from './controllers/orders.controller';
import { RecoveriesController } from './controllers/recoveries.controller';
import { DashboardService } from './services/dashboard.service';
import { ExceptionsService } from './services/exceptions.service';
import { OrdersService } from './services/orders.service';
import { RecoveriesService } from './services/recoveries.service';
import { IntegrationHealthService } from './services/integration-health.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    DashboardController,
    ExceptionsController,
    OrdersController,
    RecoveriesController,
  ],
  providers: [
    DashboardService,
    ExceptionsService,
    OrdersService,
    RecoveriesService,
    IntegrationHealthService,
  ],
  exports: [
    DashboardService,
    ExceptionsService,
    OrdersService,
    RecoveriesService,
    IntegrationHealthService,
  ],
})
export class OperationsModule {}
