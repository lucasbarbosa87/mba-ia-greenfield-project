---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# POST /videos Test Plan

Endpoint that creates a video draft and initiates a direct-to-storage multipart upload, returning the presigned part URLs the client uploads to.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeEach` truncate `video`/`user`/`channel` tables via `dataSource.query`; bootstrap the app via `Test.createTestingModule({ imports: [AppModule] }).compile()`; log in a seeded user to obtain a valid `access_token`.

#### 1.1. creates-draft-and-returns-presigned-part-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. POST /videos com `Authorization: Bearer {access_token}` e body `{ filename, contentType, sizeBytes, partCount }` válido
    - expect: status 201
    - expect: body contém `{ id, status: "uploading", uploadId, partUrls }`
    - expect: `partUrls` tem exatamente `partCount` entradas, cada uma com `partNumber` e `url`

#### 1.2. rejects-file-too-large

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. POST /videos com `sizeBytes` acima do limite de 10GB
    - expect: status 400
    - expect: body contém `errorCode: "FILE_TOO_LARGE"`

#### 1.3. rejects-unauthenticated-request

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-05T12:42:40Z

**Steps:**
  1. POST /videos sem header `Authorization`
    - expect: status 401
