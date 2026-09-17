import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityUtil } from './security.util';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Role } from '@reloop/database';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { AuthResponseDto, MeResponseDto, UserDto, OrganizationDto } from '@reloop/contracts';

export interface InternalAuthResult extends AuthResponseDto {
  rawRefreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private getJwtSecret(): string {
    const secret = this.configService.get<string>('jwtAccessSecret');
    if (!secret) {
      throw new Error('Configuration error: JWT_ACCESS_SECRET is required');
    }
    return secret;
  }

  private getJwtTtl(): string {
    return this.configService.get<string>('jwtAccessTtl') || '15m';
  }

  private getRefreshTtlDays(): number {
    return this.configService.get<number>('refreshSessionTtlDays') || 7;
  }

  private async generateUniqueSlug(name: string): Promise<string> {
    const baseSlug = SecurityUtil.generateSlug(name);
    let slug = baseSlug;
    let counter = 1;

    while (await this.prisma.organization.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    return slug;
  }

  private signAccessToken(payload: JwtPayload): string {
    return this.jwtService.sign(
      {
        ...payload,
        jti: SecurityUtil.generateRandomToken(16),
      },
      {
        secret: this.getJwtSecret(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expiresIn: this.getJwtTtl() as any,
      },
    );
  }

  async register(dto: RegisterDto): Promise<InternalAuthResult> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await SecurityUtil.hashPassword(dto.password);
    const slug = await this.generateUniqueSlug(dto.organizationName);

    const refreshSecret = SecurityUtil.generateRandomToken(32);
    const tokenHash = SecurityUtil.hashToken(refreshSecret);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.getRefreshTtlDays());

    // Atomic transaction creates User -> Organization -> Member (OWNER) -> RefreshSession
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name.trim(),
          email: normalizedEmail,
          passwordHash,
        },
      });

      const organization = await tx.organization.create({
        data: {
          name: dto.organizationName.trim(),
          slug,
        },
      });

      const member = await tx.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: Role.OWNER,
        },
      });

      const session = await tx.refreshSession.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          tokenHash,
          expiresAt,
        },
      });

      return { user, organization, member, session };
    });

    const jwtPayload: JwtPayload = {
      sub: result.user.id,
      email: result.user.email,
      orgId: result.organization.id,
      sessionId: result.session.id,
      type: 'access',
    };

    const accessToken = this.signAccessToken(jwtPayload);
    const rawRefreshToken = `${result.session.id}.${refreshSecret}`;

    this.logger.log(`User registered: userId=${result.user.id}, orgId=${result.organization.id}`);

    const safeUser: UserDto = {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      createdAt: result.user.createdAt.toISOString(),
    };

    const safeOrg: OrganizationDto = {
      id: result.organization.id,
      name: result.organization.name,
      slug: result.organization.slug,
      createdAt: result.organization.createdAt.toISOString(),
    };

    return {
      user: safeUser,
      organization: safeOrg,
      role: 'OWNER',
      accessToken,
      rawRefreshToken,
    };
  }

  async login(dto: LoginDto): Promise<InternalAuthResult> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        memberships: {
          include: { organization: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await SecurityUtil.verifyPassword(
      user.passwordHash,
      dto.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.memberships || user.memberships.length === 0) {
      throw new UnauthorizedException('No active organization membership found');
    }

    // Default to the user's primary/first organization membership for Day 3
    const primaryMembership = user.memberships[0];
    const organization = primaryMembership.organization;

    const refreshSecret = SecurityUtil.generateRandomToken(32);
    const tokenHash = SecurityUtil.hashToken(refreshSecret);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.getRefreshTtlDays());

    const session = await this.prisma.refreshSession.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        tokenHash,
        expiresAt,
      },
    });

    const jwtPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      orgId: organization.id,
      sessionId: session.id,
      type: 'access',
    };

    const accessToken = this.signAccessToken(jwtPayload);
    const rawRefreshToken = `${session.id}.${refreshSecret}`;

    this.logger.log(`User logged in: userId=${user.id}, orgId=${organization.id}`);

    const safeUser: UserDto = {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    };

    const safeOrg: OrganizationDto = {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt.toISOString(),
    };

    return {
      user: safeUser,
      organization: safeOrg,
      role: primaryMembership.role as Role,
      accessToken,
      rawRefreshToken,
    };
  }

  async refresh(cookieValue: string | undefined): Promise<InternalAuthResult> {
    if (!cookieValue) {
      throw new UnauthorizedException('Missing refresh session cookie');
    }

    const parts = cookieValue.split('.');
    if (parts.length !== 2) {
      throw new UnauthorizedException('Malformed refresh token');
    }

    const [sessionId, secret] = parts;

    const session = await this.prisma.refreshSession.findUnique({
      where: { id: sessionId },
      include: {
        user: true,
        organization: true,
      },
    });

    if (!session) {
      throw new UnauthorizedException('Invalid refresh session');
    }

    if (session.revokedAt) {
      throw new UnauthorizedException('Refresh session has been revoked');
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh session has expired');
    }

    const providedHash = SecurityUtil.hashToken(secret);
    if (session.tokenHash !== providedHash) {
      throw new UnauthorizedException('Invalid refresh token secret');
    }

    // Confirm active membership in database
    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: session.organizationId,
          userId: session.userId,
        },
      },
    });

    if (!membership) {
      throw new UnauthorizedException('Organization membership revoked');
    }

    // Atomic CAS rotation: replace tokenHash with hash of NEW secret
    const newSecret = SecurityUtil.generateRandomToken(32);
    const newTokenHash = SecurityUtil.hashToken(newSecret);

    const updateResult = await this.prisma.refreshSession.updateMany({
      where: {
        id: sessionId,
        tokenHash: providedHash,
        revokedAt: null,
      },
      data: {
        tokenHash: newTokenHash,
        lastUsedAt: new Date(),
      },
    });

    if (updateResult.count === 0) {
      throw new UnauthorizedException('Refresh token rotation conflict: token already rotated or revoked');
    }

    const jwtPayload: JwtPayload = {
      sub: session.user.id,
      email: session.user.email,
      orgId: session.organization.id,
      sessionId: session.id,
      type: 'access',
    };

    const accessToken = this.signAccessToken(jwtPayload);
    const rawRefreshToken = `${session.id}.${newSecret}`;

    const safeUser: UserDto = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      createdAt: session.user.createdAt.toISOString(),
    };

    const safeOrg: OrganizationDto = {
      id: session.organization.id,
      name: session.organization.name,
      slug: session.organization.slug,
      createdAt: session.organization.createdAt.toISOString(),
    };

    return {
      user: safeUser,
      organization: safeOrg,
      role: membership.role as Role,
      accessToken,
      rawRefreshToken,
    };
  }

  async logout(cookieValue: string | undefined): Promise<{ success: boolean }> {
    if (cookieValue) {
      const parts = cookieValue.split('.');
      if (parts.length === 2) {
        const [sessionId, secret] = parts;
        const providedHash = SecurityUtil.hashToken(secret);
        await this.prisma.refreshSession.updateMany({
          where: {
            id: sessionId,
            tokenHash: providedHash,
            revokedAt: null,
          },
          data: {
            revokedAt: new Date(),
          },
        });
      }
    }

    return { success: true };
  }

  async logoutAll(userId: string): Promise<{ success: boolean }> {
    await this.prisma.refreshSession.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return { success: true };
  }

  async getMe(userId: string, organizationId: string): Promise<MeResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId,
        },
      },
      include: { organization: true },
    });

    if (!membership) {
      throw new UnauthorizedException('User is not an active member of this organization');
    }

    const safeUser: UserDto = {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    };

    const safeOrg: OrganizationDto = {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      createdAt: membership.organization.createdAt.toISOString(),
    };

    return {
      user: safeUser,
      organization: safeOrg,
      role: membership.role as Role,
    };
  }
}
