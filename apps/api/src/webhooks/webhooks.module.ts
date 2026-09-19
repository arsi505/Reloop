import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookEventProcessorService } from './webhook-event-processor.service';
import { TargetedReconciliationService } from './targeted-reconciliation.service';

@Module({
  imports: [PrismaModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookEventProcessorService,
    TargetedReconciliationService,
  ],
  exports: [
    WebhooksService,
    WebhookEventProcessorService,
    TargetedReconciliationService,
  ],
})
export class WebhooksModule {}
