import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthService } from './health.service';
import { ServiceHealth } from '@reloop/contracts';

@Controller()
@SkipThrottle()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  async getHealth(): Promise<ServiceHealth> {
    return this.healthService.check();
  }
}