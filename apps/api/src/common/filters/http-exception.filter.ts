import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : typeof (exception as any)?.status === 'number'
        ? (exception as any).status
        : typeof (exception as any)?.statusCode === 'number'
        ? (exception as any).statusCode
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : status === HttpStatus.PAYLOAD_TOO_LARGE
        ? 'Payload too large'
        : status === HttpStatus.BAD_REQUEST
        ? 'Bad request'
        : 'Internal server error';

    this.logger.error(
      `HTTP ${status} on ${request.method} ${request.url}: ${
        typeof message === 'object' ? JSON.stringify(message) : message
      }`,
    );

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      error: typeof message === 'object' ? message : { message },
    });
  }
}
