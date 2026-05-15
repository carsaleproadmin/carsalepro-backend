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
  private publicUrl?: string;

  constructor(@Inject(ConfigService) private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit(): void {
    const r2 = this.config.get('r2', { infer: true });
    const quota = this.config.get('quota', { infer: true });
    this.bucket = r2.bucket;
    this.accountId = r2.accountId;
    this.publicUrl = r2.publicUrl;
    this.uploadTtl = quota.presignedUploadTtl;
    this.downloadTtl = quota.presignedDownloadTtl;

    if (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey) {
      this.logger.warn(
        'R2 credentials not configured — uploads/downloads will fail until env vars are set',
      );
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
    let totalDeleted = 0;
    let continuationToken: string | undefined;
    const client = this.requireClient();
    do {
      const list = await client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (list.Contents ?? []).filter((o) => o.Key).map((o) => ({ Key: o.Key! }));
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
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
