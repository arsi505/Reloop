import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { SimulatorErrorResponse } from '@reloop/connector-simulator';

@Catch()
export class SimulatorExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SIMULATOR_ERROR';
    let message = 'An unexpected simulator error occurred';
    let retryable = false;
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'object' && res !== null) {
        const errorObj = res as Record<string, unknown>;
        const subError =
          errorObj.error && typeof errorObj.error === 'object'
            ? (errorObj.error as Record<string, unknown>)
            : undefined;

        if (subError) {
          code = typeof subError.code === 'string' ? subError.code : code;
          message = typeof subError.message === 'string' ? subError.message : message;
          retryable = typeof subError.retryable === 'boolean' ? subError.retryable : retryable;
          details = subError.details;
        } else {
          message = typeof errorObj.message === 'string' ? errorObj.message : exception.message;
          code =
            typeof errorObj.code === 'string'
              ? errorObj.code
              : status === 404
                ? 'ORDER_NOT_FOUND'
                : status === 409
                  ? 'DUPLICATE_ORDER'
                  : status === 429
                    ? 'RATE_LIMIT_EXCEEDED'
                    : status === 503
                      ? 'SIMULATED_SERVICE_UNAVAILABLE'
                      : 'HTTP_ERROR';
          retryable = status === 429 || status === 503 || status === 504;
        }
      } else {
        message = String(res);
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    const payload: SimulatorErrorResponse = {
      error: {
        code,
        message,
        retryable,
        ...(details ? { details } : {}),
      },
    };

    response.status(status).json(payload);
  }
}