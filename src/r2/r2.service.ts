import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfig } from '../config/configuration';

/**
 * RFC 6266 `Content-Disposition`, with the ASCII fallback AND the UTF-8 form.
 *
 * A VIN or a locale can be pure ASCII, but the filename passes through a signed
 * URL query parameter, and a stray quote or non-Latin character in the ASCII
 * form truncates the header at the wrong place — the browser then saves the file
 * under a mangled name, or under the key. Emitting both forms is what the RFC
 * prescribes and costs nothing.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Injectable()
export class R2Service implements OnModuleInit {
  private readonly logger = new Logger(R2Service.name);
  private client?: S3Client;
  private bucket!: string;
  private accountId!: string;
  private uploadTtl!: number;
  private downloadTtl!: number;
  private signedUrlTtl!: number;

  /**
   * Second client, authenticated with the narrowly-scoped `R2_KYC_*` token, for
   * the dedicated private KYC bucket (SECURITY.md H2). When those credentials
   * are absent it aliases the main client/bucket so local dev and CI keep
   * working — `kycDedicated` records which of the two is live.
   */
  private kycClient?: S3Client;
  private kycBucket!: string;
  private kycDedicated = false;

  /**
   * Third client, for the dedicated PUBLIC bucket that serves showroom listing
   * photos as permanent URLs.
   *
   * Public in R2 is a property of the BUCKET, so this cannot be a prefix of the
   * reports bucket — that would publish the paid inspection PDFs sitting beside
   * it. Unconfigured is the normal state in dev and CI: every accessor answers
   * false/undefined and callers fall back to signed URLs.
   */
  private publicClient?: S3Client;
  private publicBucket = '';
  private publicBaseUrl = '';

  constructor(@Inject(ConfigService) private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit(): void {
    const r2 = this.config.get('r2', { infer: true });
    const quota = this.config.get('quota', { infer: true });
    this.bucket = r2.bucket;
    this.accountId = r2.accountId;
    this.uploadTtl = quota.presignedUploadTtl;
    this.downloadTtl = quota.presignedDownloadTtl;
    // Dedicated TTL for always-signed private URLs (KYC docs). Minutes → seconds.
    this.signedUrlTtl = this.config.get('signedUrlTtlMinutes', { infer: true }) * 60;

    if (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey) {
      this.logger.warn(
        'R2 credentials not configured — uploads/downloads will fail until env vars are set',
      );
      // Nothing to fall back to; the KYC accessors stay unconfigured too.
      this.kycBucket = r2.bucket;
      return;
    }

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });
    this.logger.log(`R2 client ready (bucket=${this.bucket})`);

    this.initKycClient();
    this.initPublicClient();
  }

  /**
   * Wire the public-bucket client, or leave it off.
   *
   * Off is a supported, silent state — unlike the KYC fallback, nothing is
   * degraded by its absence: listing photos keep being served through signed
   * URLs exactly as they were. That is what lets this whole feature ship dark
   * and be switched on per environment by setting four variables.
   */
  private initPublicClient(): void {
    const pub = this.config.get('r2Public', { infer: true });
    const r2 = this.config.get('r2', { infer: true });

    if (!pub.accessKeyId || !pub.secretAccessKey || !pub.bucket || !pub.baseUrl) {
      this.logger.log(
        'R2_PUBLIC_* not configured — listing photos are served through signed URLs',
      );
      return;
    }
    if (pub.bucket === this.bucket || pub.bucket === this.kycBucket) {
      // Refusing here is the whole point of the separation. A misconfiguration
      // that pointed the public bucket at the reports bucket would publish every
      // paid PDF, and nothing downstream would notice.
      this.logger.error(
        `R2_PUBLIC_BUCKET (${pub.bucket}) must not be the reports or KYC bucket — ` +
          'public URLs stay disabled',
      );
      return;
    }

    this.publicClient = new S3Client({
      region: 'auto',
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: pub.accessKeyId,
        secretAccessKey: pub.secretAccessKey,
      },
    });
    this.publicBucket = pub.bucket;
    this.publicBaseUrl = pub.baseUrl;
    this.logger.log(`R2 public client ready (bucket=${this.publicBucket} at ${this.publicBaseUrl})`);
  }

  /**
   * Wire the dedicated KYC client, or fall back to the main one.
   *
   * The fallback keeps identity documents in the shared reports bucket — which
   * is what happened before BE-S8 and is NOT acceptable long-term. It does not
   * fail the boot, because taking the whole service down would be a worse
   * outcome than an un-isolated bucket that is still only ever reachable through
   * a signed URL. In production it logs at error level on every boot so the gap
   * cannot go unnoticed; `kycDedicated` records which of the two is live and
   * `KycDocument.bucket` records where each object actually landed, so the
   * migration window is unambiguous.
   */
  private initKycClient(): void {
    const kyc = this.config.get('r2Kyc', { infer: true });
    const r2 = this.config.get('r2', { infer: true });

    if (!kyc.accessKeyId || !kyc.secretAccessKey || !kyc.bucket) {
      this.kycClient = this.client;
      this.kycBucket = this.bucket;
      this.kycDedicated = false;
      const message =
        'R2_KYC_* not fully configured — KYC documents fall back to the shared reports ' +
        `bucket (${this.bucket}), which also serves public report PDFs. Set R2_KYC_BUCKET, ` +
        'R2_KYC_ACCESS_KEY_ID and R2_KYC_SECRET_ACCESS_KEY (SECURITY.md H2).';
      if (process.env.NODE_ENV === 'production') {
        this.logger.error(message);
      } else {
        this.logger.warn(message);
      }
      return;
    }

    this.kycClient = new S3Client({
      region: 'auto',
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: kyc.accessKeyId,
        secretAccessKey: kyc.secretAccessKey,
      },
    });
    this.kycBucket = kyc.bucket;
    this.kycDedicated = true;
    this.logger.log(`R2 KYC client ready (dedicated private bucket=${this.kycBucket})`);
  }

  isConfigured(): boolean {
    return this.client !== undefined;
  }

  private requireClient(): S3Client {
    if (!this.client) {
      throw new Error('R2 client not configured');
    }
    return this.client;
  }

  async headBucket(): Promise<void> {
    await this.requireClient().send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /** Store an object directly (used for rendered contract HTML — E10). */
  async putObject(
    key: string,
    body: string | Uint8Array | Buffer,
    contentType = 'application/octet-stream',
  ): Promise<void> {
    await this.requireClient().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async createPresignedUploadUrl(
    key: string,
    contentType = 'application/pdf',
  ): Promise<{ url: string; expiresAt: Date }> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(this.requireClient(), cmd, { expiresIn: this.uploadTtl });
    const expiresAt = new Date(Date.now() + this.uploadTtl * 1000);
    return { url, expiresAt };
  }

  /**
   * A short-lived SIGNED URL for an object in the reports bucket. Always signed.
   *
   * The `R2_PUBLIC_URL` short-circuit that used to live here is **gone**, not
   * merely discouraged. Defending it in production only would have left every
   * staging and preview deployment that still carried the variable serving the
   * whole reports bucket — paid inspection PDFs included — unsigned. And the
   * feature it existed for, permanent showroom images, now comes from a
   * separate public bucket, so there is nothing left for it to do.
   */
  async createPresignedDownloadUrl(key: string): Promise<{ url: string; expiresAt: Date }> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.requireClient(), cmd, { expiresIn: this.downloadTtl });
    const expiresAt = new Date(Date.now() + this.downloadTtl * 1000);
    return { url, expiresAt };
  }

  /**
   * Mint a short-lived SIGNED download URL against the MAIN bucket that never
   * falls back to the public URL shortcut.
   *
   * @deprecated for KYC — use {@link kycSignedDownloadUrl}, which also resolves
   * the dedicated private bucket. Kept for any other sensitive object stored in
   * the reports bucket.
   */
  async createPrivateSignedUrl(
    key: string,
    ttlSeconds?: number,
    options?: { filename?: string; contentType?: string },
  ): Promise<{ url: string; expiresAt: Date }> {
    const expiresIn = ttlSeconds ?? this.signedUrlTtl;
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      // Without this the browser saves the object under its KEY — a cuid and a
      // locale suffix. Someone who paid for a vehicle history should get
      // `carsalepro-vin-history-<VIN>.pdf` in their downloads folder.
      ...(options?.filename
        ? { ResponseContentDisposition: contentDisposition(options.filename) }
        : {}),
      ...(options?.contentType ? { ResponseContentType: options.contentType } : {}),
    });
    const url = await getSignedUrl(this.requireClient(), cmd, { expiresIn });
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    return { url, expiresAt };
  }

  /** Read an object back out of the main bucket (used by the photo mirror). */
  async getObjectBytes(key: string): Promise<Buffer | null> {
    try {
      const res = await this.requireClient().send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) return null;
      return Buffer.from(await body.transformToByteArray());
    } catch (err: unknown) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.requireClient().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err: unknown) {
      if (this.isNotFound(err)) return false;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.requireClient().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err: unknown) {
      if (!this.isNotFound(err)) throw err;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    return this.deletePrefixIn(this.requireClient(), this.bucket, prefix);
  }

  // ============================================================
  // KYC-only surface (SECURITY.md H2)
  //
  // These are deliberately SEPARATE methods rather than a `scope` parameter with
  // a default value: a defaulted scope argument is exactly how an identity
  // document ends up in the public reports bucket. Everything KYC must name
  // itself at the call site.
  // ============================================================

  /** True when a KYC client exists at all (dedicated OR the dev fallback). */
  isKycConfigured(): boolean {
    return this.kycClient !== undefined;
  }

  /** True only when the dedicated private KYC bucket + scoped token are wired. */
  isKycDedicated(): boolean {
    return this.kycDedicated;
  }

  /** The bucket KYC objects are written to right now. */
  get kycBucketName(): string {
    return this.kycBucket;
  }

  private requireKycClient(): S3Client {
    if (!this.kycClient) {
      throw new Error('R2 KYC client not configured');
    }
    return this.kycClient;
  }

  /**
   * Resolve the (client, bucket) pair for an EXISTING KYC object from the bucket
   * name recorded on its `KycDocument` row. NULL means the row predates the
   * dedicated bucket and still lives in the shared reports bucket — those rows
   * must keep resolving for the whole migration window.
   */
  private resolveKycLocation(storedBucket?: string | null): { client: S3Client; bucket: string } {
    if (!storedBucket) {
      return { client: this.requireClient(), bucket: this.bucket };
    }
    if (storedBucket === this.kycBucket) {
      return { client: this.requireKycClient(), bucket: this.kycBucket };
    }
    // A bucket name we don't recognise (e.g. mid-rename). The main token is the
    // only one that could plausibly reach it; the KYC token is scoped narrowly.
    return { client: this.requireClient(), bucket: storedBucket };
  }

  /** `HeadBucket` against the KYC bucket — used by the boot-time self-check. */
  async kycHeadBucket(): Promise<void> {
    await this.requireKycClient().send(new HeadBucketCommand({ Bucket: this.kycBucket }));
  }

  /**
   * Write a KYC document straight into the KYC bucket.
   *
   * This exists because `putObject` hardcodes the REPORTS bucket, so using it
   * for an identity document would silently reproduce the exact defect the
   * dedicated bucket was created to fix — and the call site would look correct.
   * Returns what belongs in `KycDocument.bucket`: null for the legacy shared
   * bucket, the bucket name once the dedicated one is live.
   */
  async kycPutObject(
    key: string,
    body: Uint8Array | Buffer,
    contentType: string,
  ): Promise<string | null> {
    await this.requireKycClient().send(
      new PutObjectCommand({
        Bucket: this.kycBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return this.kycDedicated ? this.kycBucket : null;
  }

  /**
   * Presign an upload for a KYC document into the KYC bucket.
   *
   * ⚠ THIS HAS NO CALLER, AND THAT IS THE POINT — DO NOT DELETE IT AS DEAD CODE,
   * AND DO NOT WIRE IT BACK UP TO A BROWSER.
   *
   * It is kept as a PRIMITIVE, symmetrical with `kycSignedDownloadUrl`, for a
   * server-to-server hand-off that does not exist yet (an external verification
   * provider pushing a document, a migration job). The one caller it used to
   * have was the inspector KYC wizard, which was handed the URL and PUT the file
   * from the browser: the KYC bucket has no CORS rules, so that request never
   * left the browser and no inspector could ever be verified.
   *
   * Adding CORS to the bucket is NOT the fix and must never be the fix — it
   * leaves a browser-reachable write path into the identity-document store
   * permanently open. Uploads go through
   * `POST /api/v1/kyc/applications/:id/documents/upload`, which keeps the
   * credentials server-side and validates the bytes.
   */
  async kycPresignedUploadUrl(
    key: string,
    contentType = 'application/octet-stream',
  ): Promise<{ url: string; expiresAt: Date; bucket: string | null }> {
    const cmd = new PutObjectCommand({
      Bucket: this.kycBucket,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(this.requireKycClient(), cmd, { expiresIn: this.uploadTtl });
    return {
      url,
      expiresAt: new Date(Date.now() + this.uploadTtl * 1000),
      // NULL records "the legacy shared bucket", matching KycDocument.bucket.
      bucket: this.kycDedicated ? this.kycBucket : null,
    };
  }

  /**
   * Mint a short-lived SIGNED view URL for a KYC document.
   *
   * This method must NEVER consult `R2_PUBLIC_URL`. `createPresignedDownloadUrl`
   * short-circuits to that public base when it is set, which is correct for
   * report PDFs and catastrophic for identity documents — the day an operator
   * sets the var, every KYC document would become publicly readable. Pinned by
   * `test/kyc.e2e-spec.ts`.
   */
  async kycSignedDownloadUrl(
    key: string,
    storedBucket?: string | null,
    ttlSeconds?: number,
  ): Promise<{ url: string; expiresAt: Date }> {
    const expiresIn = ttlSeconds ?? this.signedUrlTtl;
    const { client, bucket } = this.resolveKycLocation(storedBucket);
    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn,
    });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  /** Delete one KYC object from whichever bucket its row says it lives in. */
  async kycDeleteObject(key: string, storedBucket?: string | null): Promise<void> {
    const { client, bucket } = this.resolveKycLocation(storedBucket);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err: unknown) {
      if (!this.isNotFound(err)) throw err;
    }
  }

  /**
   * Delete every KYC object under a prefix. During the migration window objects
   * for one user may exist in BOTH buckets, so an erasure sweeps both — leaving
   * a copy behind in the old bucket would defeat the point of the erasure.
   * Returns the total number of objects deleted.
   */
  async kycDeletePrefix(prefix: string): Promise<number> {
    let deleted = await this.deletePrefixIn(this.requireKycClient(), this.kycBucket, prefix);
    if (this.kycDedicated && this.client) {
      deleted += await this.deletePrefixIn(this.client, this.bucket, prefix);
    }
    return deleted;
  }

  // ============================================================
  // Public-bucket surface (permanent showroom image URLs)
  //
  // Separate methods for the same reason the KYC ones are separate: a bucket
  // argument with a default is how a private object ends up published.
  // ============================================================

  /** True when all four `R2_PUBLIC_*` vars are set and the bucket is distinct. */
  isPublicBucketConfigured(): boolean {
    return this.publicClient !== undefined;
  }

  get publicBucketName(): string {
    return this.publicBucket;
  }

  /** The permanent, CDN-cacheable URL of an object in the public bucket. */
  publicObjectUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  /** `HeadBucket` against the public bucket — used by the boot-time self-check. */
  async publicHeadBucket(): Promise<void> {
    await this.requirePublicClient().send(new HeadBucketCommand({ Bucket: this.publicBucket }));
  }

  /**
   * Write an object to the public bucket. Returns the bucket name, which is what
   * `ListingPhoto.bucket` stores.
   *
   * `Cache-Control: immutable` for a year is safe because keys are derived from
   * a UUID (seller uploads) or from a SHA-256 of the source key (mirrored report
   * photos): the bytes behind a given key never change. A replaced photo is a
   * new key and a new row.
   */
  async publicPutObject(
    key: string,
    body: Uint8Array | Buffer,
    contentType = 'image/jpeg',
  ): Promise<string> {
    await this.requirePublicClient().send(
      new PutObjectCommand({
        Bucket: this.publicBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return this.publicBucket;
  }

  async publicDeleteObject(key: string): Promise<void> {
    try {
      await this.requirePublicClient().send(
        new DeleteObjectCommand({ Bucket: this.publicBucket, Key: key }),
      );
    } catch (err: unknown) {
      if (!this.isNotFound(err)) throw err;
    }
  }

  private requirePublicClient(): S3Client {
    if (!this.publicClient) {
      throw new Error('R2 public bucket not configured');
    }
    return this.publicClient;
  }

  // ============================================================

  private async deletePrefixIn(
    client: S3Client,
    bucket: string,
    prefix: string,
  ): Promise<number> {
    let totalDeleted = 0;
    let continuationToken: string | undefined;
    do {
      const list = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (list.Contents ?? []).filter((o) => o.Key).map((o) => ({ Key: o.Key! }));
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        totalDeleted += objects.length;
      }
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);
    return totalDeleted;
  }

  buildKey(tier: 'free' | 'pro', deviceId: string, reportId: string): string {
    return `${tier}/${deviceId}/${reportId}.pdf`;
  }

  get bucketName(): string {
    return this.bucket;
  }

  get accountIdForDocs(): string {
    return this.accountId;
  }

  private isNotFound(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
  }
}
