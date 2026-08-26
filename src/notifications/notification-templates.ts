import {
  DEFAULT_LOCALE,
  NotificationLocale,
  NotificationType,
  SUPPORTED_LOCALES,
} from './notification-types';

/** A fully rendered notification message for one locale. */
export interface RenderedTemplate {
  /** Email subject / in-app title. */
  subject: string;
  /** Long-form body (email / in-app detail). */
  body: string;
  /** Short single-line text for SMS and push. */
  short: string;
  /**
   * The one action the letter is asking for, rendered as a button in the HTML
   * part (DEN-200). Optional, and only the email provider reads it: SMS, push
   * and the in-app list all take their text from `short`/`body`.
   *
   * The URL MUST also appear in `body`. The button is an addition to the
   * plain-text link, never a replacement for it - a client that refuses HTML,
   * or a reader who copies the mail into a text editor, still has to be able to
   * finish what the letter asked them to do.
   */
  cta?: { url: string; label: string };
}

/**
 * An ISO timestamp as plain English: `26 August 2026, 14:32 UTC`.
 *
 * The templates used to interpolate the ISO string straight into the sentence,
 * which put `2026-08-27T09:14:22.001Z` in front of a reader who is being asked
 * to trust the letter. UTC is stated rather than converted: the server does not
 * know the reader's zone, and a time with no zone on it is worse than a time in
 * a zone the reader has to think about once.
 */
export function formatDeadline(iso: unknown): string {
  const at = new Date(String(iso ?? ''));
  if (Number.isNaN(at.getTime())) return '';
  const date = at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const time = at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${date}, ${time} UTC`;
}

type TemplateFn = (p: Record<string, unknown>) => RenderedTemplate;

/** Format an integer-cents amount as EUR for display (e.g. 12999 → "129,99 €"). */
export function formatEur(cents: unknown): string {
  const n = typeof cents === 'number' ? cents : Number(cents);
  if (!Number.isFinite(n)) return '';
  const eur = n / 100;
  // German-style grouping (matches the platform's de default) with a trailing €.
  return `${eur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function str(p: Record<string, unknown>, key: string, fallback = ''): string {
  const v = p[key];
  return v === undefined || v === null ? fallback : String(v);
}

/**
 * The localized template catalog keyed by NotificationType then locale. Each
 * entry is a pure function of the payload, returning subject/body/short. Keep
 * payload reads defensive — a missing field must never throw.
 */
const CATALOG: Record<NotificationType, Record<NotificationLocale, TemplateFn>> = {
  'auth.verify_email': {
    de: (p) => ({
      subject: 'E-Mail-Adresse bestätigen',
      body: `Bitte bestätigen Sie Ihre E-Mail-Adresse: ${str(p, 'verifyUrl')}\n\nDer Link ist bis ${str(p, 'expiresAt')} gültig und kann nur einmal verwendet werden. Falls Sie sich nicht registriert haben, ignorieren Sie diese Nachricht.`,
      short: 'Bitte bestätigen Sie Ihre E-Mail-Adresse.',
    }),
    /*
     * The English letter is the one every new account gets, whatever language
     * the site was read in - `AuthService.sendVerificationEmail` pins the
     * locale to `en` (DEN-200). The German and Russian versions below are kept
     * because the catalog is keyed by locale and because pinning is a caller's
     * decision that a later caller may want to make differently.
     */
    en: (p) => ({
      subject: 'Confirm your email address',
      body:
        `Welcome to CarSalePro.\n\n` +
        `One step is left: confirm that ${str(p, 'email', 'this address')} is yours. ` +
        `Open the link below and your registration is complete.\n\n` +
        `${str(p, 'verifyUrl')}\n\n` +
        `The link works once and stops working on ${formatDeadline(p.expiresAt)}. ` +
        `If it has already expired, sign in and ask for a new one from the banner in your account.\n\n` +
        `If you did not create a CarSalePro account, no action is needed - ` +
        `nothing happens until somebody opens that link, and it will expire on its own.`,
      short: 'Please confirm your email address.',
      cta: { url: str(p, 'verifyUrl'), label: 'Confirm my email address' },
    }),
    ru: (p) => ({
      subject: 'Подтвердите адрес электронной почты',
      body: `Подтвердите ваш адрес электронной почты: ${str(p, 'verifyUrl')}\n\nСсылка действует до ${str(p, 'expiresAt')} и может быть использована один раз. Если вы не регистрировались, просто игнорируйте это сообщение.`,
      short: 'Подтвердите адрес электронной почты.',
    }),
  },
  'auth.password_reset': {
    de: (p) => ({
      subject: 'Passwort zurücksetzen',
      body: `Sie können Ihr Passwort hier zurücksetzen: ${str(p, 'resetUrl')}\n\nDer Link ist bis ${str(p, 'expiresAt')} gültig und kann nur einmal verwendet werden. Falls Sie das nicht angefordert haben, ist nichts zu tun — Ihr Passwort bleibt unverändert.`,
      short: 'Link zum Zurücksetzen des Passworts.',
    }),
    en: (p) => ({
      subject: 'Reset your password',
      body: `You can reset your password here: ${str(p, 'resetUrl')}\n\nThe link is valid until ${str(p, 'expiresAt')} and can be used once. If you did not request this, no action is needed — your password is unchanged.`,
      short: 'Password reset link.',
    }),
    ru: (p) => ({
      subject: 'Сброс пароля',
      body: `Вы можете сбросить пароль здесь: ${str(p, 'resetUrl')}\n\nСсылка действует до ${str(p, 'expiresAt')} и может быть использована один раз. Если вы не запрашивали сброс, ничего делать не нужно — пароль останется прежним.`,
      short: 'Ссылка для сброса пароля.',
    }),
  },
  'order.created': {
    de: (p) => ({
      subject: `Bestellung ${str(p, 'orderNumber')} aufgegeben`,
      body: `Ihre Inspektionsbestellung ${str(p, 'orderNumber')} für ${str(p, 'make')} ${str(p, 'model')} wurde aufgegeben (${formatEur(p.totalCents)}). Wir suchen einen Prüfer in Ihrer Nähe.`,
      short: `Bestellung ${str(p, 'orderNumber')} aufgegeben.`,
    }),
    en: (p) => ({
      subject: `Order ${str(p, 'orderNumber')} placed`,
      body: `Your inspection order ${str(p, 'orderNumber')} for ${str(p, 'make')} ${str(p, 'model')} has been placed (${formatEur(p.totalCents)}). We are finding an inspector near you.`,
      short: `Order ${str(p, 'orderNumber')} placed.`,
    }),
    ru: (p) => ({
      subject: `Заказ ${str(p, 'orderNumber')} создан`,
      body: `Ваш заказ на осмотр ${str(p, 'orderNumber')} для ${str(p, 'make')} ${str(p, 'model')} создан (${formatEur(p.totalCents)}). Мы ищем инспектора рядом с вами.`,
      short: `Заказ ${str(p, 'orderNumber')} создан.`,
    }),
  },
  'offer.received': {
    de: (p) => ({
      subject: `Neuer Inspektionsauftrag verfügbar`,
      body: `Ein neuer Auftrag ${str(p, 'orderNumber')} (${str(p, 'make')} ${str(p, 'model')}) ist verfügbar. Ihr Anteil: ${formatEur(p.inspectorShareCents)}. Bitte annehmen oder ablehnen.`,
      short: `Neuer Auftrag ${str(p, 'orderNumber')} verfügbar.`,
    }),
    en: (p) => ({
      subject: `New inspection job available`,
      body: `A new job ${str(p, 'orderNumber')} (${str(p, 'make')} ${str(p, 'model')}) is available. Your share: ${formatEur(p.inspectorShareCents)}. Please accept or decline.`,
      short: `New job ${str(p, 'orderNumber')} available.`,
    }),
    ru: (p) => ({
      subject: `Доступен новый заказ на осмотр`,
      body: `Доступен новый заказ ${str(p, 'orderNumber')} (${str(p, 'make')} ${str(p, 'model')}). Ваша доля: ${formatEur(p.inspectorShareCents)}. Примите или отклоните.`,
      short: `Новый заказ ${str(p, 'orderNumber')} доступен.`,
    }),
  },
  'order.assigned': {
    de: (p) => ({
      subject: `Prüfer für ${str(p, 'orderNumber')} zugewiesen`,
      body: `Ein Prüfer wurde Ihrer Bestellung ${str(p, 'orderNumber')} zugewiesen und nimmt Kontakt auf.`,
      short: `Prüfer für ${str(p, 'orderNumber')} zugewiesen.`,
    }),
    en: (p) => ({
      subject: `Inspector assigned to ${str(p, 'orderNumber')}`,
      body: `An inspector has been assigned to your order ${str(p, 'orderNumber')} and will be in touch.`,
      short: `Inspector assigned to ${str(p, 'orderNumber')}.`,
    }),
    ru: (p) => ({
      subject: `Инспектор назначен на ${str(p, 'orderNumber')}`,
      body: `Инспектор назначен на ваш заказ ${str(p, 'orderNumber')} и скоро свяжется с вами.`,
      short: `Инспектор назначен на ${str(p, 'orderNumber')}.`,
    }),
  },
  'order.en_route': {
    de: (p) => ({
      subject: `Prüfer ist unterwegs`,
      body: `Der Prüfer ist zu Ihrer Bestellung ${str(p, 'orderNumber')} unterwegs.`,
      short: `Prüfer für ${str(p, 'orderNumber')} ist unterwegs.`,
    }),
    en: (p) => ({
      subject: `Inspector en route`,
      body: `The inspector is on the way for your order ${str(p, 'orderNumber')}.`,
      short: `Inspector en route for ${str(p, 'orderNumber')}.`,
    }),
    ru: (p) => ({
      subject: `Инспектор в пути`,
      body: `Инспектор в пути по вашему заказу ${str(p, 'orderNumber')}.`,
      short: `Инспектор в пути по ${str(p, 'orderNumber')}.`,
    }),
  },
  'order.in_progress': {
    de: (p) => ({
      subject: `Inspektion läuft`,
      body: `Die Inspektion für Bestellung ${str(p, 'orderNumber')} hat begonnen.`,
      short: `Inspektion ${str(p, 'orderNumber')} läuft.`,
    }),
    en: (p) => ({
      subject: `Inspection in progress`,
      body: `The inspection for order ${str(p, 'orderNumber')} has started.`,
      short: `Inspection ${str(p, 'orderNumber')} in progress.`,
    }),
    ru: (p) => ({
      subject: `Осмотр выполняется`,
      body: `Осмотр по заказу ${str(p, 'orderNumber')} начался.`,
      short: `Осмотр ${str(p, 'orderNumber')} выполняется.`,
    }),
  },
  'order.submitted': {
    de: (p) => ({
      subject: `Inspektionsbericht eingereicht`,
      body: `Der Bericht für Bestellung ${str(p, 'orderNumber')} wurde eingereicht. Bitte prüfen und freigeben.`,
      short: `Bericht für ${str(p, 'orderNumber')} eingereicht.`,
    }),
    en: (p) => ({
      subject: `Inspection report submitted`,
      body: `The report for order ${str(p, 'orderNumber')} has been submitted. Please review and approve.`,
      short: `Report for ${str(p, 'orderNumber')} submitted.`,
    }),
    ru: (p) => ({
      subject: `Отчёт об осмотре отправлен`,
      body: `Отчёт по заказу ${str(p, 'orderNumber')} отправлен. Пожалуйста, проверьте и подтвердите.`,
      short: `Отчёт по ${str(p, 'orderNumber')} отправлен.`,
    }),
  },
  'order.approved': {
    de: (p) => ({
      subject: `Bericht freigegeben`,
      body: `Ihr Bericht für Bestellung ${str(p, 'orderNumber')} wurde freigegeben. Ihre Auszahlung von ${formatEur(p.inspectorShareCents)} wird bearbeitet.`,
      short: `Bericht ${str(p, 'orderNumber')} freigegeben.`,
    }),
    en: (p) => ({
      subject: `Report approved`,
      body: `Your report for order ${str(p, 'orderNumber')} was approved. Your payout of ${formatEur(p.inspectorShareCents)} is being processed.`,
      short: `Report ${str(p, 'orderNumber')} approved.`,
    }),
    ru: (p) => ({
      subject: `Отчёт одобрен`,
      body: `Ваш отчёт по заказу ${str(p, 'orderNumber')} одобрен. Выплата ${formatEur(p.inspectorShareCents)} обрабатывается.`,
      short: `Отчёт ${str(p, 'orderNumber')} одобрен.`,
    }),
  },
  'order.completed': {
    de: (p) => ({
      subject: `Bestellung abgeschlossen`,
      body: `Bestellung ${str(p, 'orderNumber')} ist abgeschlossen. Vielen Dank.`,
      short: `Bestellung ${str(p, 'orderNumber')} abgeschlossen.`,
    }),
    en: (p) => ({
      subject: `Order completed`,
      body: `Order ${str(p, 'orderNumber')} is complete. Thank you.`,
      short: `Order ${str(p, 'orderNumber')} completed.`,
    }),
    ru: (p) => ({
      subject: `Заказ завершён`,
      body: `Заказ ${str(p, 'orderNumber')} завершён. Спасибо.`,
      short: `Заказ ${str(p, 'orderNumber')} завершён.`,
    }),
  },
  'order.cancelled': {
    de: (p) => ({
      subject: `Bestellung storniert`,
      body: `Bestellung ${str(p, 'orderNumber')} wurde storniert.`,
      short: `Bestellung ${str(p, 'orderNumber')} storniert.`,
    }),
    en: (p) => ({
      subject: `Order cancelled`,
      body: `Order ${str(p, 'orderNumber')} has been cancelled.`,
      short: `Order ${str(p, 'orderNumber')} cancelled.`,
    }),
    ru: (p) => ({
      subject: `Заказ отменён`,
      body: `Заказ ${str(p, 'orderNumber')} был отменён.`,
      short: `Заказ ${str(p, 'orderNumber')} отменён.`,
    }),
  },
  /**
   * The copy has one job beyond informing: stop the support ticket. An
   * authorization that has been released still sits in a card statement for a
   * few working days, and a customer who reads "cancelled" and then sees the
   * amount on their statement concludes they were charged for nothing.
   */
  'order.search_expired': {
    de: (p) => ({
      subject: `Kein Prüfer verfügbar`,
      body:
        `Für Bestellung ${str(p, 'orderNumber')} haben wir in Ihrer Region keinen Prüfer gefunden. ` +
        `Es wurde nichts abgebucht — die Reservierung auf Ihrer Karte ist freigegeben. ` +
        `Sie kann noch einige Werktage in Ihrem Kontoauszug erscheinen.`,
      short: `Kein Prüfer für ${str(p, 'orderNumber')} — Reservierung freigegeben.`,
    }),
    en: (p) => ({
      subject: `No inspector available`,
      body:
        `We could not find an inspector for order ${str(p, 'orderNumber')} in your area. ` +
        `Nothing has been charged — the hold on your card has been released. ` +
        `It may still appear on your statement for a few working days.`,
      short: `No inspector for ${str(p, 'orderNumber')} — hold released.`,
    }),
    ru: (p) => ({
      subject: `Инспектор не найден`,
      body:
        `Для заказа ${str(p, 'orderNumber')} мы не нашли инспектора в вашем регионе. ` +
        `Деньги не списаны — резерв на карте снят. ` +
        `Он может ещё несколько рабочих дней отображаться в выписке.`,
      short: `Инспектор для ${str(p, 'orderNumber')} не найден — резерв снят.`,
    }),
  },
  'order.disputed': {
    de: (p) => ({
      subject: `Bestellung in Reklamation`,
      body: `Für Bestellung ${str(p, 'orderNumber')} wurde eine Reklamation eröffnet. Unser Team prüft den Fall.`,
      short: `Reklamation für ${str(p, 'orderNumber')} eröffnet.`,
    }),
    en: (p) => ({
      subject: `Order disputed`,
      body: `A dispute has been opened for order ${str(p, 'orderNumber')}. Our team is reviewing it.`,
      short: `Dispute opened for ${str(p, 'orderNumber')}.`,
    }),
    ru: (p) => ({
      subject: `Спор по заказу`,
      body: `По заказу ${str(p, 'orderNumber')} открыт спор. Наша команда рассматривает его.`,
      short: `Открыт спор по ${str(p, 'orderNumber')}.`,
    }),
  },
  'payout.sent': {
    de: (p) => ({
      subject: `Auszahlung gesendet`,
      body: `Ihre Auszahlung von ${formatEur(p.amountCents)} für Bestellung ${str(p, 'orderNumber')} wurde gesendet.`,
      short: `Auszahlung ${formatEur(p.amountCents)} gesendet.`,
    }),
    en: (p) => ({
      subject: `Payout sent`,
      body: `Your payout of ${formatEur(p.amountCents)} for order ${str(p, 'orderNumber')} has been sent.`,
      short: `Payout ${formatEur(p.amountCents)} sent.`,
    }),
    ru: (p) => ({
      subject: `Выплата отправлена`,
      body: `Ваша выплата ${formatEur(p.amountCents)} по заказу ${str(p, 'orderNumber')} отправлена.`,
      short: `Выплата ${formatEur(p.amountCents)} отправлена.`,
    }),
  },
  'payout.delayed': {
    de: (p) => ({
      subject: `Auszahlung verzögert`,
      body: `Ihre Auszahlung von ${formatEur(p.amountCents)} für Bestellung ${str(p, 'orderNumber')} konnte noch nicht gesendet werden. Wir versuchen es automatisch erneut. Bitte prüfen Sie, ob Ihr Stripe-Konto vollständig eingerichtet ist.`,
      short: `Auszahlung ${formatEur(p.amountCents)} verzögert.`,
    }),
    en: (p) => ({
      subject: `Payout delayed`,
      body: `Your payout of ${formatEur(p.amountCents)} for order ${str(p, 'orderNumber')} could not be sent yet. We will retry automatically. Please check that your Stripe account setup is complete.`,
      short: `Payout ${formatEur(p.amountCents)} delayed.`,
    }),
    ru: (p) => ({
      subject: `Выплата задерживается`,
      body: `Выплату ${formatEur(p.amountCents)} по заказу ${str(p, 'orderNumber')} пока отправить не удалось. Мы повторим попытку автоматически. Проверьте, полностью ли настроен ваш аккаунт Stripe.`,
      short: `Выплата ${formatEur(p.amountCents)} задерживается.`,
    }),
  },
  'payout.failed': {
    de: (p) => ({
      subject: `${p.terminal ? 'Auszahlung endgültig fehlgeschlagen' : 'Auszahlung fehlgeschlagen'} — ${str(p, 'orderNumber')}`,
      body: `Die Auszahlung von ${formatEur(p.amountCents)} für Bestellung ${str(p, 'orderNumber')} ist fehlgeschlagen (Versuch ${str(p, 'attempts')}): ${str(p, 'reason')}.${p.terminal ? ' Es werden keine automatischen Wiederholungen mehr ausgeführt — bitte manuell prüfen.' : ''}`,
      short: `Auszahlung ${str(p, 'orderNumber')} fehlgeschlagen.`,
    }),
    en: (p) => ({
      subject: `${p.terminal ? 'Payout permanently failed' : 'Payout failed'} — ${str(p, 'orderNumber')}`,
      body: `The payout of ${formatEur(p.amountCents)} for order ${str(p, 'orderNumber')} failed (attempt ${str(p, 'attempts')}): ${str(p, 'reason')}.${p.terminal ? ' No further automatic retries will run — this needs manual attention.' : ''}`,
      short: `Payout ${str(p, 'orderNumber')} failed.`,
    }),
    ru: (p) => ({
      subject: `${p.terminal ? 'Выплата окончательно не прошла' : 'Выплата не прошла'} — ${str(p, 'orderNumber')}`,
      body: `Выплата ${formatEur(p.amountCents)} по заказу ${str(p, 'orderNumber')} не прошла (попытка ${str(p, 'attempts')}): ${str(p, 'reason')}.${p.terminal ? ' Автоматических повторов больше не будет — требуется ручная проверка.' : ''}`,
      short: `Выплата ${str(p, 'orderNumber')} не прошла.`,
    }),
  },
  'refund.failed': {
    de: (p) => ({
      subject: `${p.terminal ? 'Erstattung endgültig fehlgeschlagen' : 'Erstattung fehlgeschlagen'} — ${str(p, 'orderNumber')}`,
      body: `Die Erstattung von ${formatEur(p.amountCents)} für Bestellung ${str(p, 'orderNumber')} (${str(p, 'reason')}) ist fehlgeschlagen (Versuch ${str(p, 'attempts')}): ${str(p, 'error')}.${p.terminal ? ' Es werden keine automatischen Wiederholungen mehr ausgeführt — bitte manuell erstatten.' : ''}`,
      short: `Erstattung ${str(p, 'orderNumber')} fehlgeschlagen.`,
    }),
    en: (p) => ({
      subject: `${p.terminal ? 'Refund permanently failed' : 'Refund failed'} — ${str(p, 'orderNumber')}`,
      body: `The refund of ${formatEur(p.amountCents)} for order ${str(p, 'orderNumber')} (${str(p, 'reason')}) failed (attempt ${str(p, 'attempts')}): ${str(p, 'error')}.${p.terminal ? ' No further automatic retries will run — refund this manually.' : ''}`,
      short: `Refund ${str(p, 'orderNumber')} failed.`,
    }),
    ru: (p) => ({
      subject: `${p.terminal ? 'Возврат окончательно не прошёл' : 'Возврат не прошёл'} — ${str(p, 'orderNumber')}`,
      body: `Возврат ${formatEur(p.amountCents)} по заказу ${str(p, 'orderNumber')} (${str(p, 'reason')}) не прошёл (попытка ${str(p, 'attempts')}): ${str(p, 'error')}.${p.terminal ? ' Автоматических повторов больше не будет — верните средства вручную.' : ''}`,
      short: `Возврат ${str(p, 'orderNumber')} не прошёл.`,
    }),
  },
  'kyc.approved': {
    de: () => ({
      subject: `Verifizierung genehmigt`,
      body: `Ihre Prüfer-Verifizierung (KYC) wurde genehmigt. Sie können jetzt Aufträge annehmen.`,
      short: `KYC genehmigt — Sie sind verifiziert.`,
    }),
    en: () => ({
      subject: `Verification approved`,
      body: `Your inspector verification (KYC) was approved. You can now accept jobs.`,
      short: `KYC approved — you are verified.`,
    }),
    ru: () => ({
      subject: `Верификация одобрена`,
      body: `Ваша верификация инспектора (KYC) одобрена. Теперь вы можете принимать заказы.`,
      short: `KYC одобрена — вы верифицированы.`,
    }),
  },
  'kyc.rejected': {
    de: (p) => ({
      subject: `Verifizierung abgelehnt`,
      body: `Ihre Prüfer-Verifizierung (KYC) wurde abgelehnt. Grund: ${str(p, 'reason', '—')}. Bitte reichen Sie sie erneut ein.`,
      short: `KYC abgelehnt: ${str(p, 'reason', '—')}`,
    }),
    en: (p) => ({
      subject: `Verification rejected`,
      body: `Your inspector verification (KYC) was rejected. Reason: ${str(p, 'reason', '—')}. Please re-submit.`,
      short: `KYC rejected: ${str(p, 'reason', '—')}`,
    }),
    ru: (p) => ({
      subject: `Верификация отклонена`,
      body: `Ваша верификация инспектора (KYC) отклонена. Причина: ${str(p, 'reason', '—')}. Пожалуйста, отправьте повторно.`,
      short: `KYC отклонена: ${str(p, 'reason', '—')}`,
    }),
  },
  'ppv.purchased': {
    de: (p) => ({
      subject: `Bericht freigeschaltet`,
      body: `Sie haben den Zugriff auf Bericht ${str(p, 'reportCode')} freigeschaltet (${formatEur(p.amountCents)}).`,
      short: `Bericht ${str(p, 'reportCode')} freigeschaltet.`,
    }),
    en: (p) => ({
      subject: `Report unlocked`,
      body: `You have unlocked access to report ${str(p, 'reportCode')} (${formatEur(p.amountCents)}).`,
      short: `Report ${str(p, 'reportCode')} unlocked.`,
    }),
    ru: (p) => ({
      subject: `Отчёт разблокирован`,
      body: `Вы разблокировали доступ к отчёту ${str(p, 'reportCode')} (${formatEur(p.amountCents)}).`,
      short: `Отчёт ${str(p, 'reportCode')} разблокирован.`,
    }),
  },
  'vin_history.failed': {
    de: (p) => ({
      subject: `VIN-Abfrage fehlgeschlagen — ${str(p, 'vin')}`,
      body: `Die bezahlte VIN-Historie für ${str(p, 'vin')} konnte nicht geliefert werden: ${str(p, 'reason')}. Der Betrag von ${formatEur(p.amountCents)} wurde automatisch erstattet. Bitte prüfen Sie den Anbieter-Status.`,
      short: `VIN-Abfrage ${str(p, 'vin')} fehlgeschlagen, erstattet.`,
    }),
    en: (p) => ({
      subject: `VIN lookup failed — ${str(p, 'vin')}`,
      body: `The paid VIN history for ${str(p, 'vin')} could not be delivered: ${str(p, 'reason')}. ${formatEur(p.amountCents)} was refunded automatically. Please check the provider status.`,
      short: `VIN lookup ${str(p, 'vin')} failed, refunded.`,
    }),
    ru: (p) => ({
      subject: `Запрос истории VIN не выполнен — ${str(p, 'vin')}`,
      body: `Оплаченную историю по VIN ${str(p, 'vin')} доставить не удалось: ${str(p, 'reason')}. Сумма ${formatEur(p.amountCents)} возвращена автоматически. Проверьте состояние провайдера.`,
      short: `Запрос по VIN ${str(p, 'vin')} не выполнен, средства возвращены.`,
    }),
  },
  'listing.published': {
    de: (p) => ({
      subject: `Anzeige veröffentlicht`,
      body: `Ihre Anzeige für ${str(p, 'make')} ${str(p, 'model')} ist jetzt live im Showroom.`,
      short: `Anzeige für ${str(p, 'make')} ${str(p, 'model')} veröffentlicht.`,
    }),
    en: (p) => ({
      subject: `Listing published`,
      body: `Your listing for ${str(p, 'make')} ${str(p, 'model')} is now live in the showroom.`,
      short: `Listing for ${str(p, 'make')} ${str(p, 'model')} published.`,
    }),
    ru: (p) => ({
      subject: `Объявление опубликовано`,
      body: `Ваше объявление о ${str(p, 'make')} ${str(p, 'model')} опубликовано в шоуруме.`,
      short: `Объявление о ${str(p, 'make')} ${str(p, 'model')} опубликовано.`,
    }),
  },
  'listing.expiring': {
    de: (p) => ({
      subject: `Anzeige läuft bald ab`,
      body: `Ihre Anzeige für ${str(p, 'make')} ${str(p, 'model')} läuft bald ab. Verlängern Sie sie, um sichtbar zu bleiben.`,
      short: `Anzeige für ${str(p, 'make')} ${str(p, 'model')} läuft bald ab.`,
    }),
    en: (p) => ({
      subject: `Listing expiring soon`,
      body: `Your listing for ${str(p, 'make')} ${str(p, 'model')} is expiring soon. Renew it to stay visible.`,
      short: `Listing for ${str(p, 'make')} ${str(p, 'model')} expiring soon.`,
    }),
    ru: (p) => ({
      subject: `Объявление скоро истечёт`,
      body: `Срок вашего объявления о ${str(p, 'make')} ${str(p, 'model')} скоро истечёт. Продлите его, чтобы остаться видимым.`,
      short: `Объявление о ${str(p, 'make')} ${str(p, 'model')} скоро истечёт.`,
    }),
  },
};

/** Resolve a supported locale, falling back to the platform default. */
export function resolveLocale(locale?: string): NotificationLocale {
  if (locale && (SUPPORTED_LOCALES as string[]).includes(locale)) {
    return locale as NotificationLocale;
  }
  return DEFAULT_LOCALE;
}

/**
 * Render a notification for the given type/locale from its payload. Falls back
 * to the default locale, and finally to a generic message, so rendering never
 * throws into the calling flow.
 */
export function renderTemplate(
  type: NotificationType,
  locale: string | undefined,
  payload: Record<string, unknown>,
): RenderedTemplate {
  const loc = resolveLocale(locale);
  const byLocale = CATALOG[type];
  const fn = byLocale?.[loc] ?? byLocale?.[DEFAULT_LOCALE];
  if (!fn) {
    return { subject: type, body: type, short: type };
  }
  return fn(payload ?? {});
}
