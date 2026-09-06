import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { ProcessVideoJobPayload, QUEUE_NAMES } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videosService: VideosService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let videoProcessingQueue: Queue<ProcessVideoJobPayload>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    storageService = new StorageService(storageConfig());
    await storageService.onModuleInit();

    const { host, port } = queueConfig();
    videoProcessingQueue = new Queue<ProcessVideoJobPayload>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      { connection: { host, port } },
    );
    await videoProcessingQueue.drain(true);

    videosService = new VideosService(
      videoRepository,
      channelRepository,
      storageService,
      videoProcessingQueue,
    );
  });

  afterAll(async () => {
    await videoProcessingQueue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await videoProcessingQueue.drain(true);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vch_${counter}`,
        user_id: user.id,
      }),
    );
  }

  describe('createDraft', () => {
    it('persists a Video with status uploading and a populated uploadId', async () => {
      const channel = await createChannel();
      const dto: CreateVideoDto = {
        filename: 'movie.mp4',
        contentType: 'video/mp4',
        sizeBytes: 5 * 1024 * 1024,
        partCount: 1,
      };

      const result = await videosService.createDraft(channel.user_id, dto);

      expect(result.status).toBe(VideoStatus.UPLOADING);
      expect(result.uploadId).toBeTruthy();
      expect(result.partUrls).toHaveLength(1);
      expect(result.partUrls[0].partNumber).toBe(1);

      const persisted = await videoRepository.findOneByOrFail({
        id: result.id,
      });
      expect(persisted.status).toBe(VideoStatus.UPLOADING);
      expect(persisted.upload_id).toBe(result.uploadId);
      expect(persisted.channel_id).toBe(channel.id);
      expect(persisted.object_key).toContain(dto.filename);
    });

    it('strips directory components from the filename before building the object key', async () => {
      const channel = await createChannel();
      const dto: CreateVideoDto = {
        filename: '../other-channel/movie.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024,
        partCount: 1,
      };

      const result = await videosService.createDraft(channel.user_id, dto);

      const persisted = await videoRepository.findOneByOrFail({
        id: result.id,
      });
      expect(persisted.object_key).toBe(`videos/${result.id}/movie.mp4`);
    });

    it('deletes the draft row if creating the multipart upload fails (compensation)', async () => {
      const channel = await createChannel();
      jest
        .spyOn(storageService, 'createMultipartUpload')
        .mockRejectedValueOnce(new Error('simulated storage outage'));

      await expect(
        videosService.createDraft(channel.user_id, {
          filename: 'movie.mp4',
          contentType: 'video/mp4',
          sizeBytes: 1024,
          partCount: 1,
        }),
      ).rejects.toThrow('simulated storage outage');

      const remaining = await videoRepository.find({
        where: { channel_id: channel.id },
      });
      expect(remaining).toHaveLength(0);
    });
  });

  describe('getUploadParts', () => {
    it('resumes a partial upload without re-issuing URLs for parts already received', async () => {
      const channel = await createChannel();
      const draft = await videosService.createDraft(channel.user_id, {
        filename: 'movie.mp4',
        contentType: 'video/mp4',
        sizeBytes: 15 * 1024 * 1024,
        partCount: 3,
      });

      // Upload part 1 directly to storage, as the client would.
      const partOneBody = Buffer.alloc(5 * 1024 * 1024, 'a');
      const partOneUrl = draft.partUrls.find((p) => p.partNumber === 1)!.url;
      const putResponse = await fetch(partOneUrl, {
        method: 'PUT',
        body: partOneBody,
      });
      expect(putResponse.ok).toBe(true);

      const result = await videosService.getUploadParts(
        channel.user_id,
        draft.id,
      );

      expect(result.uploadedParts).toHaveLength(1);
      expect(result.uploadedParts[0].partNumber).toBe(1);
      expect(result.pendingPartUrls.map((p) => p.partNumber).sort()).toEqual([
        2, 3,
      ]);
    });
  });

  describe('completeUpload', () => {
    async function createAndUploadAllParts(): Promise<{
      channel: Channel;
      videoId: string;
      parts: CompleteUploadDto['parts'];
    }> {
      const channel = await createChannel();
      const draft = await videosService.createDraft(channel.user_id, {
        filename: 'movie.mp4',
        contentType: 'video/mp4',
        sizeBytes: 5 * 1024 * 1024,
        partCount: 1,
      });

      const partUrl = draft.partUrls[0].url;
      const putResponse = await fetch(partUrl, {
        method: 'PUT',
        body: Buffer.alloc(5 * 1024 * 1024, 'a'),
      });
      const eTag = putResponse.headers.get('etag') as string;

      return {
        channel,
        videoId: draft.id,
        parts: [{ partNumber: 1, eTag }],
      };
    }

    it('marks the video as processing and enqueues exactly one video.process job', async () => {
      const { channel, videoId, parts } = await createAndUploadAllParts();

      const result = await videosService.completeUpload(
        channel.user_id,
        videoId,
        { parts },
      );

      expect(result.status).toBe(VideoStatus.PROCESSING);

      const persisted = await videoRepository.findOneByOrFail({
        id: videoId,
      });
      expect(persisted.status).toBe(VideoStatus.PROCESSING);

      const waitingJobs = await videoProcessingQueue.getJobs(['waiting']);
      expect(waitingJobs).toHaveLength(1);
      expect(waitingJobs[0].data).toEqual({ videoId });
    });

    it('rejects when submitted parts do not match what storage recorded', async () => {
      const { channel, videoId } = await createAndUploadAllParts();

      await expect(
        videosService.completeUpload(channel.user_id, videoId, {
          parts: [{ partNumber: 1, eTag: 'wrong-etag' }],
        }),
      ).rejects.toThrow('do not match');

      const waitingJobs = await videoProcessingQueue.getJobs(['waiting']);
      expect(waitingJobs).toHaveLength(0);
    });
  });
});
