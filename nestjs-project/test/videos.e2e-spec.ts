import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { QUEUE_NAMES } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string;
}

interface PartUrl {
  partNumber: number;
  url: string;
}

interface CreateVideoResponseBody {
  id: string;
  status: string;
  uploadId: string;
  partUrls: PartUrl[];
}

interface UploadedPart {
  partNumber: number;
  eTag: string;
}

interface UploadPartsResponseBody {
  uploadedParts: UploadedPart[];
  pendingPartUrls: PartUrl[];
}

interface PresignedUrlResponseBody {
  url: string;
  expiresIn: number;
}

interface LoginResponseBody {
  access_token: string;
}

describe('videos', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let videoProcessingQueue: Queue;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    videoProcessingQueue = moduleFixture.get<Queue>(
      getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await videoProcessingQueue.drain(true);
  });

  let userCounter = 0;

  /** Registers, confirms, and logs in a fresh user — phase-02 auto-creates the channel. */
  async function createAuthenticatedUser(): Promise<{ accessToken: string }> {
    const email = `video_e2e_${++userCounter}@example.com`;
    const password = 'password123';

    const mailService = app.get(MailService);
    let capturedToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_email, _name, token) => {
        capturedToken = token;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return { accessToken: (loginRes.body as LoginResponseBody).access_token };
  }

  describe('POST /videos', () => {
    it('creates-draft-and-returns-presigned-part-urls', async () => {
      const { accessToken } = await createAuthenticatedUser();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'movie.mp4',
          contentType: 'video/mp4',
          sizeBytes: 5 * 1024 * 1024,
          partCount: 2,
        });

      expect(res.status).toBe(201);
      const body = res.body as CreateVideoResponseBody;
      expect(typeof body.id).toBe('string');
      expect(body.status).toBe('uploading');
      expect(typeof body.uploadId).toBe('string');
      expect(body.partUrls).toHaveLength(2);
      expect(body.partUrls[0].partNumber).toBe(1);
      expect(typeof body.partUrls[0].url).toBe('string');
    });

    it('rejects-file-too-large', async () => {
      const { accessToken } = await createAuthenticatedUser();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'movie.mp4',
          contentType: 'video/mp4',
          sizeBytes: 10 * 1024 * 1024 * 1024 + 1,
          partCount: 1,
        });

      expect(res.status).toBe(400);
      expect((res.body as ErrorResponseBody).error).toBe('FILE_TOO_LARGE');
    });

    it('rejects-unauthenticated-request', async () => {
      const res = await request(app.getHttpServer()).post('/videos').send({
        filename: 'movie.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024,
        partCount: 1,
      });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /videos/:id/upload-parts', () => {
    it('returns-uploaded-and-pending-parts', async () => {
      const { accessToken } = await createAuthenticatedUser();

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'movie.mp4',
          contentType: 'video/mp4',
          sizeBytes: 15 * 1024 * 1024,
          partCount: 3,
        });
      const createBody = createRes.body as CreateVideoResponseBody;

      const partOneUrl = createBody.partUrls.find(
        (p) => p.partNumber === 1,
      )!.url;
      const putRes = await fetch(partOneUrl, {
        method: 'PUT',
        body: Buffer.alloc(5 * 1024 * 1024, 'a'),
      });
      expect(putRes.ok).toBe(true);

      const res = await request(app.getHttpServer())
        .get(`/videos/${createBody.id}/upload-parts`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      const body = res.body as UploadPartsResponseBody;
      expect(body.uploadedParts).toHaveLength(1);
      expect(body.uploadedParts[0].partNumber).toBe(1);
      expect(typeof body.uploadedParts[0].eTag).toBe('string');
      expect(body.pendingPartUrls.map((p) => p.partNumber)).toEqual([2, 3]);
    });

    it('rejects-video-from-another-channel', async () => {
      const owner = await createAuthenticatedUser();
      const stranger = await createAuthenticatedUser();

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          filename: 'movie.mp4',
          contentType: 'video/mp4',
          sizeBytes: 1024,
          partCount: 1,
        });
      const createBody = createRes.body as CreateVideoResponseBody;

      const res = await request(app.getHttpServer())
        .get(`/videos/${createBody.id}/upload-parts`)
        .set('Authorization', `Bearer ${stranger.accessToken}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('rejects-when-upload-already-completed', async () => {
      const { accessToken } = await createAuthenticatedUser();

      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'movie.mp4',
          contentType: 'video/mp4',
          sizeBytes: 1024,
          partCount: 1,
        });
      const createBody = createRes.body as CreateVideoResponseBody;

      // No complete-upload endpoint exists yet (SI-03.7) — flip status directly
      // to exercise the guard.
      await dataSource.query(
        `UPDATE "videos" SET "status" = 'ready' WHERE "id" = $1`,
        [createBody.id],
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${createBody.id}/upload-parts`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(409);
      expect((res.body as ErrorResponseBody).error).toBe(
        'UPLOAD_ALREADY_COMPLETED',
      );
    });
  });

  describe('POST /videos/:id/complete-upload', () => {
    async function createDraftAndUploadPart(
      accessToken: string,
    ): Promise<{ videoId: string; eTag: string }> {
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'movie.mp4',
          contentType: 'video/mp4',
          sizeBytes: 5 * 1024 * 1024,
          partCount: 1,
        });
      const createBody = createRes.body as CreateVideoResponseBody;

      const partUrl = createBody.partUrls[0].url;
      const putRes = await fetch(partUrl, {
        method: 'PUT',
        body: Buffer.alloc(5 * 1024 * 1024, 'a'),
      });
      const eTag = putRes.headers.get('etag') as string;

      return { videoId: createBody.id, eTag };
    }

    it('completes-upload-and-enqueues-job', async () => {
      const { accessToken } = await createAuthenticatedUser();
      const { videoId, eTag } = await createDraftAndUploadPart(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag }] });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ id: videoId, status: 'processing' });

      const waitingJobs = await videoProcessingQueue.getJobs(['waiting']);
      expect(waitingJobs).toHaveLength(1);
      expect(waitingJobs[0].data).toEqual({ videoId });
    });

    it('rejects-incomplete-parts', async () => {
      const { accessToken } = await createAuthenticatedUser();
      const { videoId } = await createDraftAndUploadPart(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag: 'wrong-etag' }] });

      expect(res.status).toBe(400);
      expect((res.body as ErrorResponseBody).error).toBe('INCOMPLETE_UPLOAD');
    });

    it('rejects-second-completion-call', async () => {
      const { accessToken } = await createAuthenticatedUser();
      const { videoId, eTag } = await createDraftAndUploadPart(accessToken);
      const body = { parts: [{ partNumber: 1, eTag }] };

      const firstRes = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(body);
      expect(firstRes.status).toBe(202);

      const secondRes = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(body);

      expect(secondRes.status).toBe(409);
      expect((secondRes.body as ErrorResponseBody).error).toBe(
        'UPLOAD_ALREADY_COMPLETED',
      );
    });
  });

  describe('GET /videos/:id/playback-url', () => {
    async function createDraftVideo(accessToken: string): Promise<string> {
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'movie.mp4',
          contentType: 'video/mp4',
          sizeBytes: 1024,
          partCount: 1,
        });
      return (createRes.body as CreateVideoResponseBody).id;
    }

    it('returns-presigned-url-when-ready', async () => {
      const { accessToken } = await createAuthenticatedUser();
      const videoId = await createDraftVideo(accessToken);
      await dataSource.query(
        `UPDATE "videos" SET "status" = 'ready' WHERE "id" = $1`,
        [videoId],
      );

      const res = await request(app.getHttpServer()).get(
        `/videos/${videoId}/playback-url`,
      );

      expect(res.status).toBe(200);
      const body = res.body as PresignedUrlResponseBody;
      expect(typeof body.url).toBe('string');
      expect(typeof body.expiresIn).toBe('number');
    });

    it('rejects-when-video-not-ready', async () => {
      const { accessToken } = await createAuthenticatedUser();
      const videoId = await createDraftVideo(accessToken);

      const res = await request(app.getHttpServer()).get(
        `/videos/${videoId}/playback-url`,
      );

      expect(res.status).toBe(409);
      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_READY');
    });

    it('allows-anonymous-access', async () => {
      const { accessToken } = await createAuthenticatedUser();
      const videoId = await createDraftVideo(accessToken);
      await dataSource.query(
        `UPDATE "videos" SET "status" = 'ready' WHERE "id" = $1`,
        [videoId],
      );

      // No Authorization header sent — request is anonymous.
      const res = await request(app.getHttpServer()).get(
        `/videos/${videoId}/playback-url`,
      );

      expect(res.status).toBe(200);
      const body = res.body as PresignedUrlResponseBody;
      expect(typeof body.url).toBe('string');
      expect(typeof body.expiresIn).toBe('number');
    });
  });

  describe('GET /videos/:id/download-url', () => {
    async function createDraftVideo(accessToken: string): Promise<string> {
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'movie.mp4',
          contentType: 'video/mp4',
          sizeBytes: 1024,
          partCount: 1,
        });
      return (createRes.body as CreateVideoResponseBody).id;
    }

    it('returns-attachment-presigned-url-when-ready', async () => {
      const { accessToken } = await createAuthenticatedUser();
      const videoId = await createDraftVideo(accessToken);
      await dataSource.query(
        `UPDATE "videos" SET "status" = 'ready' WHERE "id" = $1`,
        [videoId],
      );

      const res = await request(app.getHttpServer()).get(
        `/videos/${videoId}/download-url`,
      );

      expect(res.status).toBe(200);
      expect((res.body as PresignedUrlResponseBody).url).toContain(
        'response-content-disposition=attachment',
      );
    });

    it('rejects-when-video-not-ready', async () => {
      const { accessToken } = await createAuthenticatedUser();
      const videoId = await createDraftVideo(accessToken);

      const res = await request(app.getHttpServer()).get(
        `/videos/${videoId}/download-url`,
      );

      expect(res.status).toBe(409);
      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_READY');
    });
  });
});
