import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Queue, Worker } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  JOB_NAMES,
  ProcessVideoJobPayload,
  QUEUE_NAMES,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessor } from './video.processor';

const execFileAsync = promisify(execFile);

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let queue: Queue<ProcessVideoJobPayload>;
  let worker: Worker<ProcessVideoJobPayload>;
  let syntheticVideoBuffer: Buffer;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    storageService = new StorageService(storageConfig());
    await storageService.onModuleInit();

    const { host, port } = queueConfig();
    queue = new Queue<ProcessVideoJobPayload>(QUEUE_NAMES.VIDEO_PROCESSING, {
      connection: { host, port },
    });
    await queue.drain(true);

    const processor = new VideoProcessor(videoRepository, storageService);
    worker = new Worker<ProcessVideoJobPayload>(
      QUEUE_NAMES.VIDEO_PROCESSING,
      (job) => processor.process(job),
      { connection: { host, port } },
    );

    // Synthesize a tiny 1-second video with the system ffmpeg (installed in SI-03.1) —
    // avoids checking in a binary fixture.
    const fixtureDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'video-processor-fixture-'),
    );
    const fixturePath = path.join(fixtureDir, 'sample.mp4');
    await execFileAsync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64:d=1',
      '-y',
      fixturePath,
    ]);
    syntheticVideoBuffer = await fs.readFile(fixturePath);
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }, 30000);

  afterAll(async () => {
    await worker.close();
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  async function createVideo(objectKey: string): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_proc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vproc_${counter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        status: VideoStatus.PROCESSING,
        object_key: objectKey,
      }),
    );
  }

  /** Waits for the video row to leave PROCESSING, polling with a timeout. */
  async function waitForOutcome(videoId: string): Promise<Video> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const video = await videoRepository.findOneByOrFail({ id: videoId });
      if (video.status !== VideoStatus.PROCESSING) {
        return video;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for video processing to finish');
  }

  it('processes a real queued job: extracts duration and generates a thumbnail', async () => {
    const objectKey = `videos/processor-test-${counter}/source.mp4`;
    await storageService.putObject(
      objectKey,
      syntheticVideoBuffer,
      'video/mp4',
    );
    const video = await createVideo(objectKey);

    await queue.add(JOB_NAMES.PROCESS_VIDEO, { videoId: video.id });

    const result = await waitForOutcome(video.id);

    expect(result.status).toBe(VideoStatus.READY);
    expect(result.duration_seconds).toBeGreaterThan(0);
    expect(result.thumbnail_key).toBe(`videos/${video.id}/thumbnail.png`);
  }, 20000);

  it('marks the video as failed when the source file is not a valid video', async () => {
    const objectKey = `videos/processor-test-${counter}/not-a-video.txt`;
    await storageService.putObject(
      objectKey,
      Buffer.from('this is not a video'),
      'text/plain',
    );
    const video = await createVideo(objectKey);

    await queue.add(JOB_NAMES.PROCESS_VIDEO, { videoId: video.id });

    const result = await waitForOutcome(video.id);

    expect(result.status).toBe(VideoStatus.FAILED);
  }, 20000);
});
