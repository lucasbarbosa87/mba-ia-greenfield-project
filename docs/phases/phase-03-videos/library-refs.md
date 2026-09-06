---
libs:
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-05T09:30:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-05T09:30:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.0 || ^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-05T09:30:00-03:00"
  "bullmq":
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-05T09:30:00-03:00"
  "fluent-ffmpeg":
    version: "^2.1.x"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-09-05T09:30:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-05T09:23:10-03:00"
---

# Library Reference — phase-03-videos

Distilled Context7 excerpts for the libraries decided in this scope (TD-01, TD-02, TD-03, TD-05, TD-06). Scoped to the surfaces the TDs actually use — see each TD in `technical-decisions-phase-03-videos.md` for the decision rationale.

### @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

Used by: TD-01 (storage client, pointed at MinIO), TD-02 (presigned GET for playback/download), TD-06 (presigned multipart upload).

**Client setup (MinIO target, per TD-01):**
```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: 'us-east-1', // required by the SDK even for MinIO; value is arbitrary
  endpoint: 'http://minio:9000', // Docker Compose service name, per project convention
  forcePathStyle: true, // required for MinIO / path-style S3-compatible endpoints
  credentials: { accessKeyId: ..., secretAccessKey: ... },
});
```
Swapping to real AWS S3 later only requires dropping `endpoint`/`forcePathStyle` and using AWS credentials — no code branch.

**Presigned GET (per TD-02):**
```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
// expiresIn defaults to 900s if omitted
```

**Presigned multipart upload (per TD-06):**
```typescript
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));
const partUrl = await getSignedUrl(s3, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });
// browser PUTs the part bytes directly to partUrl; API collects {PartNumber, ETag} from each PUT response
await s3.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts } }));
```
CORS must be configured on the MinIO bucket for browser-direct `PUT`s (`AllowedMethods: PUT`, `ExposeHeaders: ETag`).

### @nestjs/bullmq + bullmq

Used by: TD-03 (queue technology), TD-04 (consumed by the Video Worker's second entry point).

**⚠️ Gotcha caught via Context7 — do not copy the `nestjs-best-practices` skill's queue example verbatim.** That example (`micro-use-queues.md`) uses the **legacy `@nestjs/bull`** decorator pattern (`@Process()` method decorator, `import { Job } from 'bull'`). The package this project decided, **`@nestjs/bullmq`**, uses a **different, class-based pattern**:

```typescript
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    BullModule.forRoot({ connection: { host: 'redis', port: 6379 } }), // 'redis' = Compose service name
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
})
export class QueueModule {}
```

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class VideoService {
  constructor(@InjectQueue('video-processing') private queue: Queue) {}
  async enqueue(videoId: string) {
    await this.queue.add('process', { videoId });
  }
}
```

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq'; // NOT 'bull'

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>) {
    // ffmpeg processing here (TD-05)
  }
}
```

The class **must** `extends WorkerHost` and implement `process()` — a bare `@Processor` class without it throws `InvalidProcessorClassError`.

**Redis connection gotcha (bullmq):** a `Worker`'s Redis connection **must** set `maxRetriesPerRequest: null` (via `ioredis`) to enable indefinite retry across disconnects — omitting it is a common source of dropped jobs on Redis restarts.

### fluent-ffmpeg

Used by: TD-05 (metadata extraction + thumbnail generation).

```typescript
import ffmpeg from 'fluent-ffmpeg';

// Metadata (duration, streams) — TD's "extração de duração e metadados" capability
ffmpeg.ffprobe(filePath, (err, metadata) => {
  const durationSeconds = metadata.format.duration;
});

// Thumbnail — TD's "geração automática de thumbnail" capability
ffmpeg(filePath)
  .screenshots({
    timestamps: ['10%'], // frame from the video, per capability wording
    filename: 'thumbnail.png',
    folder: outputDir,
    size: '640x360',
  })
  .on('end', () => { /* thumbnail written */ });
```
Requires the `ffmpeg` binary on `PATH` — installed via `apt install ffmpeg` in `Dockerfile.dev` per TD-05's decision (not the `ffmpeg-static` npm package).
