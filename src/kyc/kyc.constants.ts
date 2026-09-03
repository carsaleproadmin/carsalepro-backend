import { KycStatus } from '@prisma/client';

/** Document kinds accepted for a KYC application. */
export const KYC_DOCUMENT_KINDS = [
  'id_front',
  'id_back',
  'selfie',
  'gewerbeschein',
  'insurance',
] as const;

export type KycDocumentKind = (typeof KYC_DOCUMENT_KINDS)[number];

/** Kinds that must all be present before an application may be submitted. */
export const REQUIRED_KYC_KINDS: KycDocumentKind[] = [
  'id_front',
  'id_back',
  'selfie',
  'gewerbeschein',
];

/** Statuses that mean a user has a live application (blocks creating a new one). */
export const ACTIVE_KYC_STATUSES: KycStatus[] = [
  KycStatus.DRAFT,
  KycStatus.SUBMITTED,
  KycStatus.IN_REVIEW,
];

/**
 * Statuses of an EARLIER application that send the next one to a person.
 *
 * A rejection is the only way an admin can take an inspector's access away
 * (DEN-236). Automatic approval gives the applicant the other half of that
 * control back: after a rejection the same person creates a new application,
 * uploads the same four files, and the machine grants access again in under a
 * minute (DEN-239). The revocation would then hold for exactly as long as the
 * inspector allowed it.
 *
 * A rejected applicant is therefore not blocked from applying again - the
 * rejection may have been a mistake, and a permanent lock has no way out - but
 * the next application stops at SUBMITTED and waits for an admin. The reader
 * that automatic approval removed is put back at the one point where the
 * platform has already said no.
 */
export const KYC_MANUAL_REVIEW_AFTER_STATUSES: KycStatus[] = [KycStatus.REJECTED];

/** Allowed upload content types (an image or a PDF). */
export const ALLOWED_KYC_CONTENT_TYPE = /^(image\/[\w.+-]+|application\/pdf)$/i;

/**
 * Written into `reviewedBy` when the platform approved an application itself.
 *
 * The column otherwise holds an admin's user id, and the two must stay
 * distinguishable: after auto-approval nearly every row is machine-decided, so
 * a null or a blank would erase the record of the few a person actually
 * reviewed. It is not a user id and must never be resolved as one.
 */
export const KYC_AUTO_REVIEWER = 'auto';

/**
 * What the admin queue shows when no status filter is given.
 *
 * APPROVED is in the DEFAULT set, not behind a filter, and that is the point.
 * Since applications are approved automatically, nothing ever sits in SUBMITTED
 * or IN_REVIEW — a queue built from those two is permanently empty, and an
 * empty screen reads as "nobody applied", not as "everyone was let in". The
 * revocation path (`APPROVED→REJECTED`) is reachable only from a list that
 * shows approved applicants, so leaving them out would make the ability to
 * switch an inspector off exist in the API and nowhere a person can press it.
 *
 * REJECTED is excluded: those applicants hold nothing, and a decided-and-closed
 * row is history rather than a queue entry. `?status=REJECTED` still returns
 * them.
 */
export const KYC_QUEUE_DEFAULT_STATUSES: KycStatus[] = [
  KycStatus.SUBMITTED,
  KycStatus.IN_REVIEW,
  KycStatus.APPROVED,
];

/** Queue page size when the caller names none, and the ceiling it may ask for. */
export const KYC_QUEUE_DEFAULT_LIMIT = 100;
export const KYC_QUEUE_MAX_LIMIT = 500;

/**
 * Allowed status transitions: DRAFT→APPROVED (automatic, see
 * `KycService.submitApplication`), and APPROVED→REJECTED to revoke.
 *
 * IN_REVIEW and the manual decisions are kept: the admin queue still works, and
 * an application can still be rejected by hand.
 *
 * **APPROVED→REJECTED is the revocation path and is load-bearing.** It used to
 * be absent — the terminal states had no exits — which was tolerable while a
 * person looked at every application before approving it. It is not tolerable
 * now that approval is automatic: without an exit, access granted to whoever
 * uploaded four files could never be taken back. `KycService.reject` clears
 * `user.kycVerified` in the same transaction, so the transition really does
 * revoke rather than only relabel the application.
 */
export const KYC_TRANSITIONS: Record<KycStatus, KycStatus[]> = {
  [KycStatus.DRAFT]: [KycStatus.SUBMITTED, KycStatus.APPROVED],
  [KycStatus.SUBMITTED]: [KycStatus.IN_REVIEW, KycStatus.APPROVED, KycStatus.REJECTED],
  [KycStatus.IN_REVIEW]: [KycStatus.APPROVED, KycStatus.REJECTED],
  [KycStatus.APPROVED]: [KycStatus.REJECTED],
  [KycStatus.REJECTED]: [],
};
