import { Controller, Get, UseGuards } from '@nestjs/common';
import { Role } from '@reloop/database';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { DashboardService } from '../services/dashboard.service';
import { DashboardSummaryDto } from '../dto/dashboard-summary.dto';

@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * Retrieves tenant-scoped operational dashboard summary metrics.
   * Uses efficient database aggregation; zero unbounded in-memory loading.
   * Accessible to OWNER, ADMIN, OPERATOR, VIEWER.
   */
  @Get('summary')
  @Roles(Role.OWNER, Role.ADMIN, Role.OPERATOR, Role.VIEWER)
  async getSummary(@CurrentUser() user: AuthenticatedUser): Promise<DashboardSummaryDto> {
    return this.dashboardService.getDashboardSummary(user.organizationId);
  }
}
