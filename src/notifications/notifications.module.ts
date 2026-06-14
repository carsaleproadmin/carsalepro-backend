import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import {
  EMAIL_PROVIDER,
  EmailProviderImpl,
  PUSH_PROVIDER,
  PushProviderImpl,
  SMS_PROVIDER,
  SmsProviderImpl,
} from './notification-providers';

/**
 * @Global so any emitting module (orders, kyc, listings, payments) can inject
 * NotificationsService without importing this module — which keeps the
 * dependency one-way (this module must NOT import the domain modules, avoiding
 * cycles). PrismaService comes from the @Global PrismaModule.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    { provide: EMAIL_PROVIDER, useClass: EmailProviderImpl },
    { provide: SMS_PROVIDER, useClass: SmsProviderImpl },
    { provide: PUSH_PROVIDER, useClass: PushProviderImpl },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
