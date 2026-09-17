import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.substring(7);
    const secret = this.configService.get<string>('jwtAccessSecret');

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, { secret });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }

    // Always query authoritative database state for organization membership
    const membership = await this.prismaService.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: payload.orgId,
          userId: payload.sub,
        },
      },
    });

    if (!membership) {
      throw new UnauthorizedException('User is not an active member of this organization');
    }

    const authenticatedUser: AuthenticatedUser = {
      userId: payload.sub,
      email: payload.email,
      organizationId: payload.orgId,
      sessionId: payload.sessionId,
      role: membership.role,
    };

    request.user = authenticatedUser;
    return true;
  }
}
