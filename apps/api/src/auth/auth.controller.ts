import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OriginGuard } from './guards/origin.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { AuthResponseDto, MeResponseDto } from '@reloop/contracts';

@Controller('auth')
export class AuthController {
  private readonly cookieName: string;
  private readonly isProduction: boolean;
  private readonly refreshTtlDays: number;
  private readonly cookiePath: string = '/auth';

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    this.cookieName = this.configService.get<string>('refreshCookieName') || 'reloop_refresh';
    this.isProduction = this.configService.get<string>('nodeEnv') === 'production';
    this.refreshTtlDays = this.configService.get<number>('refreshSessionTtlDays') || 7;
  }

  private setRefreshCookie(res: Response, rawRefreshToken: string): void {
    const maxAge = this.refreshTtlDays * 24 * 60 * 60 * 1000;
    res.cookie(this.cookieName, rawRefreshToken, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      path: this.cookiePath,
      maxAge,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(this.cookieName, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      path: this.cookiePath,
    });
  }

  @Post('register')
  @UseGuards(OriginGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 }, auth: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.authService.register(dto);
    this.setRefreshCookie(res, result.rawRefreshToken);

    return {
      user: result.user,
      organization: result.organization,
      role: result.role,
      accessToken: result.accessToken,
    };
  }

  @Post('login')
  @UseGuards(OriginGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 }, auth: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.authService.login(dto);
    this.setRefreshCookie(res, result.rawRefreshToken);

    return {
      user: result.user,
      organization: result.organization,
      role: result.role,
      accessToken: result.accessToken,
    };
  }

  @Post('refresh')
  @UseGuards(OriginGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 }, auth: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const cookieValue = req.cookies?.[this.cookieName];
    if (!cookieValue) {
      throw new UnauthorizedException('Missing refresh session cookie');
    }

    const result = await this.authService.refresh(cookieValue);
    this.setRefreshCookie(res, result.rawRefreshToken);

    return {
      user: result.user,
      organization: result.organization,
      role: result.role,
      accessToken: result.accessToken,
    };
  }

  @Post('logout')
  @UseGuards(OriginGuard)
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    const cookieValue = req.cookies?.[this.cookieName];
    await this.authService.logout(cookieValue);
    this.clearRefreshCookie(res);
    return { success: true };
  }

  @Post('logout-all')
  @UseGuards(OriginGuard, JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    await this.authService.logoutAll(user.userId);
    this.clearRefreshCookie(res);
    return { success: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@CurrentUser() user: AuthenticatedUser): Promise<MeResponseDto> {
    return this.authService.getMe(user.userId, user.organizationId);
  }
}