import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('SimulatorBootstrap');
  const app = await NestFactory.create(AppModule);

  const port = parseInt(process.env.SIMULATOR_PORT || '3102', 10);

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  await app.listen(port);
  logger.log(`External System Simulator running and listening on port ${port}`);
  logger.log(`Health endpoint: http://localhost:${port}/health`);
  logger.log(`Control endpoints: http://localhost:${port}/_simulator/*`);
}

bootstrap();