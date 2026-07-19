# AGENTS.md

Agent-facing guide for **deplo** — a self-hosted deploy platform that turns repos and
templates into Docker stacks fronted by Traefik. Read this before writing code, then lean on
the deeper docs it links (this file points; it does not restate them).

- **`CONTEXT.md`** (repo root) — authoritative glossary / ubiquitous language. Single-context repo.
- **`docs/adr/`** — numbered decisions (0001–0009). Contradicting one? Surface it, don't silently override.
- **`docs/api/graphql.md`** — external API reference · **`schema.graphql`** (root) — generated SDL.
- **`docs/agents/`** — `issue-tracker.md`, `triage-labels.md`, `domain.md`.

## Core mission — the north star every feature answers to

**deplo exists to make self-hosting exhaustively simple, Vercel-style.** The user must **never
be required to know Docker or SSH** to get full value out of deplo — that non-requirement is the
whole differentiator from Coolify / Dokploy, which both assume the operator lives in a shell.

Consequences that bind every design and review decision:

- **No feature may push Docker/SSH/YAML knowledge onto the user as a prerequisite.** If a flow
  only works when the user drops to a shell or hand-edits compose, it is unfinished, not done.
  The escape hatch may exist for experts; the *happy path* must not need it.
- **Every feature is tested exhaustively and judged on UX/DX**, not just "does it function."
  "Generally useful, obvious, and safe for a non-expert" is the bar. Half a feature that assumes
  operator expertise is a regression against the mission.
- **Favor derived / live / automatic over manual.** Disaster recovery, backups, secrets, status,
  URLs — the platform should do the operator's job for them, using infrastructure they already
  have (e.g. the fleet itself), not ask them to stand up more (an S3 bucket, an external DB) as a
  precondition.

When weighing a design, ask: *would a competent developer who has never touched Docker or SSH
succeed on the happy path, with the platform doing the operational heavy lifting?* If not,
reconsider.

## This is NOT the Next.js you know

APIs, conventions, and file structure may all differ from your training data. **Read the
relevant guide under `node_modules/next/dist/docs/` before writing any code** and heed
deprecation notices. When instinct disagrees with the installed docs, the docs win. For
**Next.js 16 App Router + React 19** specifically:

- `params` / `searchParams` are **async** — `const { slug } = await props.params;`.
- Route components use the generated `PageProps<"/route">` / `LayoutProps<"/route">` types.
- Start from `01-app`, `03-architecture`, and `index.md` under `node_modules/next/dist/docs/`.

## Architecture — two planes, one inviolable boundary

- **Control plane** (this repo, TypeScript) — UI, GraphQL API, data layer, deploy rendering.
- **deplo-agent** (Go binary, one per host, separate repo `DeploCloud/deplo-agent`) — the ONLY
  thing that runs `docker` / shell / `fs` on any host. Reached over **gRPC + mTLS**.

**THE RULE (ADR-0006): the control plane NEVER touches a Docker socket or the host directly for
a per-app / host-coupled action.** Deploy, build, logs, console, metrics, files, stack
lifecycle, dev containers, tunnels, SSH gateway, backups, S3, volume copy and DB provisioning all
route `UI → GraphQL → lib/data/* → connectAgent(serverId) → agent`.

- `lib/infra/agent-client.ts` `connectAgent(serverId)` is the sole entry (mTLS, cert-fingerprint
  pinned at bootstrap). The Deplo host is itself "agent 0" — **no in-process localhost shortcut**;
  local and remote take the identical path.
- Compose is rendered control-plane-side as **opaque YAML** and shipped to the agent:
  `renderCompose` (single-image) / `buildComposeStack` (multi) / `traefikRouterLabels` (the only
  Traefik label grammar) / `portFor` (ADR-0001, the only port reader). **Never port routing /
  compose / gateway logic into Go.**
- The **agent never holds the encryption key** — the control plane decrypts secrets and sends
  plaintext inside the mTLS RPC (single-image YAML) or a 0600 `--env-file` (compose stack).
- **Fails clearly, no in-process fallback**: a mandatory `Hello` pre-flight; an unreachable agent
  is a hard error, never a silent local build. New RPCs are additive (contract stays `V1`); gate
  host features behind Hello `capabilities[]`.
- **Don't generalize the exceptions:** installed **Plugins** (ADR-0005) are host-managed containers
  where Deplo *does* own the socket (`lib/plugins/runtime.ts`) — a Plugin is not an App.
  `lib/deploy/build.ts` also retains a now-dead local build path + host `ensureNetwork`/`mkdir`;
  the live path passes `skipBuild:true → runAgentDeploy`. Don't mistake the dead path for a
  violation and don't revive it.

## Tech stack

Next.js 16 App Router · React 19 · TypeScript (strict) · Tailwind v4 (CSS-first) · shadcn/ui
(new-york) · Pothos code-first GraphQL over graphql-yoga · Drizzle ORM · Postgres · **Bun**
(package manager + runtime). Better Auth is configured in parallel but is **NOT the live login
path** (see Persistence). Deploy execution is the Go agent over gRPC/mTLS.

## Project layout

- `app/(dashboard)/` — RSC pages. Overview `page.tsx` is the one grid (projects → folders →
  apps) with drill-ins via `?project=&env=&folder=&q=&view=`. Sections: `apps/[slug]`,
  `deployments`, `logs`, `monitoring`, `storage`, `variables`, `members`, `activity`, `apps`,
  `templates`, `servers`, `new`, `settings/*`. `app/(auth)/` — login/setup.
- `app/api/graphql/route.ts` — the single API endpoint. Other `app/api/*/route.ts` are the REST exceptions (below).
- `lib/data/*` — data layer (`import "server-only"`), **the security boundary**.
- `lib/graphql/*` — Pothos builder, context, schema, and `types/*` domain modules.
- `lib/deploy/*` — compose/label/port rendering · `lib/infra/*` — agent client, gateway ·
  `lib/agent/*` — mTLS PKI + generated ts-proto stubs.
- `lib/db/*` — Drizzle client + `schema/` (`control-plane`, `auth`, `scheduler`, `columns`).
- `components/` — UI: `ui/` (shadcn primitives), `layout/`, feature folders.

## Commands (Bun) & environment

- `bun install` · `bun run dev` · `bun run build` · `bun run lint` (eslint).
- **Required env to boot:** `DEPLO_DATABASE_URL` (Postgres — the app **fail-fasts at module
  load** if unset), `DEPLO_SECRET` (≥16 chars; derives every crypto key), `DEPLO_PUBLIC_URL`
  (sets the cookie `secure` flag + Better Auth https). See `.env.example`.
- **Tests:** `bun run test` — `node --test` + `tsx`, in-process against **pglite** (not
  Jest/Vitest, not real Postgres). Seed via `makeTestDb` + `__setTestDb`/`__resetTestDb`, drive
  inside `runWithIdentity({userId, teamId})`, use `*-test-helpers.ts` seeders (named to dodge the
  `*.test.ts` glob). `server-only-shim.cjs` no-ops the `server-only` guard.
- **DB (drizzle-kit, needs `DEPLO_DATABASE_URL`):** `bun run db:push` (dev, apply directly),
  `db:generate` (emit SQL + snapshot + `_journal.json` — commit all three; tests replay the
  journal), `db:migrate` (prod). Migrations **auto-apply at boot** via the `instrumentation.ts`
  hook (`lib/db/migrate.ts` → Drizzle migrator, idempotent, re-throws on failure); `db:migrate`
  stays available to apply them out-of-band.

## API layer (Pothos + yoga)

Single endpoint `app/api/graphql/route.ts` (thin) → `lib/graphql/yoga.ts`. One `SchemaBuilder`
(`lib/graphql/builder.ts`) with `@pothos/plugin-scope-auth`.

- **Add a query/mutation** in `lib/graphql/types/<domain>.ts` via `builder.queryFields` /
  `mutationFields`; object types via `builder.objectRef<DTO>(...).implement(...)`, inputs via
  `builder.inputType(...)`. **Resolvers stay THIN** — delegate straight to a `lib/data/*`
  function. There is **no `lib/actions` dir and no `"use server"`**; former server actions were
  folded into resolvers.
- **A new module registers only if you add `import "./types/<name>";` to `lib/graphql/schema.ts`**
  (alphabetical, side-effect import).
- **Regenerate SDL after touching any `types/*`:**
  `node --require ./lib/test/server-only-shim.cjs --import tsx scripts/gen-schema.ts`.
  (The bare `bunx tsx scripts/gen-schema.ts` this used to document **fails** with
  `MODULE_NOT_FOUND: server-only` — the builder pulls in `lib/data/*`, which is
  `server-only`, and that package's real entrypoint throws outside a Next build.
  The shim is the same one the test runner preloads.)
  `schema.graphql` is generated output — **never hand-edit**, and nothing auto-runs it (no hook,
  no CI drift check).
- Validation = **Pothos arg requiredness** + hand-rolled cleaners (`cleanName`,
  `normalizeHexColor`, `validateUsername`). Zod lives in only two files (`types/auth.ts`,
  `lib/plugins/manifest.ts`) — don't spread it.
- Auth mutations (`login`/`logout`/`completeSetup`, `types/auth.ts`) are intentionally **public**
  (no `authScopes`) and keep their rate-limiting; the route owns cookie writes.
- graphql-armor limits (depth 12 / aliases 30 / cost 5000) live only in `yoga.ts`.
- **Stays REST** (`app/api/*/route.ts`, cookie auth via `getCurrentUser()`, no bearer token):
  `apps/[id]/upload` (raw archive), `.../logs` (SSE), `.../attach`, `databases/[id]/logs` (SSE),
  `databases/[id]/attach` (SSE siblings of the app routes — reuse `lib/logs/session.ts` +
  `lib/attach/session.ts`), `github/webhook|callback|setup`, `auth/[...all]`, `agent/bootstrap`,
  `graphql/playground`, `health`, `node-versions`, `railpack-versions`, `registry/images`.

## Data & mutations (the security boundary)

- **Reads:** `lib/data/*`, wrapped in React `cache(async …)`, call `requireActiveTeamId()` and
  filter every query by `teamId`. **Never accept `teamId` or `userId` as a parameter** — resolve
  internally. Never select `*_enc` / `*_hash` columns into a DTO.
- **Mutations:** `const { teamId, userId } = await requireCapability(cap);` (don't also call
  `requireActiveTeamId`). Scope every row-targeting `UPDATE`/`DELETE` with
  `and(eq(t.id, id), eq(t.teamId, teamId))` so a cross-team id hits 0 rows; confirm via
  `.returning()` length or an `xInTeam` probe. ids via `newId("prefix")`, timestamps via
  `nowIso()`; multi-row writes in `getDb().transaction`.
- **Keep BOTH gates (defense in depth):** the field `authScopes` (introspectable contract) AND the
  `requireCapability` / `requireInstanceAdmin` call inside the `lib/data` function (the real
  boundary — `lib/graphql/context.ts` is a convenience snapshot, not the boundary). Resources
  under a **folder** need a second gate: `await requireFolderCapabilityForApp(appId, cap)`.
- Auth helpers: `getCurrentUser()` (nullable), `assertUser()` (**throws** — resolvers/data),
  `requireUser()` (**redirects** — RSC/pages). `recordActivity(...)` runs **outside** any open
  transaction (own connection; deadlocks pglite otherwise) and is fire-and-forget.
- **Capabilities (8):** `view` (always-on floor), `deploy`, `manage_domains`, `manage_env`,
  `manage_files`, `manage_infra`, `manage_members`, `manage_team`; plus instance-wide
  `instanceAdmin` and the orthogonal grants `canExposePorts` / `canMountHostVolumes`. Roles are
  presets. **Creating** a folder/project/app is gated on `deploy`, not `manage_team`.
- **id prefixes not to confuse:** `prc_` = Project *container*, `prj_` = **App** (the deployable
  app, legacy mint); `environ_` = Environment, `env_` = env-**var** row; `deplo_` = raw bearer
  secret (sha256 at rest).

## Persistence, secrets, auth

- **Postgres is the only control-plane store** (`lib/db/pg.ts`, one bounded pool). There is **no
  JSON/document store** — the old `deplo_state` JSONB was fully normalized into ~55 tables; **never
  add a JSONB column** (nested → child table, list → ordered/junction table). `*_at` columns use
  the `isoTimestamptz` custom type, never plain `timestamp` (Better Auth tables aside).
- **`DEPLO_SECRET` derives every key** via `deriveKey(purpose)`: `secrets` (AES-256-GCM), `session`
  (HMAC), `state` (CSRF), `agent-mtls-ca` (CA seed). Rotating it is destructive — all `*_enc`
  become undecryptable, all sessions invalid, every agent cert re-mints. No key versioning;
  `decryptSecret` fails **closed** to `""`.
- **Secrets are write-only / masked with no reveal path for the client.** `*_enc` ciphertext is
  never projected into DTOs; masked values decrypt only via `manage_env`-gated `reveal*` calls or
  at the deploy edge. **Never add a "show secret" affordance.** Passwords are scrypt + constant-time.
- The **live** auth path is the built-in cookie `deplo_session` (`lib/auth.ts`, stateless HMAC;
  `deplo_team` carries the active team). Better Auth (`/api/auth/*`) runs in parallel with its own
  tables — don't assume it handles login.

## UI conventions

- **Default is RSC**; `"use client"` is leaf-ish (state/effects/forms). RSC pages `await`
  `lib/data`/`lib/auth`/`lib/membership` and pass plain props down.
- **Mutations go through GraphQL, not server actions.** Use `lib/graphql-client.ts` (`gql`,
  `gqlAction`) and the `useGraphqlMutation` hook (`useTransition` + auto `router.refresh()`).
  Inline the query string tagged `/* GraphQL */`. **No `revalidatePath`** — `router.refresh()`
  re-runs RSC reads; subscriptions via `gqlSubscribe` (SSE).
- **Toasts:** `import { toast } from "sonner"`; surface the server's message verbatim
  (`toast.error(res.error)`), don't invent generic copy.
- **Field help lives in the tooltip:** `FieldLabel info={…}` / `InfoTip` (`components/ui/info-tip.tsx`)
  — don't duplicate it as helper text below the input.
- **Status is shown LIVE** via `AppStatusBadge`/`AppStatusDot` (a `useLiveStatus`
  subscription), not the raw stored `status`. `idle`/`stopped` render **grey ("Stopped")**; red is
  reserved for `error`/`failed`.
- **Tailwind v4 is CSS-first — no `tailwind.config`.** Add tokens in `app/globals.css`
  (`:root`/`.dark` + `@theme inline`); **never hardcode colors** — use token utilities
  (`bg-background`, `text-muted-foreground`). App defaults to dark; theme is a **custom provider**
  (`useTheme` from `@/components/theme-provider`, not next-themes), zero-flash via the `theme`
  cookie read in `app/layout.tsx`. `cn()` from `@/lib/utils`; the only path alias is `@/* → ./*`.

## UX philosophy to preserve

- **Everything is scoped to the active team** (topbar switcher, `deplo_team` cookie). **Servers are
  the one shared cross-team resource** — never team-scope server records.
- **A Project is an "advanced folder" with an environment dropdown — it has no page of its own.**
  It is browsed only on the Overview drill-in (`app/(dashboard)/projects/*` are redirect stubs);
  each Environment owns its own Apps and shared vars.
- **Every mutating action is capability-gated and enforced server-side.** UI `hasCapability` checks
  are cosmetic (hide/disable); the authoritative gate is `requireCapability` in the data layer.
- Secrets are write-only, status is live, Preview/app URLs are computed — favor derived-and-live
  over stored-and-stale.

## Vocabulary discipline

Use **CONTEXT.md's exact terms**; avoid its banned synonyms. **App** (the deployable unit, never
"service"/"project"; a bare compose "service" is a different thing) · **Project** (the
container-folder, never container/group/folder) · **Capability** (never permission/scope/grant) ·
**server agent** / "the owning server" (never bare agent/node/worker/daemon) · **Plugin** (an
installed catalog feature à la MCP server, never an App) · **active team** (never current/selected) ·
**Environment** (never "env target"). If a concept isn't in the glossary, you're probably inventing
language — reconsider, or note the gap.

## Working rules

- **Issues & PRDs = GitHub Issues in `IdraDev/deplo` via the `gh` CLI** (`docs/agents/issue-tracker.md`);
  triage with the five canonical labels (`docs/agents/triage-labels.md`).
- Check `docs/adr/` before working an area; flag contradictions explicitly rather than overriding.
- **Commits = Conventional Commits with a scope**, imperative summary (`feat(apps): …`,
  `fix(auth): …`). Branch off `main` before committing.
- **Stop what you start — including :3000.** Any build or server you launch to work a task (dev
  server, test server, watcher, Playwright harness) MUST be stopped once the task is 100% done —
  never leave it running in the background. **This includes the control plane on :3000: if YOU
  (re)started it — e.g. rebuilt + relaunched it to verify a change — you MUST stop that process
  when done (`kill <the PID you spawned>`), never leave a detached `setsid`/`nohup` control plane
  behind.** The owner runs :3000 themselves, attached to their own terminal, and a background
  copy you spawned takes it out of their hands. Only a :3000 that was already running before you
  touched it (and that you never restarted) is meant to stay up — don't kill that one. Kill the
  specific PID you spawned; **never `pkill -f next-server`** (it kills deployed apps).
