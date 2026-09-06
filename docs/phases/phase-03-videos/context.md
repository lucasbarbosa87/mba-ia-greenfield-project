---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-05T08:26:08-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-05T09:23:10-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-05T08:26:08-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-05T08:26:08-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-05T08:26:08-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-05T08:26:08-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-05T08:26:08-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — primary subproject (per `technical-decisions-phase-03-videos.md`'s Subprojects note): receives the Object Storage integration, background job queue, Video Worker process, `ffmpeg` processing pipeline, upload endpoints, and the `Video` entity.
- `next-frontend` — no dedicated upload/player screens this phase (no "Telas de upload" bullet, unlike Fase 02); two Cross-layer TDs (phase-03-videos/TD-02, TD-06) decide contracts a future frontend slice will implement.

**Deferred subprojects:** `next-frontend` (UI implementation only — the cross-layer contract is decided now; screens follow in a later phase, mirroring the `phase-02-auth` → `phase-02-auth-frontend` split).

**Sequencing notes:** Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Object Storage Backend | decided | A (MinIO) | @aws-sdk/client-s3 |
| phase-03-videos/TD-02 | phase | Cross-layer | Video Delivery & Streaming Access Strategy | decided | A (Presigned GET URLs) | @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Deployment Model | decided | A (Second Nest entry point) | — |
| phase-03-videos/TD-05 | phase | Backend | Video Processing & Metadata Extraction Library | decided | A (fluent-ffmpeg + apt ffmpeg) | fluent-ffmpeg |
| phase-03-videos/TD-06 | phase | Cross-layer | Large File Upload Protocol & Resumability | decided | A (Direct-to-storage presigned multipart) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-07 | phase | Backend | Public Video Identifier & Unique URL Strategy | decided | A (UUID) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-06 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-02 |
| Download do vídeo pelo usuário | phase-03-videos/TD-02 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** the only option that satisfies the architecture diagram's "S3 or MinIO" container while keeping local dev and CI fully inside Docker Compose at zero cost, and being S3-API-compatible means the integration code doubles as the production-S3 code path.
**Libraries:** @aws-sdk/client-s3

### phase-03-videos/TD-02

**Recommendation:** the only option consistent with both the diagram's direct frontend→storage relationship and Fase 04's already-planned unlisted/private visibility, which a permanent public URL (Option B) cannot support without rework.
**Libraries:** @aws-sdk/s3-request-presigner

### phase-03-videos/TD-03

**Recommendation:** it directly closes the diagram's "TBD" with the exact technology the project's own best-practices skill already prescribes, and Redis is a one-line `compose.yaml` addition.
**Libraries:** @nestjs/bullmq, bullmq

### phase-03-videos/TD-04

**Recommendation:** the only option satisfying both the C4 diagram's two-container model and the "no impact on performance" requirement without introducing a third subproject. Depends on TD-03 (the worker's runtime shape follows from the chosen queue technology).
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** consistent with the Dockerfile's existing `apt`-based system-package pattern, and avoids Option B's older/bundled-binary trade-off.
**Libraries:** fluent-ffmpeg

### phase-03-videos/TD-06

**Recommendation:** zero video-byte passthrough on the API most directly answers "sem impacto na performance," and extends the frontend↔storage direct-access pattern TD-02 already establishes. The extra part-tracking bookkeeping is a one-time cost against Option B's more turnkey resumability; revisit toward Option B if that bookkeeping proves too costly during implementation.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-07

**Recommendation:** simplest option that fully satisfies "never conflicts" by construction, avoids Option C's enumeration risk; the URL-friendliness trade-off against Option B can be revisited in Fase 05 (the watch-page phase) if short URLs become a product requirement then.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) Architectural fit — the strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match. (2) Smaller blast radius — a ~50-LOC session helper is grep-friendly, debuggable, and test-friendly. (3) Compatibility with Next.js 16 / React 19 — built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) Defense in depth on the cookie content — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection. (2) Single cookie to manage simplifies logout and avoids the orphan-cookie failure mode. (3) Room to carry minimal user metadata (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render authenticated chrome without a per-render `/auth/me` round-trip.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) Decoupled from TD-05 — works with Route Handlers OR Server Actions. (2) Aligned with shadcn's canonical form primitive (`radix-nova`, `components.json`). (3) Zod-first developer ergonomics match the rest of the FE foundation.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) Strict-BFF alignment — every mutation stays visible under `app/api/**`. (2) Test scaffold already exists for Route-Handlers-as-functions. (3) Single mutation surface sets the precedent for Phases 03–07.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) No first-render flicker, no round-trip — the session is delivered in the same response as the page HTML. (2) No new BFF endpoint — the cookie is the source of truth.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) First-paint-correct — the user sees the right outcome on the first paint. (2) Single integration pattern across both flows. (3) Email-prefetch behavior is solved at the backend's idempotent-confirmation level.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** É a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**
- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos. Rationale: openapi.json gerado pelo bootstrap atual está genérico porque a base instalada se apoiou só na introspecção automática.

### openapi-docs-nestjs/TD-02

**Recommendation:** O custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante. Video upload/streaming/download endpoints added in this phase are exposed via the same runtime UI + `openapi.json` artifact.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot(...)`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'`, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) sourced from a single `databaseConfig` factory. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | The umbrella bullet's full coverage requires the confirmação and reset-password destination screens, both deferred per rows above; the 3 ship-this-phase telas (signup, login, forgot-password) are covered by their own verbs. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact created | Required tests |
|---|---|
| Entity (`*.entity.ts`) — e.g. `Video` | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (e.g. BullMQ queue, S3 client) | Unit: real lib with test config |
| Service with side-effect dep (Object Storage, queue publish) | Integration: real capture/local adapter (see `references/external-systems.md` — Object Storage local-filesystem adapter, Message Queue real Docker broker) |
| Module with configured imports (`BullModule.registerQueue`, `TypeOrmModule.forFeature`) | Unit: compilation test |
| Controller (upload/video endpoints) | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Video Worker process/processor (`@Processor` or standalone entry point) | Integration: submit a job, assert processing outcome (per `references/external-systems.md` Message Queue pattern) |

### next-frontend

_Deferred subproject — no FE artifact ships in this phase (no screens, no BFF routes for video). Testing requirements will be defined against `testing-guide-next-frontend` when the future frontend slice (mirroring `phase-02-auth-frontend`) implements the upload UI and video player against the TD-02/TD-06 contracts decided here._
