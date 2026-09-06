import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Repository } from 'typeorm';
import { ProcessVideoJobPayload, QUEUE_NAMES } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';

interface ProcessingResult {
  durationSeconds: number;
  thumbnailKey: string;
}

const THUMBNAIL_FILENAME = 'thumbnail.png';

@Processor(QUEUE_NAMES.VIDEO_PROCESSING)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobPayload>): Promise<void> {
    const { videoId } = job.data;

    try {
      const video = await this.videoRepository.findOneByOrFail({
        id: videoId,
      });

      const { durationSeconds, thumbnailKey } =
        await this.extractMetadataAndThumbnail(video);

      await this.videoRepository.update(video.id, {
        status: VideoStatus.READY,
        duration_seconds: durationSeconds,
        thumbnail_key: thumbnailKey,
      });
    } catch (error) {
      this.logger.error(
        `Failed to process video ${videoId}: ${(error as Error).message}`,
      );
      // A no-op (0 rows affected) if videoId doesn't exist — safe either way.
      await this.videoRepository.update(videoId, {
        status: VideoStatus.FAILED,
      });
    }
  }

  private async extractMetadataAndThumbnail(
    video: Video,
  ): Promise<ProcessingResult> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-'));
    const sourcePath = path.join(tempDir, 'source');

    try {
      await this.storageService.downloadObjectToFile(
        video.object_key as string,
        sourcePath,
      );

      const metadata = await this.probe(sourcePath);
      const durationSeconds = Math.round(metadata.format?.duration ?? 0);

      await this.generateThumbnail(sourcePath, tempDir);

      const thumbnailKey = `videos/${video.id}/${THUMBNAIL_FILENAME}`;
      const thumbnailBuffer = await fs.readFile(
        path.join(tempDir, THUMBNAIL_FILENAME),
      );
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        'image/png',
      );

      return { durationSeconds, thumbnailKey };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private probe(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(data);
      });
    });
  }

  private generateThumbnail(filePath: string, folder: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          timestamps: ['10%'],
          filename: THUMBNAIL_FILENAME,
          folder,
          size: '640x360',
        });
    });
  }
}
