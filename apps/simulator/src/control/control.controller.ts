import { Controller, Post, Get, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { SimulatorStateService } from '../state/simulator-state.service';
import { ScenarioRunnerService } from '../scenarios/scenario-runner.service';
import { ScenarioName, FaultRule } from '@reloop/connector-simulator';

@Controller('_simulator')
export class ControlController {
  constructor(
    private readonly stateService: SimulatorStateService,
    private readonly scenarioRunner: ScenarioRunnerService,
  ) {}

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  reset() {
    this.stateService.reset();
    return {
      success: true,
      message: 'Simulator in-memory state reset successfully. Reloop database untouched.',
    };
  }

  @Post('seed/:scenario')
  @HttpCode(HttpStatus.OK)
  seedScenario(@Param('scenario') scenario: string) {
    return this.scenarioRunner.seedScenario(scenario as ScenarioName);
  }

  @Post('faults')
  @HttpCode(HttpStatus.CREATED)
  addFaultRule(@Body() rule: FaultRule) {
    const created = this.stateService.addFaultRule(rule);
    return {
      success: true,
      rule: created,
    };
  }

  @Get('state')
  getState() {
    return this.stateService.getFullState();
  }
}