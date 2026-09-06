import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    service = moduleRef.get(StorageService);
  });

  it('should complete a multipart upload and make the object retrievable via a presigned URL', async () => {
    // Part sizes below 5MB are rejected by S3-compatible multipart uploads except for the
    // last part, so use a >5MB payload for the single part in this test.
    const partBody = Buffer.alloc(5 * 1024 * 1024, 'a');
    const key = `videos/integration-test-${Date.now()}.mp4`;

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    expect(uploadId).toBeTruthy();

    const partUrl = await service.getPresignedUploadPartUrl(key, uploadId, 1);

    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: partBody,
    });
    expect(putResponse.ok).toBe(true);
    const eTag = putResponse.headers.get('etag');
    expect(eTag).toBeTruthy();

    const parts = await service.listParts(key, uploadId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partNumber).toBe(1);
    expect(parts[0].eTag).toBe(eTag);

    await service.completeMultipartUpload(key, uploadId, parts);

    const downloadUrl = await service.getPresignedDownloadUrl(key);
    const getResponse = await fetch(downloadUrl);
    expect(getResponse.ok).toBe(true);
    const retrieved = Buffer.from(await getResponse.arrayBuffer());
    expect(retrieved.length).toBe(partBody.length);
  });
});
