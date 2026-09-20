import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimePublisher } from './realtime.publisher';
import { RealtimeSubscriber } from './realtime.subscriber';

@Global()
@Module({
  imports: [PrismaModule, RedisModule, ConfigModule, JwtModule],
  providers: [RealtimeGateway, RealtimePublisher, RealtimeSubscriber],
  exports: [RealtimePublisher, RealtimeGateway],
})
export class RealtimeModule {}
