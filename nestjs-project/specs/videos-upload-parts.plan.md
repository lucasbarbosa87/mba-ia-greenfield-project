---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# GET /videos/:id/upload-parts Test Plan

Resume-support endpoint: proxies storage's `ListParts` and returns fresh presigned URLs only for the parts still missing, so a resumed upload never re-sends bytes that already succeeded.

## Test Scenarios

### 1. GET /videos/:id/upload-parts

**Setup:** `beforeEach` truncate `video`/`user`/`channel` tables; bootstrap the app; seed a `Video` with `status: uploading` and an in-progress multipart upload owned by the authenticated user's channel.

#### 1.1. returns-uploaded-and-pending-parts

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. Upload parts 1-3 diretamente ao storage via as URLs presigned emitidas na criação
  2. GET /videos/:id/upload-parts com `Authorization: Bearer {access_token}` do dono do vídeo
    - expect: status 200
    - expect: `uploadedParts` contém exatamente as partes 1-3 com seus `eTag`s
    - expect: `pendingPartUrls` contém apenas as partes restantes

#### 1.2. rejects-video-from-another-channel

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. GET /videos/:id/upload-parts com `:id` de um vídeo pertencente a outro canal
    - expect: status 404
    - expect: body contém `errorCode: "VIDEO_NOT_FOUND"`

#### 1.3. rejects-when-upload-already-completed

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. GET /videos/:id/upload-parts para um vídeo cujo `status` não é `uploading`
    - expect: status 409
    - expect: body contém `errorCode: "UPLOAD_ALREADY_COMPLETED"`
