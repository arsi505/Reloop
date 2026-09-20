import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Param,
  UseGuards,
  NotFoundException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Role, Prisma } from '@reloop/database';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { ShopifySyncService } from './shopify-sync.service';
import { ConnectShopifyDto } from './dto/connect-shopify.dto';
import { ConnectShipStationDto } from './dto/connect-shipstation.dto';
import { ShopifyCallbackQueryDto } from './dto/shopify-callback-query.dto';
import { IntegrationStatusResponseDto } from './dto/integration-status-response.dto';
import { ShipStationConnectionService } from './shipstation-connection.service';

@Controller('integrations')
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyOAuth: ShopifyOAuthService,
    private readonly shopifySync: ShopifySyncService,
    private readonly shipstationConnection: ShipStationConnectionService,
  ) {}

  /**
   * Initiates Shopify OAuth connection.
   * Restricted to OWNER and ADMIN roles.
   */
  @Post('shopify/connect')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  async connectShopify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConnectShopifyDto,
  ) {
    return this.shopifyOAuth.initiateConnect(user.organizationId, user.userId, body.shop);
  }

  /**
   * Connects ShipStation integration with API Key.
   * Restricted to OWNER and ADMIN roles.
   */
  @Post('shipstation/connect')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  async connectShipStation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConnectShipStationDto,
  ) {
    return this.shipstationConnection.connect(user.organizationId, user.userId, body.apiKey);
  }

  /**
   * Replaces credentials for an existing ShipStation integration.
   * Restricted to OWNER and ADMIN roles.
   */
  @Post('shipstation/:id/credentials/replace')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  async replaceShipStationCredentials(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: ConnectShipStationDto,
  ) {
    return this.shipstationConnection.replaceCredentials(
      user.organizationId,
      user.userId,
      id,
      body.apiKey,
    );
  }

  /**
   * Public OAuth callback receiver redirected to by Shopify.
   * State and HMAC authenticated.
   */
  @Get('shopify/callback')
  async shopifyCallback(@Query() query: ShopifyCallbackQueryDto) {
    const result = await this.shopifyOAuth.handleCallback(query);

    return {
      success: true,
      message: 'Shopify store connected successfully',
      integrationId: result.integrationId,
      shopDomain: result.shopDomain,
    };
  }

  /**
   * Retrieves safe integration status.
   * Accessible by all organization roles: OWNER, ADMIN, OPERATOR, VIEWER.
   * Strictly never returns encrypted or plaintext credentials.
   */
  @Get(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.OPERATOR, Role.VIEWER)
  async getIntegrationStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<IntegrationStatusResponseDto> {
    const integration = await this.prisma.integration.findFirst({
      where: {
        id,
        organizationId: user.organizationId,
      },
    });

    if (!integration) {
      throw new NotFoundException(`Integration ${id} not found in this organization`);
    }

    const config = (integration.configuration as Record<string, any>) || {};

    return {
      id: integration.id,
      organizationId: integration.organizationId,
      provider: integration.provider,
      name: integration.name,
      status: integration.status,
      mode: integration.mode,
      shopDomain: integration.shopDomain,
      scopes: config.scopes,
      createdAt: integration.createdAt,
      updatedAt: integration.updatedAt,
    };
  }

  /**
   * Disconnects an integration.
   * Restricted to OWNER and ADMIN.
   * Sets status to DISCONNECTED and blanks stored credentials safely.
   * Preserves historical RecoveryCases and audit logs.
   */
  @Post(':id/disconnect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  async disconnectIntegration(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const integration = await this.prisma.integration.findFirst({
      where: {
        id,
        organizationId: user.organizationId,
      },
    });

    if (!integration) {
      throw new NotFoundException(`Integration ${id} not found in this organization`);
    }

    await this.prisma.integration.update({
      where: { id },
      data: {
        status: 'DISCONNECTED',
        encryptedCredentials: Prisma.DbNull,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.userId,
        entityType: 'INTEGRATION',
        entityId: id,
        action: `${integration.provider}_INTEGRATION_DISCONNECTED`,
        metadata: {
          provider: integration.provider,
          shopDomain: integration.shopDomain,
        },
      },
    });

    return {
      success: true,
      message: 'Integration disconnected successfully',
      integrationId: id,
    };
  }
}
