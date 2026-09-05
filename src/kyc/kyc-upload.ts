import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { ALLOWED_KYC_CONTENT_TYPE } from './kyc.constants';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * What a KYC upload is allowed to be, decided from the BYTES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module is pure on purpose: it takes the multipart part and returns a
 * plan, so the decision can be unit-tested against real file headers without a
 * database, an R2 client or a Nest module (`kyc-upload.spec.ts`).
 *
 * TWO THINGS IT FIXES, BOTH OF WHICH SHIPPED.
 *
 *  1. THE CONTENT TYPE COMES FROM THE MULTIPART PART, NEVER FROM A BODY FIELD.
 *     The presign endpoint this replaces validated an OPTIONAL `contentType`
 *     field with `if (contentType && !ALLOWED.test(contentType))` — so omitting
 *     the field skipped the check entirely and the object was stored as
 *     `application/octet-stream`. A validator that a client disables by not
 *     sending a value is not a validator. Here the type is `file.mimetype`,
 *     which multer reads off the part header; a part with no `Content-Type`
 *     arrives as `application/octet-stream` and is refused like any other
 *     unsupported type.
 *
 *  2. THE DECLARED TYPE IS CORROBORATED BY MAGIC BYTES. A header is a claim.
 *     `image/svg+xml` matches `ALLOWED_KYC_CONTENT_TYPE` (it is an `image/*`),
 *     and an SVG is a script container that a reviewer's browser would happily
 *     execute from a signed URL; sniffing refuses it because no image
 *     signature matches. The same check stops an HTML page labelled
 *     `image/png` and a renamed archive labelled `application/pdf`.
 *
 * PDFs ARE STORED AS-IS. They are the Gewerbeschein and insurance certificate
 * — vector text that must stay legible and must not be rasterised. Images are
 * handed to `PhotoProcessingService`, which always emits JPEG, which is why
 * the only extensions this can produce are `pdf` and `jpg`.
 */

/**
 * Hard ceiling on one document, matching the report- and listing-photo limits.
 * A phone photo of an ID is 3–8 MB and a scanned Gewerbeschein PDF well under
 * 1 MB, so this refuses only pathological input.
 */
export const MAX_KYC_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * What the sniffer can identify: PDF, plus the image containers `sharp` decodes
 * reliably on every build we ship. HEIC is deliberately absent — libheif is not
 * in every libvips build, so accepting it would make the endpoint's behaviour
 * depend on which binary happens to be installed. iOS transcodes to JPEG at
 * pick time when `accept` excludes HEIC, which is what the wizard does.
 */
export type KycSniffedFormat = 'pdf' | 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff';

/** Structural subset of `Express.Multer.File` — keeps this module dependency-free. */
export interface KycUploadPart {
  /** Content type of the PART, as sent in the multipart header. */
  mimetype?: string;
  originalname?: string;
  buffer?: Buffer;
  size?: number;
}

/**
 * Fingerprint one uploaded document: SHA-256 of the bytes, lower-case hex.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS CATCHES, AND WHAT IT DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A rejection is the only way to take an inspector's access away (DEN-236),
 * and the check that keeps a rejected applicant from being let back in by the
 * machine counts EARLIER APPLICATIONS OF THE SAME USER (DEN-239). A new
 * registration is a new `user_id`, so that count is zero and the same person
 * walks back in with the same four files.
 *
 * The hash gives those files an identity that survives a new account. It
 * catches THE SAME FILE, byte for byte. It does not catch the same person: a
 * re-crop, a re-save, one more photograph of the same passport all produce
 * different bytes, and no digest can see through that. This raises the cost of
 * walking back in from "register again" to "take the pictures again"; it is
 * not identity verification and must not be described as any.
 *
 * The SOURCE bytes are hashed, not the stored object. An image is re-encoded
 * by `PhotoProcessingService` before it is written, so hashing the object would
 * tie the value to a sharp/libvips build and two servers would disagree about
 * the same upload.
 */
export function hashKycDocument(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export interface KycObjectPlan {
  /** `pdf` is stored verbatim; `image` goes through server-side compression. */
  family: 'pdf' | 'image';
  /** The format the leading bytes actually are — not what the client claimed. */
  sniffed: KycSniffedFormat;
  /** True when the caller must run the bytes through `PhotoProcessingService`. */
  compress: boolean;
  /** Content type the stored object is written with (post-compression). */
  storedContentType: string;
  /**
   * Extension for the object key. The presign path minted `.bin` for
   * everything, so an admin download arrived as an unopenable blob and R2
   * served it as `application/octet-stream`.
   */
  extension: 'pdf' | 'jpg';
}

function fail(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => buffer[offset + i] === byte);
}

/**
 * Identify the container from its leading bytes, or null when nothing matches.
 *
 * The PDF header is looked for in the first kilobyte rather than at offset 0:
 * the specification allows leading junk and every real reader tolerates it, so
 * requiring offset 0 would refuse valid scans from some office suites.
 */
export function sniffKycFormat(buffer: Buffer): KycSniffedFormat | null {
  if (buffer.length < 12) return null;

  if (buffer.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  const gif = buffer.subarray(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  // Little-endian (Intel) and big-endian (Motorola) TIFF — a common scanner output.
  if (startsWith(buffer, [0x49, 0x49, 0x2a, 0x00])) return 'tiff';
  if (startsWith(buffer, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';

  return null;
}

/**
 * Decide how one uploaded document is stored, or throw a 400 saying why not.
 *
 * @param part the multipart file part (multer, memory storage)
 */
export function resolveKycObject(part: KycUploadPart): KycObjectPlan {
  const buffer = part.buffer;
  if (!buffer || buffer.length === 0) {
    fail('file_required', 'Send the document in the `file` multipart field');
  }

  // multer's `limits.fileSize` truncates rather than throwing on some
  // transports, so the ceiling is re-checked against the bytes we actually hold.
  if (buffer.length > MAX_KYC_UPLOAD_BYTES) {
    fail(
      'file_too_large',
      `A document may be at most ${Math.floor(MAX_KYC_UPLOAD_BYTES / (1024 * 1024))} MB`,
    );
  }

  const declared = (part.mimetype ?? '').trim().split(';')[0].toLowerCase();
  if (!declared || !ALLOWED_KYC_CONTENT_TYPE.test(declared)) {
    fail(
      'unsupported_content_type',
      'Upload a JPEG, PNG, WebP, GIF, TIFF or PDF. The multipart part must ' +
        'declare its Content-Type.',
    );
  }

  const sniffed = sniffKycFormat(buffer);
  if (sniffed === null) {
    fail(
      'unsupported_content_type',
      'The file is not a JPEG, PNG, WebP, GIF, TIFF or PDF (checked by reading ' +
        'the file itself, not its name or declared type).',
    );
  }

  const declaredFamily = declared === 'application/pdf' ? 'pdf' : 'image';
  const actualFamily = sniffed === 'pdf' ? 'pdf' : 'image';
  if (declaredFamily !== actualFamily) {
    fail(
      'content_type_mismatch',
      `The upload declares ${declared} but its contents are ${sniffed}.`,
    );
  }

  if (actualFamily === 'pdf') {
    return {
      family: 'pdf',
      sniffed: 'pdf',
      compress: false,
      storedContentType: 'application/pdf',
      extension: 'pdf',
    };
  }

  return {
    family: 'image',
    sniffed,
    // `PhotoProcessingService` always emits JPEG, so the stored type and the
    // extension are fixed regardless of what came in.
    compress: true,
    storedContentType: 'image/jpeg',
    extension: 'jpg',
  };
}
