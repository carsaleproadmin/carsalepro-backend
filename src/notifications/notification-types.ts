/**
 * The full notification event matrix (E11). Each type maps to a localized
 * template (see notification-templates.ts) and a set of default channels
 * (see TYPE_DEFAULT_CHANNELS below). The string values are persisted on
 * Notification.type so they double as a stable wire contract.
 */
export type NotificationType =
  | 'order.created'
  | 'offer.received'
  | 'order.assigned'
  | 'order.en_route'
  | 'order.in_progress'
  | 'order.submitted'
  | 'order.approved'
  | 'order.completed'
  | 'order.cancelled'
  | 'order.disputed'
  | 'payout.sent'
  | 'kyc.approved'
  | 'kyc.rejected'
  | 'ppv.purchased'
  | 'listing.published'
  | 'listing.expiring';

/** The delivery channels a notification can travel on. */
export type NotificationChannel = 'inapp' | 'email' | 'sms' | 'push';

/** The locales the template catalog covers. `de` is the platform default. */
export type NotificationLocale = 'de' | 'en' | 'ru';

export const SUPPORTED_LOCALES: NotificationLocale[] = ['de', 'en', 'ru'];
export const DEFAULT_LOCALE: NotificationLocale = 'de';

/**
 * Per-type default channels (from the E11 matrix). `inapp` is ALWAYS added by
 * NotificationService regardless of what is listed here, so the in-app history
 * is complete; the entries here drive the EXTERNAL channels (email/sms/push).
 */
export const TYPE_DEFAULT_CHANNELS: Record<NotificationType, NotificationChannel[]> = {
  'order.created': ['inapp', 'email'],
  'offer.received': ['inapp', 'email', 'push'],
  'order.assigned': ['inapp', 'email'],
  'order.en_route': ['inapp', 'push'],
  'order.in_progress': ['inapp'],
  'order.submitted': ['inapp', 'email'],
  'order.approved': ['inapp', 'email'],
  'order.completed': ['inapp'],
  'order.cancelled': ['inapp', 'email'],
  'order.disputed': ['inapp', 'email'],
  'payout.sent': ['inapp', 'email'],
  'kyc.approved': ['inapp', 'email'],
  'kyc.rejected': ['inapp', 'email'],
  'ppv.purchased': ['inapp', 'email'],
  'listing.published': ['inapp'],
  'listing.expiring': ['inapp', 'email'],
};

/**
 * The user's per-channel preference flags (stored on User.notificationPrefs).
 * `inapp` is recorded for completeness but is always treated as enabled — every
 * notification produces an in-app row regardless of this flag.
 */
export interface NotificationPreferences {
  inapp: boolean;
  email: boolean;
  sms: boolean;
  push: boolean;
}

/** Sane defaults when a user has not customised their preferences. */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  inapp: true,
  email: true,
  sms: false,
  push: false,
};
