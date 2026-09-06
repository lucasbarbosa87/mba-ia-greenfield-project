import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import { VIDEO_LIMITS } from './videos.constants';

describe('VideosService', () => {
  let service: VideosService;
  let storageService: {
    createMultipartUpload: jest.Mock;
    listParts: jest.Mock;
    getPresignedUploadPartUrl: jest.Mock;
    completeMultipartUpload: jest.Mock;
    getPresignedDownloadUrl: jest.Mock;
  };
  let channelRepository: { findOneByOrFail: jest.Mock };
  let videoRepository: { findOne: jest.Mock; update: jest.Mock };
  let videoProcessingQueue: { add: jest.Mock };

  beforeEach(async () => {
    storageService = {
      createMultipartUpload: jest.fn(),
      listParts: jest.fn(),
      getPresignedUploadPartUrl: jest.fn(),
      completeMultipartUpload: jest.fn(),
      getPresignedDownloadUrl: jest.fn(),
    };
    channelRepository = {
      findOneByOrFail: jest.fn(),
    };
    videoRepository = {
      findOne: jest.fn(),
      update: jest.fn(),
    };
    videoProcessingQueue = {
      add: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            update: videoRepository.update,
            findOne: videoRepository.findOne,
          },
        },
        { provide: getRepositoryToken(Channel), useValue: channelRepository },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING),
          useValue: videoProcessingQueue,
        },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  describe('createDraft', () => {
    it('should reject sizeBytes above the 10GB limit before touching storage', async () => {
      const dto: CreateVideoDto = {
        filename: 'movie.mp4',
        contentType: 'video/mp4',
        sizeBytes: VIDEO_LIMITS.MAX_SIZE_BYTES + 1,
        partCount: 1,
      };

      await expect(service.createDraft('user-1', dto)).rejects.toThrow(
        'exceeds the 10GB upload limit',
      );

      expect(channelRepository.findOneByOrFail).not.toHaveBeenCalled();
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('getUploadParts', () => {
    it('should compute only the missing parts from listParts', async () => {
      channelRepository.findOneByOrFail.mockResolvedValue({
        id: 'channel-1',
      });
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        channel_id: 'channel-1',
        status: VideoStatus.UPLOADING,
        object_key: 'videos/video-1/movie.mp4',
        upload_id: 'upload-1',
        part_count: 3,
      });
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, eTag: 'etag-1' },
      ]);
      storageService.getPresignedUploadPartUrl.mockImplementation(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://presigned/${partNumber}`),
      );

      const result = await service.getUploadParts('user-1', 'video-1');

      expect(result.uploadedParts).toEqual([{ partNumber: 1, eTag: 'etag-1' }]);
      expect(result.pendingPartUrls).toEqual([
        { partNumber: 2, url: 'https://presigned/2' },
        { partNumber: 3, url: 'https://presigned/3' },
      ]);
    });
  });

  describe('completeUpload', () => {
    it('should reject incomplete parts before completing the multipart upload', async () => {
      channelRepository.findOneByOrFail.mockResolvedValue({
        id: 'channel-1',
      });
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        channel_id: 'channel-1',
        status: VideoStatus.UPLOADING,
        object_key: 'videos/video-1/movie.mp4',
        upload_id: 'upload-1',
        part_count: 2,
      });
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, eTag: 'etag-1' },
      ]);
      const dto: CompleteUploadDto = {
        parts: [{ partNumber: 1, eTag: 'etag-1' }],
      };

      await expect(
        service.completeUpload('user-1', 'video-1', dto),
      ).rejects.toThrow('do not match');

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(videoProcessingQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('getPlaybackUrl', () => {
    it('should reject when status is not ready before calling storage', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        object_key: 'videos/video-1/movie.mp4',
      });

      await expect(service.getPlaybackUrl('video-1')).rejects.toThrow(
        'not ready',
      );

      expect(storageService.getPresignedDownloadUrl).not.toHaveBeenCalled();
    });
  });

  describe('getDownloadUrl', () => {
    it('should reject when status is not ready before calling storage', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        object_key: 'videos/video-1/movie.mp4',
      });

      await expect(service.getDownloadUrl('video-1')).rejects.toThrow(
        'not ready',
      );

      expect(storageService.getPresignedDownloadUrl).not.toHaveBeenCalled();
    });
  });
});
