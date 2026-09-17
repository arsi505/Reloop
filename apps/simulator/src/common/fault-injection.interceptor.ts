import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { SimulatorStateService } from '../state/simulator-state.service';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class FaultInjectionInterceptor implements NestInterceptor {
  constructor(private readonly stateService: SimulatorStateService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const path = req.path || req.url;
    const method = req.method;

    // Control endpoints and health check endpoints bypass fault injection
    if (path.startsWith('/_simulator') || path === '/health') {
      return next.handle();
    }

    let provider = 'all';
    if (path.startsWith('/shopify')) provider = 'shopify';
    else if (path.startsWith('/shipstation')) provider = 'shipstation';
    else if (path.startsWith('/3pl')) provider = '3pl';

    const fault = this.stateService.getMatchingFault(provider, method, path);
    if (!fault) {
      return next.handle();
    }

    switch (fault.fault) {
      case 'SUCCESS':
        return next.handle();

      case 'RETURN_429': {
        const retryAfter = fault.retryAfterSeconds || 5;
        res.setHeader('Retry-After', retryAfter.toString());
        throw new HttpException(
          {
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'Too many requests to provider API',
              retryable: true,
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      case 'RETURN_503':
        throw new HttpException(
          {
            error: {
              code: 'SIMULATED_SERVICE_UNAVAILABLE',
              message: `${provider.toUpperCase()} service temporarily unavailable`,
              retryable: true,
            },
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );

      case 'INVALID_SKU':
        throw new HttpException(
          {
            error: {
              code: 'INVALID_SKU',
              message: 'Specified SKU is unrecognized or discontinued',
              retryable: false,
            },
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );

      case 'INVALID_ADDRESS':
        throw new HttpException(
          {
            error: {
              code: 'INVALID_ADDRESS',
              message: 'Shipping address postal code or format is invalid',
              retryable: false,
            },
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );

      case 'ORDER_NOT_FOUND':
        throw new HttpException(
          {
            error: {
              code: 'ORDER_NOT_FOUND',
              message: 'Order not found in external system',
              retryable: false,
            },
          },
          HttpStatus.NOT_FOUND,
        );

      case 'DUPLICATE_ORDER':
        throw new HttpException(
          {
            error: {
              code: 'DUPLICATE_ORDER',
              message: 'Order with this external reference already exists in warehouse',
              retryable: false,
            },
          },
          HttpStatus.CONFLICT,
        );

      case 'TIMEOUT':
        return from(delay(fault.delayMs || 300)).pipe(
          switchMap(() =>
            throwError(
              () =>
                new HttpException(
                  {
                    error: {
                      code: 'GATEWAY_TIMEOUT',
                      message: `Simulated timeout contacting ${provider.toUpperCase()}`,
                      retryable: true,
                    },
                  },
                  HttpStatus.GATEWAY_TIMEOUT,
                ),
            ),
          ),
        );

      case 'SLOW_RESPONSE':
        return from(delay(fault.delayMs || 250)).pipe(
          switchMap(() => next.handle()),
        );

      case 'COMMIT_THEN_TIMEOUT':
        // Crucial: Execute the mutation first so state is saved,
        // but drop/delay the response with a timeout error.
        return next.handle().pipe(
          switchMap(async () => {
            await delay(fault.delayMs || 150);
            throw new HttpException(
              {
                error: {
                  code: 'COMMIT_THEN_TIMEOUT',
                  message: 'External mutation committed successfully but client response timed out',
                  retryable: true,
                },
              },
              HttpStatus.GATEWAY_TIMEOUT,
            );
          }),
        );

      default:
        return next.handle();
    }
  }
}