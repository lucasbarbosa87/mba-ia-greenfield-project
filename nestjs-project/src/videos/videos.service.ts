import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  FileTooLargeException,
  IncompleteUploadException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import {
  JOB_NAMES,
  ProcessVideoJobPayload,
  QUEUE_NAMES,
} from '../queue/queue.constants';
import {
  DEFAULT_EXPIRES_IN_SECONDS,
  StorageService,
  UploadedPart,
} from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_LIMITS } from './videos.constants';

export interface CreateDraftResult {
  id: string;
  status: VideoStatus;
  uploadId: string;
  partUrls: { partNumber: number; url: string }[];
}

export interface UploadPartsResult {
  uploadedParts: UploadedPart[];
  pendingPartUrls: { partNumber: number; url: string }[];
}

export interface CompleteUploadResult {
  id: string;
  status: VideoStatus;
}

export interface PresignedUrlResult {
  url: string;
  expiresIn: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    @InjectQueue(QUEUE_NAMES.VIDEO_PROCESSING)
    private readonly videoProcessingQueue: Queue<ProcessVideoJobPayload>,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    if (dto.sizeBytes > VIDEO_LIMITS.MAX_SIZE_BYTES) {
      throw new FileTooLargeException();
    }

    const channel = await this.channelRepository.findOneByOrFail({
      user_id: userId,
    });

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
      }),
    );

    const objectKey = `videos/${video.id}/${dto.filename}`;
    const uploadId = await this.storageService.createMultipartUpload(
      objectKey,
      dto.contentType,
    );

    const partUrls = await Promise.all(
      Array.from({ length: dto.partCount }, (_, index) => index + 1).map(
        async (partNumber) => ({
          partNumber,
          url: await this.storageService.getPresignedUploadPartUrl(
            objectKey,
            uploadId,
            partNumber,
          ),
        }),
      ),
    );

    await this.videoRepository.update(video.id, {
      object_key: objectKey,
      upload_id: uploadId,
      part_count: dto.partCount,
      status: VideoStatus.UPLOADING,
    });

    return {
      id: video.id,
      status: VideoStatus.UPLOADING,
      uploadId,
      partUrls,
    };
  }

  async getUploadParts(
    userId: string,
    videoId: string,
  ): Promise<UploadPartsResult> {
    const video = await this.findOwnedVideoOrFail(userId, videoId);

    if (video.status !== VideoStatus.UPLOADING) {
      throw new UploadAlreadyCompletedException();
    }

    const uploadedParts = await this.storageService.listParts(
      video.object_key as string,
      video.upload_id as string,
    );

    const uploadedPartNumbers = new Set(
      uploadedParts.map((part) => part.partNumber),
    );
    const totalParts = video.part_count ?? 0;
    const missingPartNumbers = Array.from(
      { length: totalParts },
      (_, index) => index + 1,
    ).filter((partNumber) => !uploadedPartNumbers.has(partNumber));

    const pendingPartUrls = await Promise.all(
      missingPartNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.getPresignedUploadPartUrl(
          video.object_key as string,
          video.upload_id as string,
          partNumber,
        ),
      })),
    );

    return { uploadedParts, pendingPartUrls };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.findOwnedVideoOrFail(userId, videoId);

    if (video.status !== VideoStatus.UPLOADING) {
      throw new UploadAlreadyCompletedException();
    }

    const actualParts = await this.storageService.listParts(
      video.object_key as string,
      video.upload_id as string,
    );
    const actualByPartNumber = new Map(
      actualParts.map((part) => [part.partNumber, part.eTag]),
    );

    const isComplete =
      dto.parts.length === (video.part_count ?? 0) &&
      dto.parts.every(
        (part) => actualByPartNumber.get(part.partNumber) === part.eTag,
      );

    if (!isComplete) {
      throw new IncompleteUploadException();
    }

    await this.storageService.completeMultipartUpload(
      video.object_key as string,
      video.upload_id as string,
      dto.parts,
    );

    await this.videoRepository.update(video.id, {
      status: VideoStatus.PROCESSING,
    });

    await this.videoProcessingQueue.add(JOB_NAMES.PROCESS_VIDEO, {
      videoId: video.id,
    });

    return { id: video.id, status: VideoStatus.PROCESSING };
  }

  async getPlaybackUrl(videoId: string): Promise<PresignedUrlResult> {
    const video = await this.findVideoOrFail(videoId);

    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const url = await this.storageService.getPresignedDownloadUrl(
      video.object_key as string,
    );

    return { url, expiresIn: DEFAULT_EXPIRES_IN_SECONDS };
  }

  async getDownloadUrl(videoId: string): Promise<PresignedUrlResult> {
    const video = await this.findVideoOrFail(videoId);

    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const url = await this.storageService.getPresignedDownloadUrl(
      video.object_key as string,
      { attachment: true },
    );

    return { url, expiresIn: DEFAULT_EXPIRES_IN_SECONDS };
  }

  /** Resolves a video by id regardless of ownership (playback/download are public). */
  private async findVideoOrFail(videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  /** Resolves a video owned by the caller's channel, or throws VideoNotFoundException. */
  private async findOwnedVideoOrFail(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const channel = await this.channelRepository.findOneByOrFail({
      user_id: userId,
    });

    const video = await this.videoRepository.findOne({
      where: { id: videoId, channel_id: channel.id },
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }
}
