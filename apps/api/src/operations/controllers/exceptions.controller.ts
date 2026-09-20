import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@reloop/database';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ExceptionsService } from '../services/exceptions.service';
import {
  ExceptionsQueryDto,
  ExceptionListItemDto,
  ExceptionDetailDto,
} from '../dto/exceptions.dto';
import { PaginatedResponse } from '../dto/pagination.dto';

@Controller('exceptions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExceptionsController {
  constructor(private readonly exceptionsService: ExceptionsService) {}

  /**
   * Retrieves a paginated list of exceptions with server-side filtering.
   * Accessible to OWNER, ADMIN, OPERATOR, VIEWER.
   */
  @Get()
  @Roles(Role.OWNER, Role.ADMIN, Role.OPERATOR, Role.VIEWER)
  async listExceptions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ExceptionsQueryDto,
  ): Promise<PaginatedResponse<ExceptionListItemDto>> {
    return this.exceptionsService.listExceptions(user.organizationId, query);
  }

  /**
   * Retrieves sanitized detail for an exception.
   * Tenant isolated: returns 404 for cross-tenant lookups.
   * Accessible to OWNER, ADMIN, OPERATOR, VIEWER.
   */
  @Get(':id')
  @Roles(Role.OWNER, Role.ADMIN, Role.OPERATOR, Role.VIEWER)
  async getExceptionDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ExceptionDetailDto> {
    return this.exceptionsService.getExceptionDetail(user.organizationId, id);
  }
}
