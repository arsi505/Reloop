import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { OriginGuard } from '../auth/guards/origin.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { OrganizationDto, OrganizationMemberDto } from '@reloop/contracts';

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('current')
  async getCurrent(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationDto> {
    return this.organizationsService.getCurrentOrganization(user.organizationId);
  }

  @Get('current/members')
  async getMembers(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationMemberDto[]> {
    return this.organizationsService.getOrganizationMembers(user.organizationId);
  }

  @Get(':organizationId')
  async getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId') organizationId: string,
  ): Promise<OrganizationDto> {
    return this.organizationsService.getOrganizationByIdForMember(
      user.userId,
      organizationId,
    );
  }

  @Patch('current')
  @UseGuards(OriginGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  async updateCurrent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateOrganizationDto,
  ): Promise<OrganizationDto> {
    return this.organizationsService.updateCurrentOrganization(
      user.organizationId,
      dto,
    );
  }
}