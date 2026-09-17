import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityUtil } from './security.util';
import { Role } from '@reloop/database';

describe('AuthService', () => {
  let service: AuthService;
  // let prisma: PrismaService;
  // let jwtService: JwtService;

  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    organizationMember: {
      findUnique: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
    refreshSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockJwtService = {
    sign: jest.fn().mockReturnValue('mock_jwt_access_token'),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'jwtAccessSecret') return 'test_secret_with_sufficient_length_32_characters';
      if (key === 'jwtAccessTtl') return '15m';
      if (key === 'refreshSessionTtlDays') return 7;
      return null;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    // prisma = module.get<PrismaService>(PrismaService);
    // jwtService = module.get<JwtService>(JwtService);
  });

  describe('register', () => {
    it('should throw ConflictException if email is already registered', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing-id' });

      await expect(
        service.register({
          name: 'Jane Doe',
          email: 'jane@brand.com',
          password: 'Password123!',
          organizationName: 'Brand Co',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should atomically register a user, organization, member as OWNER, and session', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      const fakeUser = {
        id: 'user-1',
        email: 'jane@brand.com',
        name: 'Jane Doe',
        createdAt: new Date(),
      };
      const fakeOrg = {
        id: 'org-1',
        name: 'Brand Co',
        slug: 'brand-co',
        createdAt: new Date(),
      };
      const fakeMember = {
        id: 'member-1',
        userId: 'user-1',
        organizationId: 'org-1',
        role: Role.OWNER,
      };
      const fakeSession = {
        id: 'session-1',
        userId: 'user-1',
        organizationId: 'org-1',
      };

      mockPrisma.$transaction.mockImplementation(async (callback) => {
        return callback({
          user: { create: jest.fn().mockResolvedValue(fakeUser) },
          organization: { create: jest.fn().mockResolvedValue(fakeOrg) },
          organizationMember: { create: jest.fn().mockResolvedValue(fakeMember) },
          refreshSession: { create: jest.fn().mockResolvedValue(fakeSession) },
        });
      });

      const result = await service.register({
        name: 'Jane Doe',
        email: 'jane@brand.com',
        password: 'Password123!',
        organizationName: 'Brand Co',
      });

      expect(result.user.email).toBe('jane@brand.com');
      expect(result.organization.slug).toBe('brand-co');
      expect(result.role).toBe('OWNER');
      expect(result.accessToken).toBe('mock_jwt_access_token');
      expect(result.rawRefreshToken).toContain('session-1.');
    });
  });

  describe('login', () => {
    it('should throw UnauthorizedException for unknown email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'unknown@brand.com', password: 'password' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for incorrect password', async () => {
      const realHash = await SecurityUtil.hashPassword('correct-password');
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'jane@brand.com',
        passwordHash: realHash,
        memberships: [{ organization: { id: 'org-1' }, role: Role.OWNER }],
      });

      await expect(
        service.login({ email: 'jane@brand.com', password: 'wrong-password' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should issue access token and new session on valid credentials', async () => {
      const realHash = await SecurityUtil.hashPassword('correct-password');
      const fakeUser = {
        id: 'user-1',
        email: 'jane@brand.com',
        name: 'Jane',
        passwordHash: realHash,
        createdAt: new Date(),
        memberships: [
          {
            organization: {
              id: 'org-1',
              name: 'Brand Co',
              slug: 'brand-co',
              createdAt: new Date(),
            },
            role: Role.OWNER,
          },
        ],
      };

      mockPrisma.user.findUnique.mockResolvedValue(fakeUser);
      mockPrisma.refreshSession.create.mockResolvedValue({
        id: 'session-2',
        userId: 'user-1',
        organizationId: 'org-1',
      });

      const result = await service.login({
        email: 'jane@brand.com',
        password: 'correct-password',
      });

      expect(result.user.id).toBe('user-1');
      expect(result.role).toBe('OWNER');
      expect(result.accessToken).toBe('mock_jwt_access_token');
      expect(result.rawRefreshToken).toContain('session-2.');
    });
  });

  describe('refresh', () => {
    it('should throw UnauthorizedException if cookie is missing or malformed', async () => {
      await expect(service.refresh(undefined)).rejects.toThrow(UnauthorizedException);
      await expect(service.refresh('invalid-cookie')).rejects.toThrow(UnauthorizedException);
    });

    it('should rotate token and update session when valid', async () => {
      const secret = 'valid_secret_token_1234567890123';
      const tokenHash = SecurityUtil.hashToken(secret);
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);

      const fakeSession = {
        id: 'sess-1',
        userId: 'user-1',
        organizationId: 'org-1',
        tokenHash,
        revokedAt: null,
        expiresAt: futureDate,
        user: { id: 'user-1', email: 'jane@brand.com', name: 'Jane', createdAt: new Date() },
        organization: { id: 'org-1', name: 'Org 1', slug: 'org-1', createdAt: new Date() },
      };

      mockPrisma.refreshSession.findUnique.mockResolvedValue(fakeSession);
      mockPrisma.organizationMember.findUnique.mockResolvedValue({
        role: Role.ADMIN,
      });
      mockPrisma.refreshSession.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.refresh(`sess-1.${secret}`);
      expect(result.user.id).toBe('user-1');
      expect(result.role).toBe('ADMIN');
      expect(result.rawRefreshToken).toContain('sess-1.');
      expect(mockPrisma.refreshSession.updateMany).toHaveBeenCalled();
    });

    it('should reject reused / already rotated refresh tokens (CAS failure)', async () => {
      const secret = 'valid_secret_token_1234567890123';
      const tokenHash = SecurityUtil.hashToken(secret);
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);

      const fakeSession = {
        id: 'sess-1',
        userId: 'user-1',
        organizationId: 'org-1',
        tokenHash,
        revokedAt: null,
        expiresAt: futureDate,
        user: { id: 'user-1', email: 'jane@brand.com', name: 'Jane', createdAt: new Date() },
        organization: { id: 'org-1', name: 'Org 1', slug: 'org-1', createdAt: new Date() },
      };

      mockPrisma.refreshSession.findUnique.mockResolvedValue(fakeSession);
      mockPrisma.organizationMember.findUnique.mockResolvedValue({
        role: Role.ADMIN,
      });
      // Simulate race condition or already rotated token (count === 0)
      mockPrisma.refreshSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.refresh(`sess-1.${secret}`)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject revoked sessions', async () => {
      const secret = 'valid_secret_token_1234567890123';
      const fakeSession = {
        id: 'sess-1',
        tokenHash: SecurityUtil.hashToken(secret),
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 100000),
      };

      mockPrisma.refreshSession.findUnique.mockResolvedValue(fakeSession);
      await expect(service.refresh(`sess-1.${secret}`)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('getMe', () => {
    it('should return user and organization information for active member', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'jane@brand.com',
        name: 'Jane',
        createdAt: new Date(),
      });

      mockPrisma.organizationMember.findUnique.mockResolvedValue({
        role: Role.OWNER,
        organization: {
          id: 'org-1',
          name: 'Brand Co',
          slug: 'brand-co',
          createdAt: new Date(),
        },
      });

      const me = await service.getMe('user-1', 'org-1');
      expect(me.user.id).toBe('user-1');
      expect(me.organization.id).toBe('org-1');
      expect(me.role).toBe('OWNER');
    });

    it('should throw UnauthorizedException if member is no longer in org', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrisma.organizationMember.findUnique.mockResolvedValue(null);

      await expect(service.getMe('user-1', 'org-other')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});