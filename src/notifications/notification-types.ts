/**
 * The full notification event matrix (E11). Each type maps to a localized
 * template (see notification-templates.ts) and a set of default channels
 * (see TYPE_DEFAULT_CHANNELS below). The string values are persisted on
 * Notification.type so they double as a stable wire contract.
 */
export type NotificationType =
  | 'auth.verify_email'
  | 'auth.password_reset'
  | 'order.created'
  | 'offer.received'
  | 'order.assigned'
  | 'order.en_route'
  | 'order.in_progress'
  | 'order.submitted'
  | 'order.approved'
  | 'order.completed'
  | 'order.cancelled'
  | 'order.declined_by_inspector'
  | 'order.inspector_no_show'
  | 'order.inspector_no_show_self'
  | 'order.owner_contacted'
  | 'order.owner_unreachable'
  | 'order.search_expired'
  | 'order.disputed'
  | 'payout.sent'
  | 'payout.delayed'
  | 'payout.failed'
  | 'refund.failed'
  | 'kyc.submitted'
  | 'kyc.approved'
  | 'kyc.rejected'
  | 'ppv.purchased'
  | 'vin_history.failed'
  | 'listing.published'
  | 'listing.hidden'
  | 'listing.unhidden';

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
  // Email only — see SECRET_BEARING_TYPES below.
  'auth.verify_email': ['email'],
  'auth.password_reset': ['email'],
  'order.created': ['inapp', 'email'],
  'offer.received': ['inapp', 'email', 'push'],
  'order.assigned': ['inapp', 'email'],
  'order.en_route': ['inapp', 'push'],
  'order.in_progress': ['inapp'],
  'order.submitted': ['inapp', 'email'],
  'order.approved': ['inapp', 'email'],
  'order.completed': ['inapp'],
  'order.cancelled': ['inapp', 'email'],
  /**
   * The inspector gave the job back after accepting it. Distinct from
   * `order.cancelled`, whose copy says the reader cancelled: here the customer
   * did nothing, their money is already captured and is being refunded in full,
   * and they must be told the reason the inspector gave. Same channels as
   * `order.cancelled` — email as well as in-app, because the reader has to act
   * (order again) rather than only note a status.
   */
  'order.declined_by_inspector': ['inapp', 'email'],
  /**
   * The inspector accepted and then never started, and the sweep gave the money
   * back (DEN-269). Separate from `order.declined_by_inspector` because that
   * letter quotes a reason, and the defining fact here is that there is none.
   */
  'order.inspector_no_show': ['inapp', 'email'],
  /**
   * The same sweep, told to the inspector who did not start. It is not an
   * information copy of the customer's letter: he loses the fee, the customer
   * is refunded from money he was to be paid, and a cancellation is counted
   * against him. Email as well as in-app for that reason - a mark on a record
   * that the person carrying it never read is the kind of fact that surfaces
   * first in a dispute.
   */
  'order.inspector_no_show_self': ['inapp', 'email'],
  /**
   * DEN-291. The inspector reached the car owner and can start the trip. In-app
   * only, like `order.in_progress`: good news that asks for no action.
   */
  'order.owner_contacted': ['inapp'],
  /**
   * DEN-291. The inspector could not reach the car owner, so the order is
   * cancelled with a full refund. Email as well as in-app, like
   * `order.inspector_no_show`: the customer must act (check the contact and
   * order again).
   */
  'order.owner_unreachable': ['inapp', 'email'],
  /**
   * Nobody accepted inside the search window: the hold is released, nothing was
   * charged. Distinct from `order.cancelled` because the customer did nothing
   * wrong and needs to be told about their money, not about a status change —
   * "your order was cancelled" after an authorization that still shows on the
   * statement is exactly how a support ticket starts.
   */
  'order.search_expired': ['inapp', 'email'],
  'order.disputed': ['inapp', 'email'],
  'payout.sent': ['inapp', 'email'],
  /** Inspector-facing: their money is late. Sent once, not on every retry. */
  'payout.delayed': ['inapp', 'email'],
  /** Operator-facing: a transfer is stuck and needs attention. */
  'payout.failed': ['inapp', 'email'],
  /**
   * Operator-facing: money owed BACK to a customer is not moving. Same channels
   * as payout.failed — the two failures are the same class of incident seen from
   * opposite ends of the ledger.
   */
  'refund.failed': ['inapp', 'email'],
  'kyc.submitted': ['inapp', 'email'],
  'kyc.approved': ['inapp', 'email'],
  'kyc.rejected': ['inapp', 'email'],
  'ppv.purchased': ['inapp', 'email'],
  /** Operator-facing: a paid VIN lookup could not be delivered and was refunded. */
  'vin_history.failed': ['inapp', 'email'],
  'listing.published': ['inapp'],
  /**
   * DEN-295. An admin took the listing off the showroom, with a reason. Email
   * as well as in-app: the seller's car is no longer on sale, and the seller
   * has to act (correct the listing or contact support).
   */
  'listing.hidden': ['inapp', 'email'],
  /** DEN-295. An admin restored the listing. Good news that asks for no action. */
  'listing.unhidden': ['inapp'],
};

/**
 * Types whose payload carries a live single-use credential.
 *
 * These are the ONE exception to "inapp is always added". `GET /api/v1/notifications`
 * returns the stored `payload` of every inapp row, so an in-app copy would let
 * anyone holding a session read the account's own password-reset link out of
 * the notification bell — escalating a borrowed session into a permanent
 * takeover. They are also useless in-app: a user who cannot sign in cannot open
 * the bell. Delivery is email only.
 *
 * Anything added here MUST also omit 'inapp' from TYPE_DEFAULT_CHANNELS.
 */
export const SECRET_BEARING_TYPES: ReadonlySet<NotificationType> = new Set([
  'auth.verify_email',
  'auth.password_reset',
]);

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
