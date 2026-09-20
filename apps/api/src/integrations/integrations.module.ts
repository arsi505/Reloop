import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsController } from './integrations.controller';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { ShopifyTokenRefreshService } from './shopify-token-refresh.service';
import { ShopifySyncService } from './shopify-sync.service';
import { ShipStationConnectionService } from './shipstation-connection.service';

import { OperationsModule } from '../operations/operations.module';

@Module({
  imports: [PrismaModule, AuthModule, OperationsModule],
  controllers: [IntegrationsController],
  providers: [
    ShopifyOAuthService,
    ShopifyTokenRefreshService,
    ShopifySyncService,
    ShipStationConnectionService,
  ],
  exports: [
    ShopifyOAuthService,
    ShopifyTokenRefreshService,
    ShopifySyncService,
    ShipStationConnectionService,
  ],
})
export class IntegrationsModule {}
