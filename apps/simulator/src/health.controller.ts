import { Controller, Get } from '@nestjs/common';
import { SimulatorHealthResponse } from '@reloop/connector-simulator';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): SimulatorHealthResponse {
    return {
      status: 'ok',
      service: 'simulator',
      providers: {
        shopify: 'ok',
        shipstation: 'ok',
        '3pl': 'ok',
      },
    };
  }
}