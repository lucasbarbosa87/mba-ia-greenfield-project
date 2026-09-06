# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

### SI-03.1 — Instalar Dependências e Provisionar Object Storage e Fila
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - `fluent-ffmpeg` está deprecated no npm ("no longer supported") mas segue sendo o wrapper mais usado/mantido pra ffmpeg em Node — decisão já documentada em `phase-03-videos/TD-05`, sem ação necessária.
  - Adicionado `@types/fluent-ffmpeg` como dev dependency (não estava listado no SI, mas necessário pro `strict` TypeScript do projeto).
  - `minio`/`redis` credenciais de dev hardcoded no `compose.yaml` (`streamtube`/`streamtube123`) seguindo o mesmo padrão de `db`/`mailpit` já existentes no arquivo — não é segredo de produção.

### SI-03.2 — Entidade Video e Migration
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - Plano usava nomes de campo em camelCase (`channelId`, `objectKey`, ...) na Data Model; implementado em snake_case (`channel_id`, `object_key`, ...) pra bater com a convenção já estabelecida em `Channel`/`User` (colunas `user_id`, `created_at`). Semanticamente idêntico, só convenção de casing.
  - **Bloqueio de ambiente não relacionado a esta SI, resolvido pra desbloquear o trabalho:** não existia `.env` no projeto (só `.env.example`), e o `.env.example` tinha o bug de `MAIL_FROM` já documentado em `CLAUDE.md` (`<`/`>` fora de aspas quebra o parser do Docker Compose) — impedia `docker compose` de sequer ler o arquivo. Criei `.env` a partir do `.env.example` e apliquei a correção de quoting documentada em ambos os arquivos.
  - Banco de dev nunca tinha rodado nenhuma migration antes (primeira execução real do projeto) — rodei as migrations de `phase-01`/`phase-02` (`CreateUsersAndChannels`, `CreateAuthTokens`) antes de gerar a migration da `Video`, pra evitar que o diff automático recriasse as tabelas já existentes.
  - Adicionado `.env.example`: variáveis `STORAGE_*`/`REDIS_*` (faltavam desde a SI-03.1).

### SI-03.3 — StorageModule (integração com Object Storage)
- **Status:** completed
- **Tests:** 3 passing (2 unit + 1 integration)
- **Observations:**
  - `StorageService.onModuleInit` cria o bucket automaticamente (`HeadBucketCommand` → `CreateBucketCommand` no catch) — não estava explícito no SI, mas necessário pra funcionar contra uma instância MinIO nova/vazia; sem isso toda operação falharia com bucket inexistente.
  - Teste de integração usa uma parte de 5MB (mínimo exigido pela API S3 multipart pra partes que não são a última) e `fetch` nativo do Node 25 pra fazer o PUT/GET direto contra a URL presigned — sem lib HTTP adicional.

### SI-03.4 — QueueModule (BullMQ + Redis)
- **Status:** completed
- **Tests:** 2 passing
- **Observations:**
  - Plano usava `BullModule.forRoot({ connection: {...} })` com host/port hardcoded; implementado com `forRootAsync` + `queueConfig.KEY` (padrão já usado em `TypeOrmModule.forRootAsync` no `app.module.ts`) em vez de valores hardcoded.
  - **Fix loop (1 tentativa):** `@nestjs/bullmq`/`@nestjs/bull-shared` são pacotes ESM puros (`"type": "module"`) — o Jest padrão do projeto não conseguia parsear o `export` deles. Adicionado `transformIgnorePatterns` no `jest` config (`package.json`) e em `test/jest-e2e.json` pra permitir que o ts-jest transpile esses dois pacotes.
  - **Fix loop (tentativa 2):** faltava `ioredis` como dependência — o `bullmq` carrega ele em runtime (`loadIORedis`) mas não é uma dependência transitiva automática. Instalado explicitamente (não estava listado no SI nem no `library-refs.md`).

### SI-03.5 — Endpoint POST /videos (rascunho + início do multipart upload)
- **Status:** completed
- **Tests:** 5 passing (1 unit + 1 integration + 3 e2e via spec `videos-create.plan.md`)
- **Observations:**
  - Endpoint é protegido por padrão pelo guard JWT global (`APP_GUARD` em `auth.module.ts`) — não precisou de decorator extra, só a ausência de `@Public()`.
  - `channel_id` resolvido a partir do `sub` do JWT via lookup direto no `Channel` repository (importado `ChannelsModule` no `VideosModule`) — `ChannelsService` não tinha um método `findByUserId`, então usei o repository diretamente em vez de adicionar um método novo a um módulo fora do escopo desta fase.
  - `object_key` gerado como `videos/{video.id}/{filename}` — não especificado no SI, decisão de implementação.
  - Arquivo `test/videos.e2e-spec.ts` criado nesta SI; SIs seguintes (03.6-03.9) vão **adicionar** blocos `test()` no mesmo arquivo (todos os 5 specs compartilham o mesmo `target_file` por convenção de recurso REST — ver nota do `/plan-test-specs`).

### SI-03.6 — Endpoint GET /videos/:id/upload-parts (retomada de upload)
- **Status:** completed
- **Tests:** 10 passing (2 unit + 2 integration + 6 e2e via spec `videos-upload-parts.plan.md`)
- **Observations:**
  - **Gap descoberto na entidade `Video` (originada na SI-03.2/03.5):** calcular partes faltantes exige saber o total de partes esperado, mas esse valor (`partCount` do DTO da SI-03.5) nunca tinha sido persistido. Adicionada coluna `part_count` (nova migration `AddPartCountToVideos`) e `VideosService.createDraft` atualizado pra gravá-la — migration aditiva, nenhuma migration existente foi editada.
  - Lookup de posse (`findOwnedVideoOrFail`) extraído como método privado no `VideosService` — vai ser reaproveitado pela SI-03.7 (mesma checagem de owner).
  - Teste e2e do cenário "upload já completo" muda o `status` do vídeo direto via SQL (`UPDATE videos SET status = 'ready'`), já que o endpoint `complete-upload` só existe a partir da SI-03.7.

### SI-03.7 — Endpoint POST /videos/:id/complete-upload (finalização + enfileiramento)
- **Status:** completed
- **Tests:** 16 passing (3 unit + 4 integration + 9 e2e via spec `videos-complete-upload.plan.md`)
- **Observations:**
  - Validação de "partes completas" compara `dto.parts` contra `StorageService.listParts` (contagem + ETag por parte) **antes** de chamar `completeMultipartUpload` — evita depender do erro nativo do S3/MinIO pra mapear pro `errorCode` de domínio.
  - Testes de integração/e2e usam uma fila BullMQ real (`Queue` do pacote `bullmq`, conectada ao Redis real) em vez de mock, seguindo o padrão "Message Queue — Real (Docker)" já documentado em `references/external-systems.md`; `queue.drain(true)` no `beforeEach`/`afterAll` pra isolar os testes.
  - Nome do job definido como `process-video` (constante `JOB_NAMES.PROCESS_VIDEO`) — o Tech Spec só cita o nome conceitual do evento (`video.process`); a fila e o job name em si já existiam decididos (TD-03), o nome literal do job é detalhe de implementação.

### SI-03.8 — Endpoint GET /videos/:id/playback-url
- **Status:** completed
- **Tests:** 16 passing (4 unit + 12 e2e via spec `videos-playback-url.plan.md`; sem integration per Tests table do SI)
- **Observations:**
  - `expiresIn` retornado como `DEFAULT_EXPIRES_IN_SECONDS` (exportado de `StorageService`, 3600s) em vez de recalcular o valor — única fonte de verdade pro tempo de expiração.
  - Endpoint marcado `@Public()` — primeiro endpoint da fase sem guard, já que streaming é aberto a anônimos por design do produto.
  - Testes e2e setam `status: ready` direto via SQL (mesma técnica da SI-03.6), já que o pipeline de processamento real só existe a partir da SI-03.10.

### SI-03.9 — Endpoint GET /videos/:id/download-url
- **Status:** completed
- **Tests:** 19 passing (5 unit + 14 e2e via spec `videos-download-url.plan.md`; sem integration per Tests table do SI)
- **Observations:** nenhuma — SI simétrica à SI-03.8, sem surpresas.

### SI-03.10 — Video Worker (entry point + pipeline de processamento ffmpeg)
- **Status:** completed
- **Tests:** 2 passing (integration — job real via fila BullMQ real + Worker do `bullmq` consumindo, ffmpeg real gerando um vídeo sintético de 1s via `ffmpeg -f lavfi`)
- **Observations:**
  - **Bug pego só na verificação manual (não pelos testes de integração):** `WorkerModule` só registrava `TypeOrmModule.forFeature([Video])`; ao subir o processo real (`docker compose exec video-worker npm run start:worker:dev`), o TypeORM falhou com "Entity metadata for Channel#user was not found" — a relação `Video → Channel → User` precisa de todas as entidades da cadeia registradas no módulo, não só a raiz. Corrigido adicionando `Channel` e `User` ao `forFeature`. Os testes de integração não pegaram isso porque usam `createTestDataSource(ALL_ENTITIES)`, que já lista todas as entidades explicitamente — só o bootstrap real do `WorkerModule` expôs o gap. Verifiquei manualmente subindo o worker de verdade e confirmando o log `"Video Worker started, consuming the video-processing queue."`.
  - Vídeo de teste gerado on-the-fly com o `ffmpeg` do sistema (`ffmpeg -f lavfi -i color=... `) em vez de commitar um binário de fixture.
  - Teste "arquivo inválido" sobe um `.txt` como se fosse vídeo — `ffprobe` falha, `VideoProcessor` captura o erro internamente e marca `status: failed` sem derrubar o Worker (o job BullMQ em si completa normalmente, já que o erro é tratado dentro do `process()`).
  - `docker compose up -d video-worker` confirmado subindo como container separado do `nestjs-api` (mesma imagem, mesmo padrão idle — app iniciado sob demanda via `npm run start:worker:dev`, igual ao `nestjs-api`).
  - **Bug pego só ao planejar um teste manual de 10GB (pós-implementação, antes de abrir o PR):** `StorageService.getObjectBuffer` lia o objeto inteiro pra memória (`Body.transformToByteArray()`) antes de gravar em disco — para um vídeo próximo do limite de 10GB, isso materializaria ~10GB num único `Buffer` no processo do worker, correndo risco real de OOM (a VM do Docker Desktop usada em dev tem ~7.75GB de RAM total, menos que o próprio arquivo). Substituído por `StorageService.downloadObjectToFile`, que faz `pipeline(s3Body, fs.createWriteStream(destPath))` — o objeto nunca é materializado inteiro em memória, é transmitido em stream direto pro disco. `VideoProcessor` atualizado pra usar o novo método. Suíte de integração do processor (vídeo sintético pequeno) e de storage seguem verdes; `getObjectBuffer` foi removido por não ter mais nenhum uso.

## Final Verification (Definition of Done)

- **Unit + Integration:** 164/164 passing (30 suites).
- **E2E:** 66/66 passing (4 suites).
- **`npx tsc --noEmit`:** clean.
- **`npm run lint`:** 0 problems in every file created/meaningfully modified this phase (`test/videos.e2e-spec.ts`, `src/videos/video.processor.ts`, `src/videos/video.processor.integration-spec.ts`, `src/videos/videos.service.integration-spec.ts`). Project-wide `npm run lint` still reports 190 problems (150 errors + 40 warnings), all in files this phase did not author: `test/auth.e2e-spec.ts`, `src/auth/auth.service.spec.ts`, `src/channels/channels.service.{spec.ts,ts}`, `src/common/filters/*.filter.spec.ts`, `src/config/env.validation.integration-spec.ts`, `src/mail/mail.service.integration-spec.ts`. Two touched files (`src/auth/auth.service.integration-spec.ts`, `src/test/create-test-data-source.ts`) also appear in the project-wide report, but `git diff main` confirms each has exactly one line changed this phase (adding `Video` to a test `ALL_ENTITIES` array; adding a `DELETE FROM "videos"` cleanup line) and the flagged lines are untouched pre-existing code. Left as-is per Scope Limits — out-of-scope pre-existing debt, not introduced by this phase.

## Out-of-scope observations (aggregated)

- Pre-existing lint debt (`@typescript-eslint/no-unsafe-*` on untyped `res.body` in supertest responses, `Async arrow function has no 'await'`, an unused var, a `Function` type usage) affects ~11 files from phases 01/02 that this phase did not touch. Fixing it is a separate, project-wide task (likely: type supertest response bodies project-wide, or relax the relevant rules for test files).
- `fluent-ffmpeg` is deprecated on npm but remains the most maintained ffmpeg wrapper for Node; already covered by `phase-03-videos/TD-05`.
- `ChannelsService` has no `findByUserId` method; `VideosService` queries the `Channel` repository directly instead of adding one (out of this phase's module ownership).
