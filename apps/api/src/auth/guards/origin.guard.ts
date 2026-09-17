import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const origin = request.headers.origin;
    const frontendUrl = this.configService.get<string>('frontendUrl') || 'http://localhost:3100';

    // If Origin is present, strictly enforce match with FRONTEND_URL
    if (origin) {
      if (origin !== frontendUrl) {
        throw new ForbiddenException(`Cross-origin request rejected: ${origin}`);
      }
    }

    return true;
  }
}
