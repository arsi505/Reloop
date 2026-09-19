import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { ApproveRequestDto } from './dto/approve-request.dto';
import { RejectRequestDto } from './dto/reject-request.dto';
import { ApprovalQueryDto } from './dto/approval-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

@Controller('approvals')
@UseGuards(JwtAuthGuard)
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ApprovalQueryDto,
  ) {
    return this.approvalsService.listApprovals(user.organizationId, query.status);
  }

  @Get(':id')
  async getDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.approvalsService.getApprovalDetail(user.organizationId, id);
  }

  @Post(':id/approve')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN', 'OPERATOR')
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ApproveRequestDto,
  ) {
    return this.approvalsService.approveApproval(
      user.organizationId,
      id,
      user.userId,
      dto.note,
    );
  }

  @Post(':id/reject')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN', 'OPERATOR')
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectRequestDto,
  ) {
    return this.approvalsService.rejectApproval(
      user.organizationId,
      id,
      user.userId,
      dto.reason,
    );
  }
}
