---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# GET /videos/:id/playback-url Test Plan

Public endpoint that mints a presigned streaming URL for a ready video — anonymous viewing is part of the platform's viewing model.

## Test Scenarios

### 1. GET /videos/:id/playback-url

**Setup:** `beforeEach` truncate `video`/`user`/`channel` tables; bootstrap the app; seed a `Video` with `status: ready` and a valid `objectKey`.

#### 1.1. returns-presigned-url-when-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. GET /videos/:id/playback-url para um vídeo com `status: ready`
    - expect: status 200
    - expect: body contém `{ url, expiresIn }`
    - expect: `url` é uma URL presigned válida apontando pro `objectKey` do vídeo

#### 1.2. rejects-when-video-not-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. GET /videos/:id/playback-url para um vídeo com `status` diferente de `ready` (e.g. `processing`)
    - expect: status 409
    - expect: body contém `errorCode: "VIDEO_NOT_READY"`

#### 1.3. allows-anonymous-access

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. GET /videos/:id/playback-url sem header `Authorization`, para um vídeo com `status: ready`
    - expect: status 200
    - expect: body contém `{ url, expiresIn }`
