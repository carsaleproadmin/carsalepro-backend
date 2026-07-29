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

@Injectable()
export class R2Service implements OnModuleInit {
  private readonly logger = new Logger(R2Service.name);
  private client?: S3Client;
  private bucket!: string;
  private accountId!: string;
  private uploadTtl!: number;
  private downloadTtl!: number;
  private signedUrlTtl!: number;
  private publicUrl?: string;

  /**
   * Second client, authenticated with the narrowly-scoped `R2_KYC_*` token, for
   * the dedicated private KYC bucket (SECURITY.md H2). When those credentials
   * are absent it aliases the main client/bucket so local dev and CI keep
   * working — `kycDedicated` records which of the two is live.
   */
  private kycClient?: S3Client;
  private kycBucket!: string;
  private kycDedicated = false;

  constructor(@Inject(ConfigService) private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit(): void {
    const r2 = this.config.get('r2', { infer: true });
    const quota = this.config.get('quota', { infer: true });
    this.bucket = r2.bucket;
    this.accountId = r2.accountId;
    this.publicUrl = r2.publicUrl;
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
  }

  /**
   * Wire the dedicated KYC client, or fall back to the main one.
   *
   * The fallback is a DEV convenience only — `env.validation.ts` requires all
   * three `R2_KYC_*` vars when NODE_ENV=production, so a real deployment can
   * never quietly store identity documents next to public report PDFs.
   */
  private initKycClient(): void {
    const kyc = this.config.get('r2Kyc', { infer: true });
    const r2 = this.config.get('r2', { infer: true });

    if (!kyc.accessKeyId || !kyc.secretAccessKey || !kyc.bucket) {
      this.kycClient = this.client;
      this.kycBucket = this.bucket;
      this.kycDedicated = false;
      this.logger.warn(
        'R2_KYC_* not fully configured — KYC documents fall back to the shared reports ' +
          `bucket (${this.bucket}). Acceptable for dev/CI only; production boot requires them.`,
      );
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

  async createPresignedDownloadUrl(key: string): Promise<{ url: string; expiresAt: Date }> {
    if (this.publicUrl) {
      return {
        url: `${this.publicUrl.replace(/\/$/, '')}/${key}`,
        expiresAt: new Date(Date.now() + this.downloadTtl * 1000),
      };
    }
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
  ): Promise<{ url: string; expiresAt: Date }> {
    const expiresIn = ttlSeconds ?? this.signedUrlTtl;
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.requireClient(), cmd, { expiresIn });
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    return { url, expiresAt };
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

  /** Presign an upload for a KYC document into the KYC bucket. */
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
