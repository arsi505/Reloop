import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@reloop/database';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RecoveriesService } from '../services/recoveries.service';
import {
  RecoveriesQueryDto,
  RecoveryListItemDto,
  RecoveryDetailDto,
} from '../dto/recoveries.dto';
import { PaginatedResponse } from '../dto/pagination.dto';

@Controller('recoveries')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RecoveriesController {
  constructor(private readonly recoveriesService: RecoveriesService) {}

  /**
   * Retrieves a paginated list of recovery workflows.
   * Accessible to OWNER, ADMIN, OPERATOR, VIEWER.
   */
  @Get()
  @Roles(Role.OWNER, Role.ADMIN, Role.OPERATOR, Role.VIEWER)
  async listRecoveries(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RecoveriesQueryDto,
  ): Promise<PaginatedResponse<RecoveryListItemDto>> {
    return this.recoveriesService.listRecoveries(user.organizationId, query);
  }

  /**
   * Retrieves flight recorder detail and chronological factual timeline for a recovery.
   * Accessible to OWNER, ADMIN, OPERATOR, VIEWER.
   */
  @Get(':id')
  @Roles(Role.OWNER, Role.ADMIN, Role.OPERATOR, Role.VIEWER)
  async getRecoveryDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<RecoveryDetailDto> {
    return this.recoveriesService.getRecoveryDetail(user.organizationId, id);
  }
}
