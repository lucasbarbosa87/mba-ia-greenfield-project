---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-05T09:24:48-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-05T09:26:23-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-05T09:23:10-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-05T08:26:08-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver a background-processed video pipeline: armazenamento de arquivos (vídeos e thumbnails), processamento em segundo plano (filas), upload de vídeos de até 10GB sem impacto na performance com pré-cadastro automático do vídeo como rascunho, processamento automático do vídeo após upload (extração de duração e metadados) com geração automática de thumbnail, URL única por vídeo sem conflito, e reprodução via streaming e download do vídeo pelo usuário — entregando upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando e URLs únicas geradas.

---

## Step Implementations

### SI-03.1 — Instalar Dependências e Provisionar Object Storage e Fila

**Description:** Instala as bibliotecas decididas e provisiona os serviços de infraestrutura (MinIO, Redis) que todo o restante da fase consome.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Instalar `@nestjs/bullmq` e `bullmq` (per `phase-03-videos/TD-03`) — **não** `@nestjs/bull` (pacote legado, ver gotcha em `library-refs.md`)
3. Instalar `fluent-ffmpeg` e adicionar `RUN apt-get install -y ffmpeg` ao `Dockerfile.dev` (per `phase-03-videos/TD-05`)
4. Adicionar os serviços `minio` e `redis` ao `compose.yaml`, seguindo a convenção de rede do projeto (host = nome do serviço Compose)
5. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` via `registerAs`, seguindo o padrão namespaced herdado (per `phase-01-configuracao-base/TD-01`, `phase-01-configuracao-base/TD-03`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d minio redis` sobe os dois serviços com status `running`.
- `npx tsc --noEmit` compila sem erros após as instalações.
- `storage.config.ts` e `queue.config.ts` são injetáveis via `ConfigType<typeof xxxConfig>` seguindo a convenção herdada.

---

### SI-03.2 — Entidade Video e Migration

**Description:** Modela a entidade `Video` que sustenta o rascunho, o rastreio do upload e o resultado do processamento.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos `id, channelId, status, objectKey, uploadId, thumbnailKey, durationSeconds, createdAt, updatedAt` e relação `ManyToOne` com `Channel` (per `phase-03-videos/TD-07`, per `### Data Model`)
2. Gerar a migration via `npm run migration:generate` (convenção herdada de `phase-01-configuracao-base`)
3. Criar `VideosModule` registrando `TypeOrmModule.forFeature([Video])`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, FK `channelId` not null | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A migration cria a tabela `video` com todas as colunas do Data Model e a FK para `channel`.
- Inserir um `Video` sem `channelId` viola a constraint `not null`.
- `status` assume `draft` por padrão quando omitido na criação.

---

### SI-03.3 — StorageModule (integração com Object Storage)

**Description:** Encapsula todo acesso ao MinIO/S3 atrás de um `StorageService`, isolando o SDK do resto da aplicação.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` — instancia `S3Client` apontado pro serviço `minio`, com `endpoint` custom e `forcePathStyle: true` (per `phase-03-videos/TD-01`)
2. Implementar `createMultipartUpload`, `getPresignedUploadPartUrl`, `completeMultipartUpload` e `listParts` (per `phase-03-videos/TD-06`)
3. Implementar `getPresignedDownloadUrl(key, { attachment })` usando `GetObjectCommand` + `getSignedUrl`, setando `ResponseContentDisposition` quando `attachment` for `true` (per `phase-03-videos/TD-02`)
4. Criar `StorageModule` exportando `StorageService` para `VideosModule` e para o worker

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Unit: geração de URL presigned com `S3Client` mockado (branch: `attachment` true/false) | `src/storage/storage.service.spec.ts` |
| `StorageService` | Integration: real MinIO (Docker) — upload de uma parte, `listParts`, completar multipart e recuperar o objeto (per `phase-03-videos/TD-01`) | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `createMultipartUpload` seguido de `getPresignedUploadPartUrl` produz uma URL que aceita um `PUT` direto no MinIO.
- `listParts` retorna as partes já enviadas com seus `ETag`s.
- `getPresignedDownloadUrl(key, { attachment: true })` gera uma URL cujo `GetObjectCommand` inclui `ResponseContentDisposition: attachment`.

---

### SI-03.4 — QueueModule (BullMQ + Redis)

**Description:** Configura a fila `video-processing` usada para desacoplar o processamento do vídeo da requisição HTTP.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` com `BullModule.forRoot({ connection: { host: 'redis', port: 6379 } })` e `BullModule.registerQueue({ name: 'video-processing' })`, ambos de `@nestjs/bullmq` (per `phase-03-videos/TD-03`)
2. Exportar `QueueModule` para `VideosModule` e para o `WorkerModule` (SI-03.10)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test (DI wiring) | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `Test.createTestingModule({ imports: [QueueModule] }).compile()` resolve sem erros de DI.
- `@InjectQueue('video-processing')` injeta uma instância de `Queue` válida.

---

### SI-03.5 — Endpoint POST /videos (rascunho + início do multipart upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated

**Description:** Cria o rascunho do vídeo e inicia o multipart upload direto pro storage, devolvendo as URLs presigned de cada parte.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` com `filename, contentType, sizeBytes, partCount` (class-validator, convenção herdada de `phase-02-auth/TD-06`)
2. Criar `VideosController.create()` — `POST /videos`, protegido pelo guard JWT herdado de `phase-02-auth`
3. Criar `VideosService.createDraft()` — valida `sizeBytes` contra o limite de 10GB, cria `Video` (`status: draft`), chama `StorageService.createMultipartUpload`, gera as URLs presigned via `getPresignedUploadPartUrl` para cada parte e atualiza `status` para `uploading` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
4. Registrar a rota em `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraft` | Unit: branch — `sizeBytes` acima do limite de 10GB rejeita antes de chamar o storage | `src/videos/videos.service.spec.ts` |
| `VideosService.createDraft` | Integration: DB contract — `Video` persistido com `status: uploading` e `uploadId` preenchido | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` com payload válido retorna `201` com `{ id, status: "uploading", uploadId, partUrls }`.
- `POST /videos` com `sizeBytes` acima de 10GB retorna `400` com `errorCode: "FILE_TOO_LARGE"`.
- `POST /videos` sem token de autenticação retorna `401`.

---

### SI-03.6 — Endpoint GET /videos/:id/upload-parts (retomada de upload)

**Route:** GET /videos/:id/upload-parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Authenticated + Owner

**Description:** Permite ao cliente retomar um upload interrompido sem reenviar partes já recebidas pelo storage.

**Technical actions:**

1. Criar `VideosController.getUploadParts()` — `GET /videos/:id/upload-parts`
2. Criar `VideosService.getUploadParts()` — verifica posse (`channelId` do vídeo == canal do usuário autenticado), chama `StorageService.listParts`, calcula as partes ainda faltantes e gera novas URLs presigned só para elas (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getUploadParts` | Unit: branch — cálculo de partes faltantes a partir de `listParts` | `src/videos/videos.service.spec.ts` |
| `VideosService.getUploadParts` | Integration: real MinIO — retomar um upload parcial e confirmar que as partes já enviadas não são reemitidas | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `GET /videos/:id/upload-parts` com partes 1-3 já enviadas retorna `uploadedParts` com essas 3 e `pendingPartUrls` só com as restantes.
- `GET /videos/:id/upload-parts` para um vídeo de outro canal retorna `404`.
- `GET /videos/:id/upload-parts` com `status` diferente de `uploading` retorna `409` com `errorCode: "UPLOAD_ALREADY_COMPLETED"`.

---

### SI-03.7 — Endpoint POST /videos/:id/complete-upload (finalização + enfileiramento)

**Route:** POST /videos/:id/complete-upload
**Test Specs:** see `nestjs-project/specs/videos-complete-upload.plan.md`
**Authorization:** Authenticated + Owner

**Description:** Finaliza o multipart upload no storage e enfileira o job de processamento do vídeo.

**Technical actions:**

1. Criar `VideosController.completeUpload()` — `POST /videos/:id/complete-upload`
2. Criar `VideosService.completeUpload()` — verifica posse, chama `StorageService.completeMultipartUpload` com as `parts` recebidas, atualiza `status` para `processing` e publica o job `video.process` na fila `video-processing` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-03`, per `### Events/Messages`)
3. Tratar `INCOMPLETE_UPLOAD` quando as `parts` recebidas não batem com o que o storage registrou

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: branch — `parts` incompletas rejeita antes de completar o multipart | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: DB contract + fila — `status` vira `processing` e um job `video.process` é enfileirado com `{ videoId }` (per `references/external-systems.md` padrão de fila) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6, SI-03.4

**Acceptance criteria:**

- `POST /videos/:id/complete-upload` com `parts` corretas retorna `202` com `{ id, status: "processing" }` e enfileira exatamente um job `video.process`.
- `POST /videos/:id/complete-upload` com `parts` incompletas retorna `400` com `errorCode: "INCOMPLETE_UPLOAD"`.
- `POST /videos/:id/complete-upload` chamado duas vezes retorna `409` com `errorCode: "UPLOAD_ALREADY_COMPLETED"` na segunda chamada.

---

### SI-03.8 — Endpoint GET /videos/:id/playback-url

**Route:** GET /videos/:id/playback-url
**Test Specs:** see `nestjs-project/specs/videos-playback-url.plan.md`
**Authorization:** Public (Anonymous + Authenticated)

**Description:** Emite a URL presigned de streaming consumida pelo player, sem expor o bucket publicamente.

**Technical actions:**

1. Criar `VideosController.getPlaybackUrl()` — `GET /videos/:id/playback-url`, sem guard (acesso anônimo permitido)
2. Criar `VideosService.getPlaybackUrl()` — valida `status === 'ready'` e chama `StorageService.getPresignedDownloadUrl(objectKey, { attachment: false })` (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` | Unit: branch — `status` diferente de `ready` rejeita antes de chamar o storage | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `GET /videos/:id/playback-url` com `status: ready` retorna `200` com `{ url, expiresIn }`.
- `GET /videos/:id/playback-url` com `status` diferente de `ready` retorna `409` com `errorCode: "VIDEO_NOT_READY"`.
- `GET /videos/:id/playback-url` sem token de autenticação ainda retorna `200` (acesso anônimo).

---

### SI-03.9 — Endpoint GET /videos/:id/download-url

**Route:** GET /videos/:id/download-url
**Test Specs:** see `nestjs-project/specs/videos-download-url.plan.md`
**Authorization:** Public (Anonymous + Authenticated)

**Description:** Emite a URL presigned de download, com `Content-Disposition: attachment`, reaproveitando o mesmo mecanismo do streaming.

**Technical actions:**

1. Criar `VideosController.getDownloadUrl()` — `GET /videos/:id/download-url`, sem guard
2. Criar `VideosService.getDownloadUrl()` — valida `status === 'ready'` e chama `StorageService.getPresignedDownloadUrl(objectKey, { attachment: true })` (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDownloadUrl` | Unit: branch — `status` diferente de `ready` rejeita antes de chamar o storage | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `GET /videos/:id/download-url` com `status: ready` retorna `200` com `{ url, expiresIn }` cuja URL inclui `response-content-disposition=attachment`.
- `GET /videos/:id/download-url` com `status` diferente de `ready` retorna `409` com `errorCode: "VIDEO_NOT_READY"`.

---

### SI-03.10 — Video Worker (entry point + pipeline de processamento ffmpeg)

**Description:** Processo separado que consome a fila `video-processing`, extrai metadados/thumbnail via ffmpeg e conclui o ciclo de vida do vídeo.

**Technical actions:**

1. Criar `src/worker.main.ts` — bootstrap via `NestFactory.createApplicationContext(WorkerModule)`, executado como serviço Compose próprio (per `phase-03-videos/TD-04`)
2. Criar `src/videos/video.processor.ts` — `@Processor('video-processing') class VideoProcessor extends WorkerHost` implementando `process(job)`, chamando `ffmpeg.ffprobe` para duração/metadados e `.screenshots()` para o thumbnail (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
3. Fazer upload do thumbnail gerado via `StorageService` e persistir `thumbnailKey` + `durationSeconds` no `Video`
4. Atualizar `status` para `ready` em caso de sucesso ou `failed` em caso de erro
5. Adicionar o serviço `video-worker` ao `compose.yaml`, mesma imagem do `nestjs-api` com `CMD` apontando pra `worker.main.ts` (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: submeter um job real à fila e verificar que `Video.status` vira `ready` com `durationSeconds` e `thumbnailKey` preenchidos (per `references/external-systems.md` padrão de fila) | `src/videos/video.processor.integration-spec.ts` |
| `VideoProcessor` | Integration: job com arquivo de vídeo inválido resulta em `Video.status: failed` | `src/videos/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.3, SI-03.2

**Acceptance criteria:**

- Um job `video.process` processado com sucesso deixa `Video.status: ready`, `durationSeconds` > 0 e `thumbnailKey` preenchido.
- Um job cujo arquivo de origem não é um vídeo válido deixa `Video.status: failed` sem derrubar o worker.
- `docker compose up -d video-worker` sobe o worker como processo separado do `nestjs-api`.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (per phase-03-videos/TD-07) |
| channelId | uuid | FK → `Channel`, not null (ownership relation, inherited domain modeling from phase-02-auth) |
| status | enum | one of `draft, uploading, processing, ready, failed`; default `draft` (per phase-03-videos/TD-06's draft pre-registration flow and phase-03-videos/TD-04's worker completion/failure outcome) |
| objectKey | varchar | storage key of the raw video file in the bucket (per phase-03-videos/TD-01) |
| uploadId | varchar | nullable; the S3 multipart `UploadId` (per phase-03-videos/TD-06), cleared once the upload completes |
| thumbnailKey | varchar | nullable; storage key of the generated thumbnail (per phase-03-videos/TD-01, phase-03-videos/TD-05) |
| durationSeconds | integer | nullable; populated by the Video Worker from `ffprobe` metadata (per phase-03-videos/TD-05) |
| createdAt | timestamptz | default now() |
| updatedAt | timestamptz | auto-update |

**Relations:** `Channel` has many `Video` (one-to-many)
**Indexes:** none beyond the primary key needed by this phase's capabilities.

---

### API Contracts

#### POST /videos (SI-03.5)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- filename: string, required
- contentType: string, required — MIME type of the video file
- sizeBytes: integer, required — total upload size, used to validate against the 10GB limit
- partCount: integer, required — number of parts the client will upload (per phase-03-videos/TD-06's multipart flow)

**Response 201:**
- id: string (uuid)
- status: string — `uploading`
- uploadId: string — the S3 multipart `UploadId` (per phase-03-videos/TD-06)
- partUrls: array of `{ partNumber: integer, url: string }` — one presigned `UploadPartCommand` URL per part (per phase-03-videos/TD-06)

**Error responses:**
- 400 FILE_TOO_LARGE: when `sizeBytes` exceeds the 10GB limit
- 400 validation error: when the request body fails schema validation

---

#### GET /videos/:id/upload-parts (SI-03.6)

Resume support: proxies S3's `ListParts` (no separate DB table for uploaded parts, per phase-03-videos/TD-06's Option A resume approach) and issues fresh presigned URLs only for the parts still missing, so a resumed upload never re-sends bytes that already succeeded.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- uploadedParts: array of `{ partNumber: integer, eTag: string }` — from `ListParts`
- pendingPartUrls: array of `{ partNumber: integer, url: string }` — fresh presigned `UploadPartCommand` URLs for parts not yet uploaded

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not exist or does not belong to the caller's channel
- 409 UPLOAD_ALREADY_COMPLETED: when the video's `status` is no longer `uploading`

---

#### POST /videos/:id/complete-upload (SI-03.7)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array of `{ partNumber: integer, eTag: string }`, required — the collected ETags for `CompleteMultipartUploadCommand` (per phase-03-videos/TD-06)

**Response 202:**
- id: string (uuid)
- status: string — `processing`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not exist or does not belong to the caller's channel
- 409 UPLOAD_ALREADY_COMPLETED: when `status` is no longer `uploading`
- 400 INCOMPLETE_UPLOAD: when `parts` does not match the parts already uploaded to storage

---

#### GET /videos/:id/playback-url (SI-03.8)

**Request headers:**
- Authorization: Bearer {access_token} — optional; anonymous users may also call this endpoint (streaming is open per the project's anonymous-viewing model)

**Response 200:**
- url: string — presigned `GetObjectCommand` URL (per phase-03-videos/TD-02)
- expiresIn: integer — seconds until the URL expires (per phase-03-videos/TD-02, default 900s unless overridden)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not exist
- 409 VIDEO_NOT_READY: when `status` is not `ready`

---

#### GET /videos/:id/download-url (SI-03.8)

Same mechanism as `GET /videos/:id/playback-url` (per phase-03-videos/TD-02), with the presigned `GetObjectCommand` additionally setting `ResponseContentDisposition: attachment` so the browser downloads instead of streaming inline.

**Request headers:**
- Authorization: Bearer {access_token} — optional; anonymous users may also call this endpoint

**Response 200:**
- url: string — presigned `GetObjectCommand` URL with `Content-Disposition: attachment`
- expiresIn: integer — seconds until the URL expires

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `:id` does not exist
- 409 VIDEO_NOT_READY: when `status` is not `ready`

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|----------------|-------|
| POST /videos | ✗ | ✓ | — |
| GET /videos/:id/upload-parts | ✗ | ✓ | ✓ |
| POST /videos/:id/complete-upload | ✗ | ✓ | ✓ |
| GET /videos/:id/playback-url | ✓ | ✓ | — |
| GET /videos/:id/download-url | ✓ | ✓ | — |

---

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| FILE_TOO_LARGE | 400 | `POST /videos` with `sizeBytes` above the 10GB limit |
| VIDEO_NOT_FOUND | 404 | `:id` does not exist or does not belong to the caller's channel |
| UPLOAD_ALREADY_COMPLETED | 409 | Upload-part or complete-upload requested after `status` left `uploading` |
| INCOMPLETE_UPLOAD | 400 | `complete-upload`'s `parts` does not match what storage has recorded for the multipart upload |
| VIDEO_NOT_READY | 409 | `playback-url` or `download-url` requested while `status` is not `ready` |

_Error response shape inherited from `phase-02-auth/TD-07` (`{ statusCode, error, message }` custom domain exception filter)._

---

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per phase-03-videos/TD-06, phase-03-videos/TD-03)
**Consumer:** `VideoProcessor` (per phase-03-videos/TD-04, phase-03-videos/TD-05)
**Trigger:** `POST /videos/:id/complete-upload` succeeds (per phase-03-videos/TD-06)
**Delivery semantics:** at-least-once, BullMQ default retry/backoff policy (per phase-03-videos/TD-03)

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root)
├── SI-03.3 — depends on SI-03.1 (precisa das libs/config instaladas)
└── SI-03.4 — depends on SI-03.1 (precisa das libs/config instaladas)

SI-03.2 (root)

SI-03.5 — depends on SI-03.2 + SI-03.3 (entidade + storage precisam existir)
└── SI-03.6 — depends on SI-03.5 (upload já iniciado)
    └── SI-03.7 — depends on SI-03.6 + SI-03.4 (upload retomável + fila disponível)

SI-03.8 — depends on SI-03.2 + SI-03.3 (entidade + storage precisam existir)
SI-03.9 — depends on SI-03.2 + SI-03.3 (entidade + storage precisam existir)
SI-03.10 — depends on SI-03.2 + SI-03.3 + SI-03.4 (entidade + storage + fila precisam existir)
```

---

## Deliverables

- [ ] SI-03.1 — Instalar Dependências e Provisionar Object Storage e Fila
- [ ] SI-03.2 — Entidade Video e Migration
- [ ] SI-03.3 — StorageModule (integração com Object Storage)
- [ ] SI-03.4 — QueueModule (BullMQ + Redis)
- [ ] SI-03.5 — Endpoint POST /videos (rascunho + início do multipart upload)
- [ ] SI-03.6 — Endpoint GET /videos/:id/upload-parts (retomada de upload)
- [ ] SI-03.7 — Endpoint POST /videos/:id/complete-upload (finalização + enfileiramento)
- [ ] SI-03.8 — Endpoint GET /videos/:id/playback-url
- [ ] SI-03.9 — Endpoint GET /videos/:id/download-url
- [ ] SI-03.10 — Video Worker (entry point + pipeline de processamento ffmpeg)

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
