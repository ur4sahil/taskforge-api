import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class R2StorageService {
  private log = new Logger('R2Storage');
  private client: S3Client | null = null;
  private bucket: string;
  private publicUrl?: string;
  private keyPrefix: string;
  private ttl: number;

  constructor(private config: ConfigService) {
    this.bucket = config.get<string>('storage.r2BucketName')!;
    this.publicUrl = config.get<string>('storage.r2PublicUrl') || undefined;
    this.keyPrefix = (config.get<string>('storage.r2KeyPrefix') || '').replace(/^\/+|\/+$/g, '');
    if (this.keyPrefix) this.keyPrefix += '/';
    this.ttl = config.get<number>('storage.presignedUrlExpirySeconds') || 3600;
    const accountId = config.get<string>('storage.r2AccountId');
    const keyId = config.get<string>('storage.r2AccessKeyId');
    const secret = config.get<string>('storage.r2SecretAccessKey');
    if (accountId && keyId && secret) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: keyId, secretAccessKey: secret },
      });
    } else {
      this.log.warn('R2 credentials missing — attachment uploads will fail');
    }
  }

  isConfigured() { return !!this.client; }

  /** Prepends the optional key prefix. Lets us share a bucket with another app
   *  (e.g. flipradar-photos) by namespacing all TaskForge objects under `taskforge/`. */
  private prefixed(key: string): string {
    return this.keyPrefix + key.replace(/^\/+/, '');
  }

  async upload(key: string, body: Buffer, mimeType: string) {
    if (!this.client) throw new InternalServerErrorException('Storage not configured');
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.prefixed(key), Body: body, ContentType: mimeType }));
  }

  async getDownloadUrl(key: string, fileName: string) {
    const fullKey = this.prefixed(key);
    if (this.publicUrl) return `${this.publicUrl.replace(/\/$/, '')}/${fullKey}`;
    if (!this.client) throw new InternalServerErrorException('Storage not configured');
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
      ResponseContentDisposition: `attachment; filename="${fileName.replace(/"/g, '')}"`,
    }), { expiresIn: this.ttl });
  }

  async delete(key: string) {
    if (!this.client) return;
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.prefixed(key) }));
    } catch (err) {
      this.log.warn(`R2 delete failed for ${key}: ${(err as Error).message}`);
    }
  }
}
