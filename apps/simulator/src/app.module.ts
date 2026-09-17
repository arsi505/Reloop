import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { SimulatorStateService } from './state/simulator-state.service';
import { ScenarioRunnerService } from './scenarios/scenario-runner.service';
import { FaultInjectionInterceptor } from './common/fault-injection.interceptor';
import { SimulatorExceptionFilter } from './common/simulator-exception.filter';
import { HealthController } from './health.controller';
import { ControlController } from './control/control.controller';
import { ShopifyController } from './shopify/shopify.controller';
import { ShipStationController } from './shipstation/shipstation.controller';
import { ThreePlController } from './three-pl/three-pl.controller';

@Module({
  controllers: [
    HealthController,
    ControlController,
    ShopifyController,
    ShipStationController,
    ThreePlController,
  ],
  providers: [
    SimulatorStateService,
    ScenarioRunnerService,
    {
      provide: APP_INTERCEPTOR,
      useClass: FaultInjectionInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: SimulatorExceptionFilter,
    },
  ],
  exports: [SimulatorStateService, ScenarioRunnerService],
})
export class AppModule {}