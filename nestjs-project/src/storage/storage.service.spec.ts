import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService', () => {
  let service: StorageService;

  beforeAll(async () => {
    process.env.STORAGE_ENDPOINT = 'http://minio:9000';
    process.env.STORAGE_REGION = 'us-east-1';
    process.env.STORAGE_BUCKET = 'streamtube-unit-test';
    process.env.STORAGE_ACCESS_KEY = 'test';
    process.env.STORAGE_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    service = moduleRef.get(StorageService);
  });

  describe('getPresignedDownloadUrl', () => {
    it('should generate a URL without a content-disposition override when attachment is false (default)', async () => {
      const url = await service.getPresignedDownloadUrl('videos/some-key.mp4');

      expect(url).not.toContain('response-content-disposition');
    });

    it('should generate a URL with attachment content-disposition when attachment is true', async () => {
      const url = await service.getPresignedDownloadUrl('videos/some-key.mp4', {
        attachment: true,
      });

      expect(url).toContain('response-content-disposition=attachment');
    });
  });
});
