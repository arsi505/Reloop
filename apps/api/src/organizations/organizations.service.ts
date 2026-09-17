import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationDto, OrganizationMemberDto, Role } from '@reloop/contracts';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentOrganization(orgId: string): Promise<OrganizationDto> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });

    if (!org) {
      throw new NotFoundException('Organization not found');
    }

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: org.createdAt.toISOString(),
    };
  }

  async getOrganizationByIdForMember(
    userId: string,
    targetOrgId: string,
  ): Promise<OrganizationDto> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: targetOrgId,
          userId,
        },
      },
      include: {
        organization: true,
      },
    });

    if (!membership) {
      throw new NotFoundException('Organization not found');
    }

    return {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      createdAt: membership.organization.createdAt.toISOString(),
    };
  }

  async updateCurrentOrganization(
    orgId: string,
    dto: UpdateOrganizationDto,
  ): Promise<OrganizationDto> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });

    if (!org) {
      throw new NotFoundException('Organization not found');
    }

    const updated = await this.prisma.organization.update({
      where: { id: orgId },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
      },
    });

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  async getOrganizationMembers(orgId: string): Promise<OrganizationMemberDto[]> {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId: orgId },
      include: {
        user: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((m) => ({
      id: m.id,
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role as Role,
      createdAt: m.createdAt.toISOString(),
    }));
  }
}