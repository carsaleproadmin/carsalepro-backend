import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Notification, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  EMAIL_PROVIDER,
  EmailProvider,
  NotificationProvider,
  PUSH_PROVIDER,
  PushProvider,
  SMS_PROVIDER,
  SmsProvider,
} from './notification-providers';
import { renderTemplate, RenderedTemplate } from './notification-templates';
import {
  DEFAULT_PREFERENCES,
  NotificationChannel,
  NotificationPreferences,
  NotificationType,
  TYPE_DEFAULT_CHANNELS,
} from './notification-types';
import {
  NotificationItemDto,
  NotificationListDto,
} from './dto/notification-response.dto';

interface NotifyOptions {
  locale?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly inTest = process.env.NODE_ENV === 'test';

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
  ) {}

  // ============================================================
  // Emit
  // ============================================================

  /**
   * Emit a notification to a user. Resolves the recipient's locale and the
   * channels = (type defaults) ∩ (user prefs), always including `inapp`. For
   * each channel a queued Notification row is created and then dispatched —
   * inline in test (so e2e can assert rows immediately), fire-and-forget
   * otherwise. NEVER throws into the caller: every failure is caught + logged.
   */
  async notify(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
    opts?: NotifyOptions,
  ): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, phone: true, locale: true, notificationPrefs: true },
      });
      if (!user) {
        this.logger.warn(`notify(${type}): user ${userId} not found — skipping`);
        return;
      }

      const locale = opts?.locale ?? user.locale ?? undefined;
      const prefs = this.normalizePrefs(user.notificationPrefs);
      const channels = this.resolveChannels(type, prefs);
      const message = renderTemplate(type, locale, payload ?? {});
      const safePayload = this.toJsonPayload(payload, message);

      for (const channel of channels) {
        await this.emitChannel(userId, type, channel, safePayload, message, {
          email: user.email,
          phone: user.phone,
        });
      }
    } catch (err) {
      // Hard guarantee: notification failures never break the calling domain flow.
      this.logger.error(
        `notify(${type}) failed for user ${userId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Create one channel's Notification row (status 'queued'), then dispatch it.
   * The inapp channel is "sent" immediately (no external provider). External
   * channels run through their provider. In test mode dispatch is awaited inline;
   * otherwise it is fired and forgotten so the domain call returns promptly.
   */
  private async emitChannel(
    userId: string,
    type: NotificationType,
    channel: NotificationChannel,
    payload: Prisma.InputJsonValue,
    message: RenderedTemplate,
    contact: { email: string | null; phone: string | null },
  ): Promise<void> {
    let row: Notification;
    try {
      row = await this.prisma.notification.create({
        data: { userId, type, channel, payload, status: 'queued' },
      });
    } catch (err) {
      this.logger.error(
        `Failed to create ${channel} notification (${type}) for ${userId}: ${(err as Error).message}`,
      );
      return;
    }

    // inapp has no external provider — it is delivered as soon as the row exists.
    if (channel === 'inapp') {
      await this.markStatus(row.id, 'sent');
      return;
    }

    // TODO(scale-out): move dispatch to BullMQ when provider rate-limits require
    // async retry/backoff. For now we dispatch inline (test) or fire-and-forget.
    const dispatch = () => this.dispatch(row.id, channel, message, contact);
    if (this.inTest) {
      await dispatch();
    } else {
      void dispatch();
    }
  }

  /**
   * Send one external channel via its provider and update the row status. Never
   * throws — a provider error marks the row 'failed' and is logged.
   */
  private async dispatch(
    notificationId: string,
    channel: NotificationChannel,
    message: RenderedTemplate,
    contact: { email: string | null; phone: string | null },
  ): Promise<void> {
    try {
      const provider = this.providerFor(channel);
      const address =
        channel === 'email' ? contact.email : channel === 'sms' ? contact.phone : null;
      const ok = await provider.send({ address }, message);
      await this.markStatus(notificationId, ok ? 'sent' : 'failed');
    } catch (err) {
      this.logger.error(
        `dispatch(${channel}) failed for notification ${notificationId}: ${(err as Error).message}`,
      );
      await this.markStatus(notificationId, 'failed');
    }
  }

  private providerFor(channel: NotificationChannel): NotificationProvider {
    switch (channel) {
      case 'email':
        return this.email;
      case 'sms':
        return this.sms;
      case 'push':
        return this.push;
      default:
        return this.email;
    }
  }

  private async markStatus(id: string, status: 'sent' | 'failed'): Promise<void> {
    await this.prisma.notification
      .update({ where: { id }, data: { status } })
      .catch((err) =>
        this.logger.warn(`Could not set notification ${id} status=${status}: ${String(err)}`),
      );
  }

  /** Channels = type defaults ∩ enabled prefs, with inapp always present. */
  private resolveChannels(
    type: NotificationType,
    prefs: NotificationPreferences,
  ): NotificationChannel[] {
    const defaults = TYPE_DEFAULT_CHANNELS[type] ?? ['inapp'];
    const set = new Set<NotificationChannel>(['inapp']); // always include inapp
    for (const ch of defaults) {
      if (ch === 'inapp') continue;
      if (prefs[ch]) set.add(ch);
    }
    return [...set];
  }

  // ============================================================
  // In-app queries
  // ============================================================

  async list(
    userId: string,
    opts: { page?: number; pageSize?: number } = {},
  ): Promise<NotificationListDto> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const where = { userId, channel: 'inapp' };

    const [rows, total, unread] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);

    return { items: rows.map((r) => this.toItem(r)), total, unread };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, channel: 'inapp', readAt: null },
    });
  }

  /** Mark a single in-app notification read. 404 if not the user's. */
  async markRead(userId: string, id: string): Promise<void> {
    const row = await this.prisma.notification.findUnique({ where: { id } });
    if (!row || row.userId !== userId || row.channel !== 'inapp') {
      throw new NotFoundException({
        error: { code: 'not_found', message: 'Notification not found' },
      });
    }
    if (!row.readAt) {
      await this.prisma.notification.update({
        where: { id },
        data: { readAt: new Date() },
      });
    }
  }

  /** Mark all of the user's in-app notifications read. Returns the count updated. */
  async markAllRead(userId: string): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, channel: 'inapp', readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }

  // ============================================================
  // Preferences
  // ============================================================

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    if (!user) {
      throw new NotFoundException({
        error: { code: 'not_found', message: 'User not found' },
      });
    }
    return this.normalizePrefs(user.notificationPrefs);
  }

  async updatePreferences(
    userId: string,
    prefs: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    const current = await this.getPreferences(userId);
    const next: NotificationPreferences = {
      inapp: this.coerceBool(prefs.inapp, current.inapp),
      email: this.coerceBool(prefs.email, current.email),
      sms: this.coerceBool(prefs.sms, current.sms),
      push: this.coerceBool(prefs.push, current.push),
    };
    await this.prisma.user.update({
      where: { id: userId },
      data: { notificationPrefs: next as unknown as Prisma.InputJsonValue },
    });
    return next;
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Coerce the stored Json prefs (or absence) into a complete, valid shape. */
  private normalizePrefs(raw: Prisma.JsonValue | null | undefined): NotificationPreferences {
    const obj =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    return {
      inapp: this.coerceBool(obj.inapp, DEFAULT_PREFERENCES.inapp),
      email: this.coerceBool(obj.email, DEFAULT_PREFERENCES.email),
      sms: this.coerceBool(obj.sms, DEFAULT_PREFERENCES.sms),
      push: this.coerceBool(obj.push, DEFAULT_PREFERENCES.push),
    };
  }

  private coerceBool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
  }

  /**
   * Persist the rendered title/body alongside the raw payload so the in-app
   * list can render without re-running templates (and stays correct even if a
   * template later changes).
   */
  private toJsonPayload(
    payload: Record<string, unknown> | undefined,
    message: RenderedTemplate,
  ): Prisma.InputJsonValue {
    return {
      ...(payload ?? {}),
      _title: message.subject,
      _body: message.body,
    } as Prisma.InputJsonValue;
  }

  private toItem(row: Notification): NotificationItemDto {
    const payload =
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    return {
      id: row.id,
      type: row.type,
      channel: row.channel,
      title: typeof payload._title === 'string' ? payload._title : row.type,
      body: typeof payload._body === 'string' ? payload._body : '',
      status: row.status,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
