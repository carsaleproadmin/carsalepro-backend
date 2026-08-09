import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KycApplication, KycDocument, KycStatus, Prisma } from '@prisma/client';
import { PhotoProcessingService } from '../common/photo/photo-processing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../r2/r2.service';
import {
  ACTIVE_KYC_STATUSES,
  KYC_TRANSITIONS,
  KycDocumentKind,
  REQUIRED_KYC_KINDS,
} from './kyc.constants';
import {
  AdminKycApplicationDto,
  AdminKycDecisionDto,
  AdminKycQueueDto,
} from './dto/admin-kyc-response.dto';
import {
  KycApplicationDto,
  KycDocumentUploadResultDto,
  SubmitKycResultDto,
} from './dto/kyc-response.dto';
import { KycUploadPart, resolveKycObject } from './kyc-upload';

type KycApplicationWithDocs = KycApplication & { documents: KycDocument[] };

/** Number of days after review before approved/rejected documents may be purged. */
const PURGE_AFTER_DAYS = 90;

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly notifications: NotificationsService,
    private readonly photoProcessing: PhotoProcessingService,
  ) {}

  // ============================================================
  // Inspector-facing
  // ============================================================

  /**
   * Create a DRAFT application for the user. If they already have a live one
   * (DRAFT/SUBMITTED/IN_REVIEW) that existing application is returned instead —
   * no duplicate is created. A new application is only allowed once any prior
   * one is APPROVED or REJECTED.
   */
  async createApplication(userId: string): Promise<KycApplicationDto> {
    const existing = await this.prisma.kycApplication.findFirst({
      where: { userId, status: { in: ACTIVE_KYC_STATUSES } },
      orderBy: { createdAt: 'desc' },
      include: { documents: true },
    });
    if (existing) return this.toApplicationDto(existing);

    const created = await this.prisma.kycApplication.create({
      data: { userId, status: KycStatus.DRAFT },
      include: { documents: true },
    });
    this.logger.log(`KYC application ${created.id} created for user=${this.mask(userId)}`);
    return this.toApplicationDto(created);
  }

  /**
   * Store ONE document for a DRAFT application the caller owns.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * WHY THE BYTES GO THROUGH THE API AND NOT STRAIGHT TO R2
   * ═══════════════════════════════════════════════════════════════════════
   *
   * This replaces a presigned-PUT flow that could never work in production and
   * must not be restored. The browser was handed a presigned URL for the
   * private KYC bucket, and that bucket has no CORS configuration — so the PUT
   * was refused by the browser before a byte left it, and no inspector could
   * be verified, which meant no inspection order could ever complete.
   *
   * ADDING CORS TO THAT BUCKET IS NOT THE FIX. A CORS rule permitting PUT is a
   * standing browser-reachable write path into the identity-document store; a
   * leaked or logged presigned URL becomes an upload endpoint for anyone.
   * Routing the bytes through the API keeps the KYC credentials server-side,
   * lets the content be validated against its own bytes (`resolveKycObject`)
   * instead of against a claim, and is what makes the object key, the content
   * type and the row agree with each other.
   *
   * ORDER OF OPERATIONS IS PART OF THE CONTRACT:
   * ownership → DRAFT → a file is present → storage configured → the file is
   * what it says it is → write the object → upsert the row → delete whatever
   * the upsert displaced.
   *
   * The row is written LAST, on purpose. The presign path wrote it FIRST, so a
   * server with no R2 credentials still recorded a `KycDocument` pointing at an
   * object that was never uploaded — an application could be submitted, and
   * approved, with no documents behind it at all.
   */
  async uploadDocument(
    userId: string,
    applicationId: string,
    kind: KycDocumentKind,
    file: KycUploadPart,
  ): Promise<KycDocumentUploadResultDto> {
    const application = await this.requireOwnedApplication(userId, applicationId);
    if (application.status !== KycStatus.DRAFT) {
      throw new BadRequestException({
        error: {
          code: 'kyc_not_editable',
          message: 'Documents can only be uploaded while the application is a draft',
        },
      });
    }

    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        error: {
          code: 'file_required',
          message: 'Send the document in the `file` multipart field',
        },
      });
    }

    if (!this.r2.isKycConfigured()) {
      throw new HttpException(
        {
          error: {
            code: 'storage_unavailable',
            message: 'Cloud storage is not configured on this server',
          },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const plan = resolveKycObject(file);

    // PDFs are stored verbatim — they are the Gewerbeschein and the insurance
    // certificate, vector text that must stay legible and must not be
    // rasterised. Images are compressed by the SHARED PhotoProcessingService
    // (one instance, one sharp semaphore).
    //
    // The settings deliberately differ from the report pipeline's. Those are
    // tuned for car paint on a body panel; this is a photograph of an A4 sheet
    // of small print. 2400 px keeps a registration number readable, q88 keeps
    // the compression artefacts off the glyph edges, and 4:4:4 chroma matters
    // most of all — 4:2:0 discards three quarters of the colour resolution,
    // which is invisible on a wing and smears coloured stamp ink into mush.
    const body = plan.compress
      ? (
          await this.photoProcessing.compress(file.buffer, {
            maxEdgePx: 2400,
            quality: 88,
            chromaSubsampling: '4:4:4',
          })
        ).data
      : file.buffer;

    const s3Key = `kyc/${userId}/${applicationId}/${kind}-${randomUUID()}.${plan.extension}`;

    // What this upload displaces, captured BEFORE the upsert: the old object is
    // deleted only after the row stops pointing at it, so a failure between the
    // two leaves an orphan in the bucket rather than a row pointing at nothing.
    const previous = await this.prisma.kycDocument.findUnique({
      where: { applicationId_kind: { applicationId, kind } },
    });

    // The write must name the KYC bucket. `putObject` hardcodes the REPORTS
    // bucket, so using it here would put an identity document in the public
    // store while the call site still read as correct.
    const bucket = await this.r2.kycPutObject(s3Key, body, plan.storedContentType);

    const row = await this.prisma.kycDocument.upsert({
      where: { applicationId_kind: { applicationId, kind } },
      create: { applicationId, kind, s3Key, bucket },
      update: { s3Key, bucket, uploadedAt: new Date(), purgedAt: null },
    });

    if (previous && previous.s3Key !== s3Key) {
      // Best effort: a superseded identity document must not linger, but a
      // delete that fails must not fail the upload the user just completed.
      // `purgeOldDocuments` is the backstop.
      await this.r2.kycDeleteObject(previous.s3Key, previous.bucket).catch((err) => {
        this.logger.warn(
          `Failed to delete superseded KYC object ${previous.s3Key}: ${String(err)}`,
        );
      });
    }

    this.logger.log(
      `KYC upload app=${applicationId} kind=${kind} user=${this.mask(userId)} ` +
        `${plan.sniffed} ${file.buffer.length} -> ${body.length} bytes` +
        `${previous ? ' (replaced)' : ''}`,
    );

    return {
      kind,
      uploadedAt: row.uploadedAt.toISOString(),
      contentType: plan.storedContentType,
      sizeBytes: body.length,
      sourceBytes: file.buffer.length,
      replaced: previous !== null,
    };
  }

  /**
   * Submit a DRAFT application for review. Requires all REQUIRED_KYC_KINDS
   * documents present. Transitions DRAFT→SUBMITTED and stamps submittedAt.
   */
  async submitApplication(userId: string, applicationId: string): Promise<SubmitKycResultDto> {
    const application = await this.requireOwnedApplication(userId, applicationId);
    this.assertTransition(application.status, KycStatus.SUBMITTED);

    const present = new Set(application.documents.map((d) => d.kind));
    const missing = REQUIRED_KYC_KINDS.filter((k) => !present.has(k));
    if (missing.length > 0) {
      throw new BadRequestException({
        error: {
          code: 'incomplete_kyc',
          message: `Missing required documents: ${missing.join(', ')}`,
        },
      });
    }

    const submittedAt = new Date();
    const updated = await this.prisma.kycApplication.update({
      where: { id: applicationId },
      data: { status: KycStatus.SUBMITTED, submittedAt },
    });
    this.logger.log(`KYC application ${applicationId} submitted by user=${this.mask(userId)}`);
    return {
      id: updated.id,
      status: updated.status,
      submittedAt: submittedAt.toISOString(),
    };
  }

  /** The user's latest application (kinds + uploadedAt only — no raw s3Keys). */
  async getMyApplication(userId: string): Promise<KycApplicationDto | null> {
    const application = await this.prisma.kycApplication.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { documents: true },
    });
    return application ? this.toApplicationDto(application) : null;
  }

  // ============================================================
  // Admin-facing
  // ============================================================

  /**
   * Review queue. Defaults to SUBMITTED + IN_REVIEW; an optional status filter
   * narrows it. Includes the applicant's email/name and the document kinds.
   */
  async listQueue(status?: KycStatus): Promise<AdminKycQueueDto> {
    const where: Prisma.KycApplicationWhereInput = status
      ? { status }
      : { status: { in: [KycStatus.SUBMITTED, KycStatus.IN_REVIEW] } };

    const applications = await this.prisma.kycApplication.findMany({
      where,
      orderBy: [{ submittedAt: 'asc' }, { createdAt: 'asc' }],
      include: { documents: true, user: true },
    });

    return {
      items: applications.map((a) => ({
        id: a.id,
        status: a.status,
        user: { id: a.user.id, email: a.user.email, name: a.user.name },
        documentKinds: a.documents.map((d) => d.kind),
        submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Application detail with short-lived signed view URLs per document. Viewing a
   * SUBMITTED application transitions it to IN_REVIEW (so the queue reflects that
   * a reviewer has picked it up).
   */
  async getApplicationForAdmin(applicationId: string): Promise<AdminKycApplicationDto> {
    let application = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      include: { documents: true, user: true },
    });
    if (!application) {
      throw new NotFoundException({
        error: { code: 'not_found', message: 'KYC application not found' },
      });
    }

    if (application.status === KycStatus.SUBMITTED) {
      application = await this.prisma.kycApplication.update({
        where: { id: applicationId },
        data: { status: KycStatus.IN_REVIEW },
        include: { documents: true, user: true },
      });
    }

    const documents = await Promise.all(
      application.documents.map(async (d) => {
        let viewUrl: string | null = null;
        let viewUrlExpiresAt: string | null = null;
        if (!d.purgedAt && this.r2.isKycConfigured()) {
          // KYC docs are sensitive — always serve via a short-lived SIGNED URL,
          // never the public-URL shortcut (which createPresignedDownloadUrl would
          // use for the public reports bucket when R2_PUBLIC_URL is set).
          // `d.bucket` decides which client/bucket the signature is minted for,
          // so pre-migration rows in the shared bucket keep resolving.
          const signed = await this.r2.kycSignedDownloadUrl(d.s3Key, d.bucket);
          viewUrl = signed.url;
          viewUrlExpiresAt = signed.expiresAt.toISOString();
        }
        return {
          id: d.id,
          kind: d.kind,
          uploadedAt: d.uploadedAt.toISOString(),
          viewUrl,
          viewUrlExpiresAt,
        };
      }),
    );

    return {
      id: application.id,
      status: application.status,
      user: {
        id: application.user.id,
        email: application.user.email,
        name: application.user.name,
      },
      documents,
      rejectReason: application.rejectReason,
      reviewedBy: application.reviewedBy,
      reviewedAt: application.reviewedAt ? application.reviewedAt.toISOString() : null,
      submittedAt: application.submittedAt ? application.submittedAt.toISOString() : null,
      createdAt: application.createdAt.toISOString(),
    };
  }

  /** Approve an application: →APPROVED, stamp reviewer, set user.kycVerified=true. */
  async approve(applicationId: string, adminId: string): Promise<AdminKycDecisionDto> {
    const application = await this.requireApplication(applicationId);
    this.assertTransition(application.status, KycStatus.APPROVED);

    const reviewedAt = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.kycApplication.update({
        where: { id: applicationId },
        data: { status: KycStatus.APPROVED, reviewedBy: adminId, reviewedAt },
      }),
      this.prisma.user.update({
        where: { id: application.userId },
        data: { kycVerified: true },
      }),
    ]);

    // E11: notify the inspector their KYC was approved (non-throwing).
    await this.notifications.notify(application.userId, 'kyc.approved', {
      applicationId,
    });
    this.logger.log(
      `KYC application ${applicationId} APPROVED by admin=${this.mask(adminId)} ` +
        `user=${this.mask(application.userId)}`,
    );
    return {
      id: updated.id,
      status: updated.status,
      reviewedAt: reviewedAt.toISOString(),
      rejectReason: null,
    };
  }

  /** Reject an application: →REJECTED with a reason. */
  async reject(applicationId: string, adminId: string, reason: string): Promise<AdminKycDecisionDto> {
    const application = await this.requireApplication(applicationId);
    this.assertTransition(application.status, KycStatus.REJECTED);

    const reviewedAt = new Date();
    const updated = await this.prisma.kycApplication.update({
      where: { id: applicationId },
      data: {
        status: KycStatus.REJECTED,
        rejectReason: reason,
        reviewedBy: adminId,
        reviewedAt,
      },
    });

    // E11: notify the inspector their KYC was rejected, with the reason (non-throwing).
    await this.notifications.notify(application.userId, 'kyc.rejected', {
      applicationId,
      reason,
    });
    this.logger.log(
      `KYC application ${applicationId} REJECTED by admin=${this.mask(adminId)} ` +
        `user=${this.mask(application.userId)}`,
    );
    return {
      id: updated.id,
      status: updated.status,
      reviewedAt: reviewedAt.toISOString(),
      rejectReason: updated.rejectReason,
    };
  }

  // ============================================================
  // Data minimization (Should) — exposed for the E11 worker.
  // ============================================================

  /**
   * Delete R2 objects (kyc/ prefix, in whichever bucket each row records) for
   * documents belonging to APPROVED/REJECTED
   * applications reviewed more than PURGE_AFTER_DAYS ago that haven't been purged
   * yet, and stamp purgedAt on each. Returns the number of documents purged.
   */
  async purgeOldDocuments(): Promise<number> {
    const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 86_400_000);
    const documents = await this.prisma.kycDocument.findMany({
      where: {
        purgedAt: null,
        application: {
          status: { in: [KycStatus.APPROVED, KycStatus.REJECTED] },
          reviewedAt: { lt: cutoff },
        },
      },
    });

    let purged = 0;
    for (const doc of documents) {
      if (this.r2.isKycConfigured()) {
        await this.r2.kycDeleteObject(doc.s3Key, doc.bucket).catch((err) => {
          this.logger.warn(`Failed to delete KYC object ${doc.s3Key}: ${String(err)}`);
        });
      }
      await this.prisma.kycDocument.update({
        where: { id: doc.id },
        data: { purgedAt: new Date() },
      });
      purged += 1;
    }
    if (purged > 0) this.logger.log(`Purged ${purged} old KYC document(s)`);
    return purged;
  }

  // ============================================================
  // Helpers
  // ============================================================

  private toApplicationDto(application: KycApplicationWithDocs): KycApplicationDto {
    return {
      id: application.id,
      status: application.status,
      documents: application.documents.map((d) => ({
        kind: d.kind,
        uploadedAt: d.uploadedAt.toISOString(),
      })),
      rejectReason: application.rejectReason,
      submittedAt: application.submittedAt ? application.submittedAt.toISOString() : null,
      reviewedAt: application.reviewedAt ? application.reviewedAt.toISOString() : null,
      createdAt: application.createdAt.toISOString(),
    };
  }

  /** Load an application the caller owns (with documents), or throw 404/403. */
  private async requireOwnedApplication(
    userId: string,
    applicationId: string,
  ): Promise<KycApplicationWithDocs> {
    const application = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      include: { documents: true },
    });
    if (!application) {
      throw new NotFoundException({
        error: { code: 'not_found', message: 'KYC application not found' },
      });
    }
    if (application.userId !== userId) {
      throw new ForbiddenException({
        error: { code: 'not_kyc_owner', message: 'You do not own this KYC application' },
      });
    }
    return application;
  }

  private async requireApplication(applicationId: string): Promise<KycApplication> {
    const application = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
    });
    if (!application) {
      throw new NotFoundException({
        error: { code: 'not_found', message: 'KYC application not found' },
      });
    }
    return application;
  }

  /** Enforce the DRAFT→SUBMITTED→IN_REVIEW→APPROVED|REJECTED state machine. */
  private assertTransition(from: KycStatus, to: KycStatus): void {
    if (!KYC_TRANSITIONS[from].includes(to)) {
      throw new ConflictException({
        error: {
          code: 'illegal_transition',
          message: `Cannot move a KYC application from ${from} to ${to}`,
        },
      });
    }
  }

  private mask(id: string): string {
    if (id.length <= 8) return '****';
    return `${id.slice(0, 4)}…${id.slice(-4)}`;
  }
}
