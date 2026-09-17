import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';
import { ServiceHealth } from '@reloop/contracts';

@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  async getHealth(): Promise<ServiceHealth> {
    return this.healthService.check();
  }
}
