import { Module } from '@nestjs/common';
import {
  MeReportPurchasesController,
  PaymentsController,
} from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeService } from './stripe.service';
import { WebhookController } from './webhook.controller';

@Module({
  controllers: [PaymentsController, MeReportPurchasesController, WebhookController],
  providers: [StripeService, PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
