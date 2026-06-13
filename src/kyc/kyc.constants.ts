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

/** Allowed upload content types (an image or a PDF). */
export const ALLOWED_KYC_CONTENT_TYPE = /^(image\/[\w.+-]+|application\/pdf)$/i;

/**
 * Allowed status transitions: DRAFT→SUBMITTED→IN_REVIEW→APPROVED|REJECTED.
 * Used by the small transition guard; an illegal move throws 409.
 */
export const KYC_TRANSITIONS: Record<KycStatus, KycStatus[]> = {
  [KycStatus.DRAFT]: [KycStatus.SUBMITTED],
  [KycStatus.SUBMITTED]: [KycStatus.IN_REVIEW, KycStatus.APPROVED, KycStatus.REJECTED],
  [KycStatus.IN_REVIEW]: [KycStatus.APPROVED, KycStatus.REJECTED],
  [KycStatus.APPROVED]: [],
  [KycStatus.REJECTED]: [],
};
