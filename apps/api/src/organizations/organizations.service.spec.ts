import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@reloop/database';

describe('OrganizationsService', () => {
  let service: OrganizationsService;
  // let prisma: PrismaService;

  const mockPrisma = {
    organization: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    organizationMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<OrganizationsService>(OrganizationsService);
    // prisma = module.get<PrismaService>(PrismaService);
  });

  describe('getCurrentOrganization', () => {
    it('should return the organization if found', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: 'org-1',
        name: 'Alpha Corp',
        slug: 'alpha-corp',
        createdAt: new Date(),
      });

      const result = await service.getCurrentOrganization('org-1');
      expect(result.id).toBe('org-1');
      expect(result.name).toBe('Alpha Corp');
      expect(mockPrisma.organization.findUnique).toHaveBeenCalledWith({
        where: { id: 'org-1' },
      });
    });

    it('should throw NotFoundException if organization does not exist', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      await expect(service.getCurrentOrganization('org-nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getOrganizationByIdForMember', () => {
    it('should return organization if user is an active member', async () => {
      mockPrisma.organizationMember.findUnique.mockResolvedValue({
        organizationId: 'org-1',
        userId: 'user-1',
        role: Role.VIEWER,
        organization: {
          id: 'org-1',
          name: 'Alpha Corp',
          slug: 'alpha-corp',
          createdAt: new Date(),
        },
      });

      const result = await service.getOrganizationByIdForMember('user-1', 'org-1');
      expect(result.id).toBe('org-1');
      expect(result.name).toBe('Alpha Corp');
    });

    it('should throw NotFoundException (safe 404) if user has no membership in requested org', async () => {
      mockPrisma.organizationMember.findUnique.mockResolvedValue(null);

      await expect(
        service.getOrganizationByIdForMember('user-1', 'org-foreign'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateCurrentOrganization', () => {
    it('should update organization name for valid organization', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: 'org-1',
        name: 'Old Name',
      });
      mockPrisma.organization.update.mockResolvedValue({
        id: 'org-1',
        name: 'New Name',
        slug: 'alpha-corp',
        createdAt: new Date(),
      });

      const result = await service.updateCurrentOrganization('org-1', {
        name: 'New Name',
      });
      expect(result.name).toBe('New Name');
      expect(mockPrisma.organization.update).toHaveBeenCalledWith({
        where: { id: 'org-1' },
        data: { name: 'New Name' },
      });
    });
  });

  describe('getOrganizationMembers', () => {
    it('should query members scoped strictly to organizationId', async () => {
      mockPrisma.organizationMember.findMany.mockResolvedValue([
        {
          id: 'mem-1',
          userId: 'user-1',
          organizationId: 'org-1',
          role: Role.OWNER,
          createdAt: new Date(),
          user: { id: 'user-1', name: 'Alice', email: 'alice@alpha.com' },
        },
      ]);

      const members = await service.getOrganizationMembers('org-1');
      expect(members).toHaveLength(1);
      expect(members[0].name).toBe('Alice');
      expect(mockPrisma.organizationMember.findMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
        include: { user: true },
        orderBy: { createdAt: 'asc' },
      });
    });
  });
});