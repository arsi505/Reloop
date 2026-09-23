import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { HealthService } from './health.service';
import { ServiceHealth } from '@reloop/contracts';

@Controller()
@SkipThrottle()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  async getHealth(@Res({ passthrough: true }) res?: Response): Promise<ServiceHealth> {
    const health = await this.healthService.check();
    if (health.status !== 'ok' && res) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return health;
  }
}