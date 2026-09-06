import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { StorageOperationFailedException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';

export interface UploadedPart {
  partNumber: number;
  eTag: string;
}

export interface PresignedDownloadOptions {
  attachment?: boolean;
}

export const DEFAULT_EXPIRES_IN_SECONDS = 3600;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = this.config.bucket;
    this.client = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      // Only a real "bucket doesn't exist" (404) should trigger creation —
      // any other failure (network blip, credentials issue) must propagate
      // so it isn't masked by a confusing "bucket already exists"-type error
      // from CreateBucketCommand, or silently retried against a healthy bucket.
      const statusCode = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (statusCode !== 404) {
        throw error;
      }
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!result.UploadId) {
      throw new StorageOperationFailedException(
        'S3 did not return an UploadId for the multipart upload',
      );
    }

    return result.UploadId;
  }

  async getPresignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn = DEFAULT_EXPIRES_IN_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.eTag,
          })),
        },
      }),
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const result = await this.client.send(
      new ListPartsCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );

    return (result.Parts ?? []).map((part) => ({
      partNumber: part.PartNumber as number,
      eTag: part.ETag as string,
    }));
  }

  /** Uploads a small object directly (server-side) — used by the Video Worker for thumbnails. */
  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Streams an object straight to disk — used by the Video Worker to fetch the
   * source file. Never materializes the object in memory: for a file up to the
   * platform's 10GB upload limit, buffering it whole would risk exhausting the
   * worker process's memory. `pipeline` also propagates backpressure and
   * rejects on either side failing, instead of leaving a half-written file.
   */
  async downloadObjectToFile(key: string, destPath: string): Promise<void> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!result.Body) {
      throw new StorageOperationFailedException(
        `S3 returned no body for object ${key}`,
      );
    }

    await pipeline(result.Body as Readable, createWriteStream(destPath));
  }

  async getPresignedDownloadUrl(
    key: string,
    options: PresignedDownloadOptions = {},
    expiresIn = DEFAULT_EXPIRES_IN_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.attachment && {
          ResponseContentDisposition: 'attachment',
        }),
      }),
      { expiresIn },
    );
  }
}
