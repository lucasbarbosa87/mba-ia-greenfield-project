---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# GET /videos/:id/download-url Test Plan

Public endpoint that mints a presigned download URL for a ready video, using the same mechanism as playback but forcing `Content-Disposition: attachment`.

## Test Scenarios

### 1. GET /videos/:id/download-url

**Setup:** `beforeEach` truncate `video`/`user`/`channel` tables; bootstrap the app; seed a `Video` with `status: ready` and a valid `objectKey`.

#### 1.1. returns-attachment-presigned-url-when-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. GET /videos/:id/download-url para um vídeo com `status: ready`
    - expect: status 200
    - expect: body contém `{ url, expiresIn }`
    - expect: `url` contém o parâmetro `response-content-disposition=attachment`

#### 1.2. rejects-when-video-not-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. GET /videos/:id/download-url para um vídeo com `status` diferente de `ready`
    - expect: status 409
    - expect: body contém `errorCode: "VIDEO_NOT_READY"`
