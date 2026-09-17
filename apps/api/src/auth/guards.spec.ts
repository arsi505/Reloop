import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './guards/roles.guard';
import { OriginGuard } from './guards/origin.guard';
import { ConfigService } from '@nestjs/config';

describe('Guards', () => {
  describe('RolesGuard', () => {
    let guard: RolesGuard;
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      guard = new RolesGuard(reflector);
    });

    function createMockContext(userRole?: string): ExecutionContext {
      return {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            user: userRole ? { role: userRole } : undefined,
          }),
        }),
      } as unknown as ExecutionContext;
    }

    it('should allow access if no roles are required', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
      const context = createMockContext('VIEWER');
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access if user has required role (OWNER)', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['OWNER', 'ADMIN']);
      const context = createMockContext('OWNER');
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should forbid access if user role does not match (VIEWER forbidden from OWNER/ADMIN)', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['OWNER', 'ADMIN']);
      const context = createMockContext('VIEWER');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should forbid access if user role does not match (OPERATOR forbidden from OWNER/ADMIN)', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['OWNER', 'ADMIN']);
      const context = createMockContext('OPERATOR');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('OriginGuard', () => {
    let guard: OriginGuard;
    let configService: ConfigService;

    beforeEach(() => {
      configService = {
        get: jest.fn((key: string) => {
          if (key === 'frontendUrl') return 'http://localhost:3100';
          if (key === 'nodeEnv') return 'production';
          return null;
        }),
      } as unknown as ConfigService;
      guard = new OriginGuard(configService);
    });

    function createMockContext(origin?: string): ExecutionContext {
      return {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: origin ? { origin } : {},
          }),
        }),
      } as unknown as ExecutionContext;
    }

    it('should allow matching origin', () => {
      const context = createMockContext('http://localhost:3100');
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should reject mismatched origin in production', () => {
      const context = createMockContext('http://malicious-site.com');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });
});