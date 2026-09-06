import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  CompleteUploadResult,
  CreateDraftResult,
  PresignedUrlResult,
  UploadPartsResult,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft and start a multipart upload',
    description:
      "Creates a video draft owned by the caller's channel and initiates a direct-to-storage multipart upload, returning one presigned URL per part.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'uploading' },
        uploadId: { type: 'string' },
        partUrls: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or sizeBytes above the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Get(':id/upload-parts')
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'List uploaded parts and pending presigned URLs',
    description:
      'Resume support: returns parts already received by storage plus fresh presigned URLs only for the parts still missing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Uploaded and pending parts',
    schema: {
      properties: {
        uploadedParts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'number' },
              eTag: { type: 'string' },
            },
          },
        },
        pendingPartUrls: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video does not exist or does not belong to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already left the uploading state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<UploadPartsResult> {
    return this.videosService.getUploadParts(user.sub, id);
  }

  @Post(':id/complete-upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Complete the multipart upload and enqueue processing',
    description:
      'Finalizes the multipart upload against storage and enqueues the video.process job the Video Worker consumes.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed, processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or parts do not match storage',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video does not exist or does not belong to the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already left the uploading state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Public()
  @Get(':id/playback-url')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Get a presigned streaming URL',
    description:
      'Anonymous-accessible: mints a short-lived presigned URL consumed by the video player.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned playback URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresIn: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video does not exist',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPlaybackUrl(@Param('id') id: string): Promise<PresignedUrlResult> {
    return this.videosService.getPlaybackUrl(id);
  }

  @Public()
  @Get(':id/download-url')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Get a presigned download URL',
    description:
      'Anonymous-accessible: same mechanism as playback, with Content-Disposition: attachment so the browser downloads instead of streaming inline.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresIn: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video does not exist',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(@Param('id') id: string): Promise<PresignedUrlResult> {
    return this.videosService.getDownloadUrl(id);
  }
}
