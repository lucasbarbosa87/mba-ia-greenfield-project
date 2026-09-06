---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-05
scope_description: "Backend infrastructure and cross-layer contracts for Phase 03 — video upload and processing: object storage backend, background job queue technology, video worker deployment model, video processing/metadata library, large-file upload protocol and resumability, video delivery/streaming access strategy, and public video identifier strategy."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — primary subproject. Receives the Object Storage integration, the background job queue, the Video Worker process, the `ffmpeg`-based processing pipeline, the upload endpoints, and the `Video` entity (draft pre-registration, status, public identifier).
- `next-frontend/` — no dedicated upload/player screens in this phase: unlike Fase 02 (which explicitly lists "Telas de cadastro, login, confirmação de conta e recuperação de senha" as its own capability bullet), Fase 03's capability list has no equivalent "Telas de upload" bullet — the actual upload UI and video player are addressed in later phases (Fase 04's management panel, Fase 05's watch page), following the same backend-first split already used for auth (`phase-02-auth` → `phase-02-auth-frontend`). Two Cross-layer contracts are decided here regardless (TD-02, TD-06) so that future frontend work can implement the upload/player UI without reopening these choices.

---

## TD-01: Object Storage Backend

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Video files and thumbnails must be persisted outside the PostgreSQL database. The C4 architecture diagram (`docs/diagrams/software-arch.mermaid`) already names the Object Storage container as "S3 or MinIO"; this decision settles which one backs local dev/CI, and reconciles the pre-phase placeholder recorded in `testing-guide-nestjs-project/references/external-systems.md` ("Local filesystem storage in development and tests. S3 in production"), written before this phase was researched.

**Options:**

### Option A: MinIO (self-hosted, S3-compatible, new Docker Compose service)
- Runs as a `minio` service in `nestjs-project/compose.yaml`, reached by its service name per this project's Docker networking convention. Accessed with the generic `@aws-sdk/client-s3` (pointed at the `minio` service via a custom `endpoint` + `forcePathStyle: true`) rather than the MinIO-specific `minio` npm SDK — the same client code then targets a real AWS S3 endpoint later with only the `endpoint`/credentials changed, no code branch per backend.
- **Pros:** Zero cost, no external account needed for dev or CI, keeps the entire dev loop inside Docker Compose, validates the exact multipart-upload/presigned-URL code paths (TD-02, TD-06) that a production S3 swap would reuse unchanged.
- **Cons:** Single-node MinIO durability is only as good as the container's volume — no erasure coding without a multi-node setup; dev machines need enough free disk for large test uploads.

### Option B: Real AWS S3 (used even in dev)
- Every environment, including local dev, talks to an actual S3 bucket.
- **Pros:** Production-parity from day one; AWS-managed durability with no operational setup.
- **Cons:** Requires real AWS credentials for every developer and CI run, incurs cost during development, breaks the project's "everything runs in Docker Compose" development model, and makes the dev loop network-dependent.

### Option C: Local filesystem storage behind a `StorageService` abstraction
- Files are written to a directory on the API container's own disk.
- **Pros:** Simplest possible implementation; no new Docker service.
- **Cons:** Does not implement the C4 diagram's declared Object Storage container; gives the frontend no HTTP-addressable target for the direct `Rel(frontend, storage, "Streams", "HTTPS")` relationship the diagram already assumes; never exercises multipart-upload/presigned-URL code that production will need; contradicts the project's own attention point about planning storage growth from the start.

**Recommendation:** Option A (MinIO) — the only option that satisfies the architecture diagram's "S3 or MinIO" container while keeping local dev and CI fully inside Docker Compose at zero cost, and being S3-API-compatible means the integration code doubles as the production-S3 code path.

**Decision:** A (MinIO)
**Libraries:** @aws-sdk/client-s3

---

## TD-02: Video Delivery & Streaming Access Strategy

**Scope:** Cross-layer

**Transversal — covers:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The C4 diagram has the frontend read video bytes directly from Object Storage over HTTPS (`Rel(frontend, storage, "Streams", "HTTPS")`), not through the API. How the frontend obtains an authorized, Range-request-capable URL for a given video is a contract between the backend (which owns the object key) and the frontend (which feeds it to a `<video>` element or a download link) — both sides must agree on the same mechanism.

**Options:**

### Option A: Presigned GET URLs minted per request by the API
- An endpoint (e.g. `GET /videos/:id/playback-url`) returns a short-lived presigned URL via `@aws-sdk/s3-request-presigner`'s `getSignedUrl(client, new GetObjectCommand(...), { expiresIn })` (defaults to 900s if `expiresIn` is omitted); the frontend uses it directly as the `<video src>` / download href. Standard HTTP Range requests work unchanged against a presigned URL.
- **Pros:** The bucket stays fully private (no public-read policy); identical implementation for MinIO and S3; gives a ready seam for Fase 04's unlisted/private video visibility without re-architecting.
- **Cons:** URLs expire — a tab left open past expiry needs the frontend to re-fetch; adds one API round-trip before playback starts.

### Option B: Public-read bucket/objects with permanent URLs
- The object's URL is public and stored directly on the `Video` entity.
- **Pros:** No expiry handling, no extra API round-trip, simplest frontend integration.
- **Cons:** Anyone holding the URL can access the object forever with no revocation — conflicts with Fase 04's planned unlisted/private visibility, which would need a breaking migration to retrofit access control onto a permanent public URL.

### Option C: Proxy streaming through the API
- The API reads from storage and pipes bytes to the client itself, implementing HTTP Range handling in the request handler.
- **Pros:** Single security perimeter — only the API is ever HTTPS-exposed, storage stays internal-only.
- **Cons:** Directly contradicts the C4 diagram's frontend→storage relationship; reintroduces the API as a bottleneck for large-file I/O, which the architecture was designed to avoid; doubles bandwidth cost (storage→API→client instead of storage→client).

**Recommendation:** Option A (presigned GET URLs) — the only option consistent with both the diagram's direct frontend→storage relationship and Fase 04's already-planned unlisted/private visibility, which a permanent public URL (Option B) cannot support without rework.

**Decision:** A (Presigned GET URLs)
**Libraries:** @aws-sdk/s3-request-presigner

---

## TD-03: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram names the Message Queue container as "TBD" — the phase's most direct architectural blank. The queue decouples upload completion from the slow, CPU-heavy video-processing step so the request that finalizes an upload returns immediately.

**Options:**

### Option A: BullMQ + Redis, via `@nestjs/bullmq`
- Redis-backed job queue; official NestJS-maintained module (supports `@nestjs/common`/`core` `^11.0.0`, matching the installed Nest 11).
- **Pros:** This project's own `nestjs-best-practices` skill already documents `@nestjs/bullmq` as the canonical background-job pattern (retry policies, `@Processor` classes, progress tracking) — adopting it needs no new team convention; Redis is a single lightweight Compose service.
- **Cons:** Introduces Redis purely for the queue (not yet reused for caching/sessions).

### Option B: RabbitMQ + `@nestjs/microservices` (AMQP transport)
- A dedicated message broker with exchange/topic routing.
- **Pros:** More advanced routing if the platform later needs pub/sub beyond simple job queues.
- **Cons:** Heavier operational footprint (separate broker + management UI); no ready-made retry/progress/job-state API the way BullMQ's `Job` object provides; not documented anywhere in the project's existing best-practices skill, so the team would invent conventions from scratch.

### Option C: Managed cloud queue (e.g. AWS SQS)
- **Pros:** No broker to operate.
- **Cons:** Requires external cloud credentials in every environment including dev/CI, breaks the fully-Dockerized local dev model, and adds network latency a local broker never has.

**Recommendation:** Option A (BullMQ + Redis) — it directly closes the diagram's "TBD" with the exact technology the project's own best-practices skill already prescribes, and Redis is a one-line `compose.yaml` addition.

**Decision:** A (BullMQ + Redis)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-04: Video Worker Deployment Model

**Scope:** Backend

**Transversal — covers:** Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The C4 diagram draws "Video Worker" as its own Container, separate from "API" — an intentionally distinct deployable, not just a class inside the API process. `nestjs-project` is a single, non-monorepo Nest CLI app (no `apps/`/`libs/` workspace); this decision settles how that one codebase produces the two runtime processes the architecture calls for.

**Options:**

### Option A: Second Nest entry point in the same codebase (`src/worker.main.ts`), own Compose service/command
- Bootstraps only the queue/video modules via `NestFactory.createApplicationContext`, run as a distinct `compose.yaml` service sharing the same image/codebase with a different `CMD`.
- **Pros:** Matches the C4 diagram's two-container model exactly; the worker can be scaled or restarted independently of the API, so heavy `ffmpeg` CPU usage never competes with the request-handling event loop; keeps everything in one codebase (no duplicated entities/config).
- **Cons:** Two service definitions (API, worker) to keep in sync against one shared image.

### Option B: `@Processor` class registered in the same process as the API (`main.ts`)
- **Pros:** Simplest setup — one process, one Compose service, no change to the current `nestjs-api` service.
- **Cons:** Contradicts the C4 diagram's explicit two-container model; `ffmpeg` spawning inside the API's Node process competes for the same event loop/CPU serving HTTP requests — precisely the "sem travar o sistema" requirement the phase's attention notes call out.

### Option C: Fully separate subproject/repo for the worker
- **Pros:** Maximum isolation — separate deploy, scaling, dependency tree.
- **Cons:** The project has exactly two declared subprojects (`nestjs-project`, `next-frontend`); a third means duplicating the `Video`/`Channel` TypeORM entities and DB connection config across codebases, a maintenance cost with no benefit over Option A at this project's scale.

**Recommendation:** Option A — the only option satisfying both the C4 diagram's two-container model and the "no impact on performance" requirement without introducing a third subproject. Depends on TD-03 (the worker's runtime shape follows from the chosen queue technology).

**Decision:** A (Second Nest entry point)

---

## TD-05: Video Processing & Metadata Extraction Library

**Scope:** Backend

**Transversal — covers:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Extracting duration/metadata and generating a thumbnail both require driving `ffmpeg`/`ffprobe` from Node. The `node:25.6.0-slim` base image (`nestjs-project/Dockerfile.dev`) does not ship `ffmpeg`, so this decision also settles how the binary reaches the container.

**Options:**

### Option A: `fluent-ffmpeg` + `ffmpeg` installed via `apt` in the Dockerfile
- `fluent-ffmpeg` remains the most-used, actively-maintained Node wrapper (chainable API covering both `ffprobe` metadata reads and `screenshots()` thumbnail extraction in one library).
- **Pros:** One library for both extraction needs; `apt install ffmpeg` gives the exact binary/codec set the Debian-slim image's architecture needs; the Dockerfile already installs system packages via `apt` (`curl`, `procps`), so this is consistent with the existing pattern.
- **Cons:** Adds an `apt install ffmpeg` layer (image size, build time).

### Option B: `fluent-ffmpeg` + `ffmpeg-static` (npm-bundled binary)
- **Pros:** No Dockerfile change — the binary ships as an npm dependency, identical across dev machines and CI.
- **Cons:** Bundles a fixed, often older `ffmpeg` build with fewer/older codecs; its postinstall binary download can be blocked by restrictive npm/CI network policies.

### Option C: Bespoke `child_process.spawn('ffmpeg', ...)` calls, no wrapper library
- **Pros:** Zero extra dependency, full control over CLI flags.
- **Cons:** Reimplements what `fluent-ffmpeg` already does well (stdout/stderr parsing for progress and metadata, cross-platform argument building) — fails the "resolved by an existing maintained wrapper" test for no functional gain.

**Recommendation:** Option A (`fluent-ffmpeg` + `apt`-installed `ffmpeg`) — consistent with the Dockerfile's existing `apt`-based system-package pattern, and avoids Option B's older/bundled-binary trade-off.

**Decision:** A (fluent-ffmpeg + apt ffmpeg)
**Libraries:** fluent-ffmpeg

---

## TD-06: Large File Upload Protocol & Resumability

**Scope:** Cross-layer

**Transversal — covers:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Uploads up to 10GB must not block the API and must be resumable after a dropped connection (`docs/project-plan.md` § Pontos de Atenção). Whichever protocol is chosen dictates the handshake sequence a future frontend upload UI must implement, and when/how the API creates the "draft" `Video` row. Depends on TD-01 (storage backend, since Options A/B are storage-API-specific).

**Options:**

### Option A: Direct-to-storage multipart upload via presigned part URLs
- API only orchestrates: create the `Video` draft + `CreateMultipartUploadCommand`, hand out presigned `UploadPartCommand` URLs (`getSignedUrl` per part); the browser PUTs each part directly to storage; the API then calls `CompleteMultipartUploadCommand` with the collected ETags.
- **Pros:** Zero video bytes ever pass through the API process — the strongest possible answer to "sem impacto na performance"; extends the same direct frontend↔storage pattern TD-02 already establishes for reads, now to writes; parts can be retried by re-requesting a presigned URL for the missing part number.
- **Cons:** Resuming across a full page reload requires the frontend to query which parts already succeeded (`ListParts`) — no off-the-shelf resume logic, the API must implement this bookkeeping; needs CORS configured on the MinIO/S3 bucket for browser-direct PUTs.

### Option B: `tus` resumable-upload protocol (`@tus/server` + `@tus/s3-store`)
- A tus server mounted in the Nest app (as Express middleware, `.all('*', server.handle.bind(server))`, per `@tus/server`'s integration pattern) receives the byte stream via PATCH requests with byte offsets, forwarding to storage's multipart API. `@tus/s3-store`'s `s3ClientConfig` accepts a custom `endpoint`, so it targets MinIO the same way TD-01's `@aws-sdk/client-s3` does. `tus-js-client` on the frontend drives pause/resume/retry automatically.
- **Pros:** Purpose-built for exactly this problem — no bespoke resume bookkeeping needed on the frontend.
- **Cons:** The upload byte stream is proxied through the API's Node process (as a stream, not buffered — memory-safe, but still consumes the API container's bandwidth/CPU for the whole transfer, unlike Option A's zero-passthrough model); adds a second HTTP-serving concern in the same process; scaling the API horizontally would additionally require a shared Redis-backed cache/locker (`@tus/s3-store`'s `cache` option) for cross-instance upload resumption, a piece Option A doesn't need at all.

### Option C: Single non-resumable `multipart/form-data` request via `FileInterceptor` + disk storage
- **Pros:** Simplest possible implementation, no new libraries.
- **Cons:** Does not meet the explicit "permita retomar em caso de falha de conexão" requirement — any dropped connection during a multi-GB upload restarts from zero. Kept here only as the baseline the other options must beat.

**Recommendation:** Option A (direct-to-storage presigned multipart) — zero video-byte passthrough on the API most directly answers "sem impacto na performance," and extends the frontend↔storage direct-access pattern TD-02 already establishes. The extra part-tracking bookkeeping is a one-time cost against Option B's more turnkey resumability; revisit toward Option B if that bookkeeping proves too costly during implementation.

**Decision:** A (Direct-to-storage presigned multipart)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-07: Public Video Identifier & Unique URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public identifier, guaranteed unique, that will appear in a future watch-page URL (Fase 05) and in this phase's storage object keys/upload orchestration (TD-06). Collisions are explicitly called out as a risk in the project's attention points.

**Options:**

### Option A: Database-generated UUID as the video's primary key and public identifier
- **Pros:** Native PostgreSQL/TypeORM support, zero collision risk by construction, no extra library.
- **Cons:** Long, less human-friendly in a URL than a YouTube-style short ID.

### Option B: Short unique code (nanoid/`hashids`) generated at draft-creation time, alongside a separate internal PK
- **Pros:** Short, shareable URLs (`/watch?v=aB3xQ9`).
- **Cons:** Needs an explicit uniqueness check/retry loop (rare but non-zero collision risk with a short alphabet); adds a library and a second identifier column alongside the internal PK.

### Option C: Sequential integer ID exposed directly
- **Pros:** Simplest, no extra library.
- **Cons:** Leaks total video count and creation order (enumerable) — a real information-disclosure concern for a public video platform.

**Recommendation:** Option A (UUID as PK and public identifier) — simplest option that fully satisfies "never conflicts" by construction, avoids Option C's enumeration risk; the URL-friendliness trade-off against Option B can be revisited in Fase 05 (the watch-page phase) if short URLs become a product requirement then.

**Decision:** A (UUID)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Backend | MinIO (Option A) | A |
| TD-02 | Cross-layer | Video Delivery & Streaming Access Strategy | Presigned GET URLs (Option A) | A |
| TD-03 | Backend | Background Job Queue Technology | BullMQ + Redis (Option A) | A |
| TD-04 | Backend | Video Worker Deployment Model | Second Nest entry point (Option A) | A |
| TD-05 | Backend | Video Processing & Metadata Extraction Library | fluent-ffmpeg + apt ffmpeg (Option A) | A |
| TD-06 | Cross-layer | Large File Upload Protocol & Resumability | Direct-to-storage presigned multipart (Option A) | A |
| TD-07 | Backend | Public Video Identifier & Unique URL Strategy | UUID (Option A) | A |
