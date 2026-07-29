import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { AppConfig } from '../config/configuration';
import { renderEmailHtml } from './email-html';
import { RenderedTemplate } from './notification-templates';

/** A recipient address resolved for a given external channel. */
export interface DeliveryTarget {
  /** Email address, phone number, or push token (provider-specific). */
  address: string | null;
}

/**
 * One external delivery channel. Implementations return `true` on success and
 * `false` (never throw) on failure so the caller can mark the Notification row
 * 'sent' or 'failed' without try/catch leaking into the domain flow.
 */
export interface NotificationProvider {
  /** True when a real provider SDK is configured (otherwise DevOutbox is used). */
  readonly enabled: boolean;
  send(target: DeliveryTarget, message: RenderedTemplate): Promise<boolean>;
}

export type EmailProvider = NotificationProvider;
export type SmsProvider = NotificationProvider;
export type PushProvider = NotificationProvider;

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/** `alice@example.com` → `al***@example.com`. Never log a full address. */
function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***${address.slice(at)}`;
}

/** Show only the tail of an opaque device token — never the whole credential. */
function maskToken(token: string): string {
  return token.length <= 8 ? '***' : `***${token.slice(-6)}`;
}

/**
 * Email provider, backed by **Resend**.
 *
 * Live only when `RESEND_API_KEY` is set AND `NODE_ENV !== 'test'`. Everything
 * else falls through to the DevOutbox (a log line), which is the behaviour local
 * dev and CI have always had.
 *
 * The `NODE_ENV==='test'` override mirrors `StripeService.onModuleInit`: the e2e
 * suite registers ~50 users per run and every one of them triggers an
 * `auth.verify_email`. A key that leaks into someone's shell must not turn a
 * test run into 50 real emails.
 *
 * `send()` NEVER throws — `NotificationsService.dispatch` relies on the boolean
 * to mark the row sent/failed, and a throw there would surface inside whatever
 * domain flow emitted the notification.
 */
@Injectable()
export class EmailProviderImpl implements EmailProvider {
  private readonly logger = new Logger('EmailProvider');
  readonly enabled: boolean;
  private readonly from: string;
  private readonly replyTo?: string;
  private readonly client?: Resend;

  constructor(config: ConfigService<AppConfig, true>) {
    const email = config.get('email', { infer: true });
    this.from = email.from;
    this.replyTo = email.replyTo || undefined;

    const hasKey = !!email.resendApiKey;
    if (hasKey && process.env.NODE_ENV === 'test') {
      this.logger.warn('RESEND_API_KEY is set but NODE_ENV=test — forcing the DevOutbox');
      this.enabled = false;
      return;
    }

    this.enabled = hasKey;
    if (this.enabled) {
      this.client = new Resend(email.resendApiKey);
      this.logger.log(`Resend email provider ready (from=${maskEmail(this.from)})`);
    }
  }

  async send(target: DeliveryTarget, message: RenderedTemplate): Promise<boolean> {
    if (!target.address) {
      this.logger.warn('Email send skipped — no recipient address');
      return false;
    }
    if (!this.enabled || !this.client) {
      this.logger.log(
        `[DevOutbox:email] to=${target.address} from=${this.from} subject="${message.subject}" — ${message.body}`,
      );
      return true;
    }

    try {
      const { error } = await this.client.emails.send({
        from: this.from,
        to: [target.address],
        subject: message.subject,
        text: message.body,
        html: renderEmailHtml(message.subject, message.body),
        ...(this.replyTo ? { replyTo: this.replyTo } : {}),
      });
      if (error) {
        // Resend reports API-level failures on the response, not as a throw.
        this.logger.error(
          `Resend rejected email to ${maskEmail(target.address)}: ` +
            `${error.name ?? 'error'}: ${error.message ?? 'unknown'}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      // Network/timeout/SDK bug. Same contract: report failure, never throw.
      this.logger.error(
        `Resend send threw for ${maskEmail(target.address)}: ${(err as Error).message}`,
      );
      return false;
    }
  }
}

/**
 * SMS provider. Uses Twilio when TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN are set,
 * otherwise logs to the DevOutbox. Sends the template's short text.
 */
@Injectable()
export class SmsProviderImpl implements SmsProvider {
  private readonly logger = new Logger('SmsProvider');
  readonly enabled: boolean;
  private readonly from: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const sms = config.get('sms', { infer: true });
    this.enabled = !!sms.twilioAccountSid && !!sms.twilioAuthToken;
    this.from = sms.twilioFrom;
  }

  async send(target: DeliveryTarget, message: RenderedTemplate): Promise<boolean> {
    if (!target.address) {
      this.logger.warn('SMS send skipped — no recipient phone');
      return false;
    }
    if (!this.enabled) {
      this.logger.log(`[DevOutbox:sms] to=${target.address} — ${message.short}`);
      return true;
    }
    // TODO(provider): real Twilio send. Gated on the Twilio creds:
    //   const twilio = require('twilio')(sid, token);
    //   await twilio.messages.create({ to: target.address, from: this.from,
    //     body: message.short });
    this.logger.warn('Twilio creds set but SDK not wired — using DevOutbox');
    this.logger.log(`[DevOutbox:sms] to=${target.address} — ${message.short}`);
    return true;
  }
}

/**
 * Push provider. Uses Firebase Cloud Messaging when FCM_SERVICE_ACCOUNT_JSON is
 * set, otherwise logs to the DevOutbox. Sends subject + short text.
 *
 * The address is the inspector's `InspectorProfile.fcmToken`, registered via
 * `POST /api/v1/inspector/push-token` and resolved by NotificationsService.
 */
@Injectable()
export class PushProviderImpl implements PushProvider {
  private readonly logger = new Logger('PushProvider');
  readonly enabled: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    this.enabled = !!config.get('push', { infer: true }).fcmServiceAccountJson;
  }

  async send(target: DeliveryTarget, message: RenderedTemplate): Promise<boolean> {
    if (!target.address) {
      // No device token registered yet — treat as a benign no-op success so the
      // row isn't marked failed for a user who simply has no push token.
      this.logger.log(`[DevOutbox:push] no token — skipping "${message.subject}"`);
      return true;
    }
    if (!this.enabled) {
      this.logger.log(
        `[DevOutbox:push] token=${maskToken(target.address)} title="${message.subject}" — ${message.short}`,
      );
      return true;
    }
    // TODO(provider): real FCM send. Gated on FCM_SERVICE_ACCOUNT_JSON:
    //   const admin = require('firebase-admin'); ... admin.messaging().send({...})
    this.logger.warn('FCM creds set but SDK not wired — using DevOutbox');
    this.logger.log(
      `[DevOutbox:push] token=${maskToken(target.address)} title="${message.subject}"`,
    );
    return true;
  }
}
