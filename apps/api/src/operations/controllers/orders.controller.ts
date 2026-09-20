import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@reloop/database';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { OrdersService } from '../services/orders.service';
import {
  OrdersQueryDto,
  OrderListItemDto,
  OrderDetailDto,
} from '../dto/orders.dto';
import { PaginatedResponse } from '../dto/pagination.dto';

@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * Retrieves a paginated list of unified logical orders.
   * Accessible to OWNER, ADMIN, OPERATOR, VIEWER.
   */
  @Get()
  @Roles(Role.OWNER, Role.ADMIN, Role.OPERATOR, Role.VIEWER)
  async listOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OrdersQueryDto,
  ): Promise<PaginatedResponse<OrderListItemDto>> {
    return this.ordersService.listOrders(user.organizationId, query);
  }

  /**
   * Retrieves cross-system order detail showing factual state across connected systems.
   * Accessible to OWNER, ADMIN, OPERATOR, VIEWER.
   */
  @Get(':id')
  @Roles(Role.OWNER, Role.ADMIN, Role.OPERATOR, Role.VIEWER)
  async getOrderDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<OrderDetailDto> {
    return this.ordersService.getOrderDetail(user.organizationId, id);
  }
}
