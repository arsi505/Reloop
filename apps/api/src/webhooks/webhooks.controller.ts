import {
  Controller,
  Post,
  Param,
  Req,
  Headers,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';
import { WebhookIngestResponseDto } from './dto/webhook-response.dto';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post(':provider/:integrationId')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Param('provider') provider: string,
    @Param('integrationId') integrationId: string,
    @Req() req: Request,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
  ): Promise<WebhookIngestResponseDto> {
    const rawBody: Buffer | undefined = (req as any).rawBody;

    return this.webhooksService.ingestWebhook(
      provider,
      integrationId,
      rawBody,
      headers,
      body,
    );
  }
}
