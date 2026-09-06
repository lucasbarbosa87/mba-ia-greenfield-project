---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# POST /videos/:id/complete-upload Test Plan

Finalizes the multipart upload against storage and enqueues the `video.process` job that the Video Worker consumes.

## Test Scenarios

### 1. POST /videos/:id/complete-upload

**Setup:** `beforeEach` truncate `video`/`user`/`channel` tables; bootstrap the app with the `video-processing` BullMQ queue registered against the test Redis instance; seed a `Video` with `status: uploading` and all parts already uploaded to storage.

#### 1.1. completes-upload-and-enqueues-job

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. POST /videos/:id/complete-upload com `Authorization: Bearer {access_token}` do dono e body `{ parts }` com os `partNumber`/`eTag` corretos
    - expect: status 202
    - expect: body contém `{ id, status: "processing" }`
    - expect: exatamente um job `video.process` com `{ videoId: id }` foi enfileirado na fila `video-processing`

#### 1.2. rejects-incomplete-parts

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. POST /videos/:id/complete-upload com `parts` que não batem com o que o storage registrou
    - expect: status 400
    - expect: body contém `errorCode: "INCOMPLETE_UPLOAD"`

#### 1.3. rejects-second-completion-call

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. POST /videos/:id/complete-upload com sucesso uma primeira vez
    - expect: status 202
  2. POST /videos/:id/complete-upload novamente para o mesmo `:id`
    - expect: status 409
    - expect: body contém `errorCode: "UPLOAD_ALREADY_COMPLETED"`
