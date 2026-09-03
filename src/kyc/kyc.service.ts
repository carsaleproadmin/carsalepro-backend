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
  KYC_AUTO_REVIEWER,
  KYC_MANUAL_REVIEW_AFTER_STATUSES,
  KYC_QUEUE_DEFAULT_LIMIT,
  KYC_QUEUE_DEFAULT_STATUSES,
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
   * Submit a DRAFT application. Requires all REQUIRED_KYC_KINDS documents
   * present, then APPROVES IT IMMEDIATELY - DRAFT→APPROVED in one step.
   *
   * **What this method verifies is that four files exist. Nothing reads them.**
   * That was true before this change too: `submitApplication` only ever counted
   * kinds, and the judgement of what the documents actually showed lived with
   * the admin who opened them. Removing the admin removes the judgement with
   * him - whoever uploads four images becomes an inspector, and an inspector is
   * dispatched to strangers' vehicles and paid out of escrow. That is a
   * decision of the platform owner (2026-09-03, DEN-236), not an oversight, and
   * it must not be reworded into something that sounds verified: the applicant
   * is notified through `kyc.approved`, whose wording must not claim that
   * documents were checked.
   *
   * The path back is `reject`, which is why APPROVED→REJECTED exists in
   * `KYC_TRANSITIONS`. Approval that cannot be revoked is what makes an
   * automatic grant dangerous, rather than the grant itself.
   *
   * **AUTOMATIC APPROVAL IS NOT GIVEN TO AN APPLICANT WHO WAS REJECTED BEFORE**
   * (DEN-239). Such an application stops at SUBMITTED and waits for an admin,
   * because the alternative is that a revoked inspector re-applies with the
   * same four files and is let back in by the machine, which would leave the
   * revocation entirely under the control of the person it was used against.
   * See `KYC_MANUAL_REVIEW_AFTER_STATUSES`.
   *
   * `submittedAt` and `reviewedAt` are the same instant here, and both are
   * stamped: they mean different things (when the applicant acted, when the
   * decision was taken) and a reader must not have to infer one from the other.
   */
  async submitApplication(userId: string, applicationId: string): Promise<SubmitKycResultDto> {
    const application = await this.requireOwnedApplication(userId, applicationId);
    // Guarded against SUBMITTED rather than APPROVED so a DRAFT is still the
    // only state that may be submitted; DRAFT→APPROVED is what actually gets
    // written, and the transition table allows both moves out of DRAFT.
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

    // Any earlier decision against this applicant, not only the last one: the
    // count is over the user's whole history, so a rejection cannot be aged out
    // by creating drafts, and the query excludes the row being submitted.
    const priorRejections = await this.prisma.kycApplication.count({
      where: {
        userId,
        id: { not: applicationId },
        status: { in: KYC_MANUAL_REVIEW_AFTER_STATUSES },
      },
    });

    if (priorRejections > 0) {
      const held = await this.prisma.kycApplication.update({
        where: { id: applicationId },
        data: { status: KycStatus.SUBMITTED, submittedAt },
      });
      // `user.kycVerified` is deliberately NOT touched. `reject` cleared it,
      // and only an admin's `approve` may set it again on this path.
      await this.notifications.notify(userId, 'kyc.submitted', { applicationId });
      this.logger.log(
        `KYC application ${applicationId} submitted, HELD FOR REVIEW ` +
          `(prior rejections=${priorRejections}) user=${this.mask(userId)}`,
      );
      return {
        id: held.id,
        status: held.status,
        submittedAt: submittedAt.toISOString(),
      };
    }

    // One transaction, as in `approve`: the application's status and the user's
    // flag are one fact. Split, a failure between them leaves an APPROVED
    // application whose owner cannot be dispatched, and nothing says why.
    const [updated] = await this.prisma.$transaction([
      this.prisma.kycApplication.update({
        where: { id: applicationId },
        data: {
          status: KycStatus.APPROVED,
          submittedAt,
          reviewedBy: KYC_AUTO_REVIEWER,
          reviewedAt: submittedAt,
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { kycVerified: true },
      }),
    ]);

    // Same event as a manual approval - the inspector's experience is that the
    // application was accepted, and it was.
    await this.notifications.notify(userId, 'kyc.approved', { applicationId });
    this.logger.log(
      `KYC application ${applicationId} submitted and AUTO-APPROVED user=${this.mask(userId)}`,
    );
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
   * Review queue. Defaults to `KYC_QUEUE_DEFAULT_STATUSES` (SUBMITTED +
   * IN_REVIEW + APPROVED, and that constant says why APPROVED is in the default
   * set); an optional status filter narrows it. Includes the applicant's email/name and the document kinds.
   */
  async listQueue(
    status?: KycStatus,
    limit?: number,
    offset?: number,
    q?: string,
  ): Promise<AdminKycQueueDto> {
    const where: Prisma.KycApplicationWhereInput = status
      ? { status }
      : { status: { in: KYC_QUEUE_DEFAULT_STATUSES } };

    // The search is on the applicant, not on the application: an admin who
    // must switch an inspector off knows the person, and never the id of a row.
    const term = q?.trim();
    if (term) {
      where.user = {
        OR: [
          { email: { contains: term, mode: 'insensitive' } },
          { name: { contains: term, mode: 'insensitive' } },
        ],
      };
    }

    const applications = await this.prisma.kycApplication.findMany({
      where,
      /*
       * NEWEST FIRST, reversed on 2026-09-03 with automatic approval (DEN-236).
       *
       * Oldest-first is right for a backlog someone works through, and that is
       * what this list used to be. It is now mostly a record of who has been
       * granted access, and the applicant an admin needs — the one who just
       * joined, or the one just reported — is the most recent. Ascending order
       * would bury every new entry behind every inspector ever approved.
       *
       * `createdAt` breaks the tie rather than being a fallback: `submittedAt`
       * is set on every row this list shows, but a DRAFT reached through
       * `?status=DRAFT` has none, and a null must not sort arbitrarily.
       */
      orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit ?? KYC_QUEUE_DEFAULT_LIMIT,
      skip: offset ?? 0,
      include: { documents: true, user: true },
    });

    // Counted with the same `where`, so the number describes the set the caller
    // asked for rather than the table.
    const total = await this.prisma.kycApplication.count({ where });

    return {
      total,
      items: applications.map((a) => ({
        id: a.id,
        status: a.status,
        user: { id: a.user.id, email: a.user.email, name: a.user.name },
        documentKinds: a.documents.map((d) => d.kind),
        submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
        createdAt: a.createdAt.toISOString(),
        /*
         * Who decided, exposed so the list can say it out loud.
         *
         * `KYC_AUTO_REVIEWER` here means nobody looked at the documents. An
         * admin about to act on an applicant is owed that distinction, and
         * without it every row looks equally reviewed.
         */
        reviewedBy: a.reviewedBy,
        reviewedAt: a.reviewedAt ? a.reviewedAt.toISOString() : null,
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

  /**
   * Reject an application: →REJECTED with a reason, and CLEAR `kycVerified`.
   *
   * **This is the revocation path**, and since applications are approved
   * automatically it is the only one. Rejecting an application that is already
   * APPROVED is legal (see `KYC_TRANSITIONS`) and is how an inspector who
   * should not have been granted access is switched off.
   *
   * `kycVerified: false` is written on every rejection, not only on the ones
   * that follow an approval. Setting it unconditionally cannot be wrong - a
   * rejected applicant has no verified standing by definition - while making it
   * conditional on the previous status would leave the flag standing after any
   * path the condition failed to anticipate. `approve` sets the flag, so `reject`
   * clears it; anything else is an approval that only pretends to be reversible.
   *
   * The write is one transaction with the status change for the same reason
   * approval is: a rejected application whose owner still passes the
   * eligibility filter is worse than either outcome alone.
   */
  async reject(applicationId: string, adminId: string, reason: string): Promise<AdminKycDecisionDto> {
    const application = await this.requireApplication(applicationId);
    this.assertTransition(application.status, KycStatus.REJECTED);

    const reviewedAt = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.kycApplication.update({
        where: { id: applicationId },
        data: {
          status: KycStatus.REJECTED,
          rejectReason: reason,
          reviewedBy: adminId,
          reviewedAt,
        },
      }),
      this.prisma.user.update({
        where: { id: application.userId },
        data: { kycVerified: false },
      }),
    ]);

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
