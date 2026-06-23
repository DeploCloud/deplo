# Backups & Restore — Databases + Projects, to S3

> **Status:** decisions locked via `/grill-with-docs`. Architecture recorded in
> [ADR-0007](../../adr/0007-backups-route-through-the-owning-agent-databases-become-agent-provisioned.md);
> domain terms (**Database**, **Backup**, **Backup run**) in [CONTEXT.md](../../../CONTEXT.md).
> This plan is the implementation breakdown; the ADR is the rationale.

## Context

The user wants a **real, working backup-and-restore system** that pushes to S3-compatible
storage. Today the entire backup feature is **stubbed**:

- `runBackup()` ([lib/data/backups.ts:79](../../../lib/data/backups.ts#L79)) just flips
  `lastStatus` to `"success"` — nothing is ever dumped or uploaded.
- `testS3()` ([lib/data/s3.ts:74](../../../lib/data/s3.ts#L74)) fakes the connectivity check.
- There is **no restore**, **no record of individual backup runs/artifacts** (only schedule
  metadata), **no scheduler** (the cron `schedule` is stored but never executed), and backups
  can only target a `databaseId` — there is **no project backup**.

The user wants:
1. **Fully working end-to-end** backups & restore (real dumps, real S3 upload, real artifact
   listing, real restore).
2. **Project backups** capturing: **persistent volumes + project files dir + compose/env
   snapshot** (NOT linked databases — those are backed up as databases).
3. A new **Backups tab inside each project**.
4. **Restore in-place** with a typed confirmation.
5. A **prerequisite step: make databases agent-provisioned like projects** — server selection
   at DB creation, provisioned via the **agent** (not local docker) — so that **all**
   backup/restore work routes through the owning server's **agent** via new **Backup /
   Restore RPCs**.

### Key architectural facts (verified against the code)

- **Agent boundary**: every server (the Deplo host included) is reached uniformly over mTLS
  via `connectAgent(serverId)` → [lib/infra/agent-client.ts](../../../lib/infra/agent-client.ts).
  RPCs are defined in the **separate `DeploCloud/deplo-agent` repo** (`../deplo-agent`,
  `proto/agent.proto`); this repo carries only the generated client
  [lib/agent/gen/agent.ts](../../../lib/agent/gen/agent.ts). **The Go agent + proto cannot be
  built/run in this environment** — agent-side work is delivered as a contract (ADR-0007 +
  proto) + a regenerated client (`make proto` in the agent repo), gated behind a Hello
  capability.
- **`Reroute` is already a "provision stack"**: `deplo-agent` `Reroute` writes
  `<stackDir>/<slug>.yml` and runs `docker compose -p deplo-<slug> up -d --remove-orphans`,
  idempotently (creates if absent). **So Step 0 needs NO new `ProvisionStack` RPC** — it
  reuses `Reroute` for create, `StartStack`/`StopStack` for lifecycle.
- **`DestroyStack` does `down` WITHOUT `-v`** and leaves the compose file. Fine for an app;
  it orphans a DB's data volume. **The one new stack-RPC affordance Step 0 needs is a
  `removeVolumes` flag on `DestroyStack`.**
- **Databases already have `serverId`** ([lib/types.ts:827](../../../lib/types.ts#L827)) but
  `createDatabase()` hardcodes `read().servers[0]`
  ([lib/data/databases.ts:87](../../../lib/data/databases.ts#L87)) and calls `docker(...)`
  directly. Step 0 is "stop hardcoding + route lifecycle to the agent."
- **No S3 SDK in either repo, no restore code anywhere.** Decision: an **S3 client in the
  agent** (`minio-go`) does the transfer; the control plane passes decrypted creds over mTLS.
- **`DeploData` is a single JSONB document** (Postgres in prod — the only real backend; local
  `.deplo/data.json` is dev-only) via `read()/mutate()` ([lib/store.ts](../../../lib/store.ts)),
  rewritten whole on each mutate. New collections are added as arrays defaulted in
  `normalize()` — **no SQL migration** for `backupRuns`. The **only** relational addition is
  the scheduler lease (a real cross-process mutex the JSONB store can't provide).
- **GraphQL** uses Pothos `builder`; each domain file under
  [lib/graphql/types/](../../../lib/graphql/types/) self-registers, imported in
  [lib/graphql/schema.ts](../../../lib/graphql/schema.ts). `schema.graphql` is generated output.
- **Capability** for all of this is `manage_infra` (already used by backups, db, s3).
- **Project persistent state has three shapes** (see [VolumeMount](../../../lib/types.ts#L531)):
  named volumes (`hostVolumeName(slug,name)` = `deplo-<slug>-<name>`, single-container
  projects), compose-stack volumes (declared in the project's own YAML — must be parsed from
  `readStack`), the project files dir (`<stacks>/files/<slug>`), and host bind mounts. **Host
  bind mounts are EXCLUDED from backup** (shared cross-tenant paths, outside Deplo).
- **`instrumentation.ts` already exists** and runs once per server boot (Node runtime only);
  it's where the scheduler tick starts. `globalThis` singletons via `Symbol.for(...)` are the
  established pattern ([lib/store.ts:83](../../../lib/store.ts#L83)). `next start` is
  single-process.
- **`ConfirmAction`** ([components/shared/confirm-action.tsx](../../../components/shared/confirm-action.tsx))
  is **not** typed today (yes/no only) — the restore's typed confirmation needs a typed
  variant.

### Locked decisions (from the grilling)

| Topic | Decision |
| --- | --- |
| Step 0 sequencing | **Prerequisite** — DB-on-agent before backups. |
| DB provisioning RPC | **Reuse `Reroute`** (no `ProvisionStack`); lifecycle via `StartStack`/`StopStack`. |
| DB delete | **`DestroyStack(removeVolumes: true)`** (one new proto flag; `down -v` + rm file). |
| S3 transfer | **S3 client in the agent** (`minio-go`), multipart streaming, no temp file. |
| DB restore overwrite | **Drop-and-recreate per engine, guaranteed by dump format** (pg `-Fc`/`--clean`, mysql `--add-drop-table`, mongo `--drop`). |
| Project backup scope | **Named + compose-stack volumes (parsed from YAML) + files dir + compose/env snapshot; host mounts excluded.** |
| Project restore | **Wipe + untar in-place, full data + config (Reroute snapshot), stop/start, typed-confirm, downtime+irreversibility surfaced, no auto-snapshot.** |
| Scheduler | **`instrumentation.ts` tick + `globalThis` singleton; lease via Postgres advisory-lock/dedicated row** (degrades in-process in dev JSON-file). |
| `BackupRun` storage | **Array in `DeploData`** (no SQL migration) + retention prune + per-target cap. |
| `testS3` | Real, via new **`S3Check`** RPC on any agent advertising `backup`. |
| `ListBackupArtifacts` | **Deferred** (BackupRun is the source of truth). |
| Capability gating | `"backup"` in Hello + preflight + **`AgentBackupUnsupportedError`**. |
| Target deletion | **Explicit choice**: keep S3 artifacts (default) or delete too (via `S3Delete`). |
| Delivery order | **Control-plane first**, gated on capability; proto contract as ADR-0007 in parallel. |

### Cross-repo contract (`../deplo-agent`, cannot build here)

| RPC | Type | Status |
| --- | --- | --- |
| `Backup(BackupRequest) → stream BackupEvent` | server-stream | **done** (Step 2) |
| `Restore(RestoreRequest) → stream RestoreEvent` | server-stream | **done** (Step 2) |
| `S3Check(S3CheckRequest) → S3CheckResponse` | unary | **done** (Step 2) |
| `S3Delete(S3DeleteRequest) → S3DeleteResponse` | unary | **done** (Step 2; backs retention + delete-with-artifacts) |
| `DestroyStack` + `removeVolumes` field | unary | **done** (agent commit `0167147`) |
| `"backup"` in `HelloResponse.capabilities` | — | **done** (Step 2) |
| S3 client dependency (`minio-go`) | — | **done** (Step 2) |

> `ProvisionStack` / `ListBackupArtifacts` from earlier drafts are **dropped/deferred**.
> Step 2 also shipped the Go impl + unit/E2E tests in `../deplo-agent` and the
> regenerated TS client ([lib/agent/gen/agent.ts](../../../lib/agent/gen/agent.ts))
> + control-plane wiring ([agent-client.ts](../../../lib/infra/agent-client.ts):
> `backup`/`restore`/`s3Check`/`s3Delete`, `BACKUP_DEADLINE_MS`,
> `AgentBackupUnsupportedError`, `connectBackupAgent`/`mapBackupUnsupported`).
> All six DB engines (postgres/mysql/mariadb/mongodb/redis/clickhouse) + the
> **project-volume** round-trip are E2E-verified (overwrite proven). Step 2 also
> fixed a pre-existing bug in [database-compose.ts](../../../lib/deploy/database-compose.ts):
> the data volume was mounted at `/var/lib/<type>` for every engine, but redis
> (`/data`), mongodb (`/data/db`) and mariadb (`/var/lib/mysql`) write elsewhere —
> so their data wasn't persisted and a restore would land outside the volume. Now
> mapped per-engine (`DB_DATA_DIRS`). The compose already sets
> `restart: unless-stopped`, which the redis restore's reload depends on.

### Per-engine dump/restore format (the Backup⇄Restore contract)

| Engine | Dump | Restore | Object ext |
| --- | --- | --- | --- |
| postgres | `pg_dump -Fc` | `pg_restore --clean --if-exists` | `.dump.gz` |
| mysql / mariadb | `mysqldump --add-drop-table --databases` | `mysql` | `.sql.gz` |
| mongodb | `mongodump --archive` | `mongorestore --drop --archive` | `.archive.gz` |
| redis | `redis-cli --rdb -` (RDB to stdout) | file-swap + `SHUTDOWN NOSAVE` reload | `.rdb.gz` |
| clickhouse | per-table `SHOW CREATE` + `FORMAT SQLInsert` → SQL script | `clickhouse-client --multiquery` | `.sql.gz` |
| project | `tar` volumes + files + snapshot | wipe + untar + `Reroute` | `.tar.gz` |

> Object-key convention: `deplo/<teamId>/<kind>/<targetId>/<ISO-timestamp>.<ext>`.
>
> **Compression (Step 2 decision):** dumps/archives are **gzip**-compressed
> in-process by the agent (Go stdlib `compress/gzip`), so the object extension is
> `.gz`, not the earlier draft's `.zst` — no external compressor dependency, and
> the same stream is gunzipped on restore.
>
> **All six engines are real + E2E-verified** (drop-and-recreate overwrite proven
> against live containers): postgres, mysql, mariadb, mongodb, redis, clickhouse.
> Two engines use a DEDICATED path rather than the single-`docker exec`-pipe shape:
> **redis** (an RDB can't be piped to a restore tool's stdin — restore is disable-
> save → FLUSHALL → write `/data/dump.rdb` → `SHUTDOWN NOSAVE` → supervisor reload,
> so the DB container MUST have a restart policy) and **clickhouse** (a database is
> many tables — dump assembles a per-table DROP/CREATE/INSERT SQL script, restore
> replays it via `--multiquery`).

---

## Step 0 (prerequisite) — Databases become agent-provisioned

**Goal:** databases get a chosen server and are provisioned **via the agent**, so the same
agent path serves both DB and project backups.

- **Create flow** ([lib/data/databases.ts](../../../lib/data/databases.ts)):
  - `createDatabase()` accepts `serverId` (validated reachable + provisioned, in team scope;
    default to the sole server when there is one). Stop reading `servers[0]`.
  - Replace local `provisionDatabase()` (`mkdir`+`writeFile`+`docker compose up`) with a
    `connectAgent(serverId).reroute({ slug: "db-<name>", composeYaml:
    generateDatabaseCompose(...), env: {}, mounts: [] })` call. DB keeps DNS name `db-<name>`
    on the `deplo` network — connection strings unchanged.
  - `setDatabaseRunning()` → `startStack`/`stopStack`; `deleteDatabase()` →
    `destroyStack({ slug, removeVolumes: true })` (NEW flag). Drop the local
    `dbStackFile(...)` reads — the file now lives on the agent.
  - **Back-compat**: existing DB rows already carry a `serverId`; their stacks live on that
    host (now an agent), addressable by the same `db-<name>` slug.
- **GraphQL** ([lib/graphql/types/database.ts](../../../lib/graphql/types/database.ts)): add
  `serverId` to `CreateDatabaseInput` (the `Database` type already exposes `serverId`).
- **UI** ([components/storage/create-database.tsx](../../../components/storage/create-database.tsx)):
  add a **Server `<Select>`** (mirror the destination select in `create-backup.tsx`); pass
  `servers` from [storage/page.tsx](../../../app/(dashboard)/storage/page.tsx) (it does NOT
  fetch servers yet — add it).
- **Agent-gated**: the `removeVolumes` flag must ship in `deplo-agent` `DestroyStack`; until
  then delete falls back to volume-orphaning `down` and we log it.

---

## Step 1 — Data model: backup targets + run history

Extend [lib/types.ts](../../../lib/types.ts):

- **`Backup`** (schedule) — generalize the target:
  - Add `targetKind: "database" | "project"`.
  - Add `projectId: ID | null` (alongside existing `databaseId: ID | null`).
  - Keep `destinationId`, `schedule`, `retentionDays`, `enabled`, `lastRunAt`, `lastStatus`.
- **New `BackupRun`** — one record per executed backup:
  ```ts
  interface BackupRun {
    id: ID; teamId: ID; backupId: ID | null;   // null = ad-hoc run
    targetKind: "database" | "project";
    databaseId: ID | null; projectId: ID | null;
    destinationId: ID;
    objectKey: string;        // deplo/<team>/<kind>/<target>/<ts>.<ext>
    sizeBytes: number;
    status: "running" | "success" | "failed";
    error: string | null;
    startedAt: string; finishedAt: string | null;
  }
  ```
- Add `backupRuns: BackupRun[]` to `DeploData` and seed it in `buildSeed()` so `normalize()`
  back-fills it. **No SQL migration** (it's part of the JSONB document).
- **Scheduler lease** — the one relational addition: a Postgres advisory lock or a small
  `scheduler_lease` row (Drizzle migration under [lib/db/migrations/](../../../lib/db/migrations/)),
  with owner + heartbeat. In file-backend dev it degrades to an in-process `globalThis` lock.

---

## Step 2 — Agent RPCs: Backup, Restore, S3Check, S3Delete (contract) ✅ DONE

> **Built here, not just specced.** The PLAN assumed the Go agent + proto could
> not be built in this environment. They can: Go 1.26 + `protoc` +
> `protoc-gen-go`/`-grpc` + ts-proto are all present, so Step 2 shipped a **full
> Go implementation + unit tests** (`go build`/`vet`/`test` all green) and the
> stubs were **regenerated on both sides** (`make proto`), not left as a paper
> contract. `DestroyStack.removeVolumes` was already done earlier (agent commit
> `0167147`). Decisions: dumps run via `docker exec` into the DB container; the
> S3 transfer uses `minio-go`; compression is in-process **gzip** (`.gz`).

In `../deplo-agent` add to `proto/agent.proto` + the Go impl, then **regenerate**
[lib/agent/gen/agent.ts](../../../lib/agent/gen/agent.ts) here (`make proto`). New/changed:

- **`Backup(BackupRequest) → stream BackupEvent`** — `kind` (DATABASE|PROJECT); DB descriptor
  (`container`, `dbType`, `dbName`, `user`) OR project descriptor (`slug`, `volumeNames[]`,
  `includeFiles`, `composeYaml`, `envSnapshot`); plus `s3 { endpoint, region, bucket,
  accessKey, secretKey, objectKey }`. DB → `docker exec` the engine's dump tool (per the
  format table) piped to compression, streamed to S3 via **multipart PUT (`minio-go`)**.
  Project → `tar` the named + compose-stack volumes (throwaway helper container mounting
  them) + the files dir + the compose/env snapshot, compress, upload. Returns
  `{ objectKey, sizeBytes }`. **Host bind mounts excluded.**
- **`Restore(RestoreRequest) → stream RestoreEvent`** — pull `objectKey`; DB → restore per
  the format table (drop-and-recreate). Project → **stop stack → wipe + untar volumes +
  files → `Reroute` the snapshot compose/env (restarts the stack)** = full data + config,
  in-place. The stream must clearly report a restart failure (e.g. snapshot image gone).
- **`S3Check(...)`** — HEAD/list the bucket; makes `testS3()` real.
- **`S3Delete(...)`** — delete objects by key/prefix; backs retention + delete-with-artifacts.
- **`DestroyStack` + `removeVolumes`** — `down -v` + remove compose file when set.
- **Hello capability**: advertise `"backup"` in `HelloResponse.capabilities`
  ([lib/agent/gen/agent.ts:324](../../../lib/agent/gen/agent.ts#L324)). Control plane
  preflights it (like `SELF_UPDATE_CAPABILITY` in
  [agent-client.ts:1012](../../../lib/infra/agent-client.ts#L1012)) and surfaces a clear
  "update the agent" message via a new `AgentBackupUnsupportedError` when absent.

**Client wiring** ([lib/infra/agent-client.ts](../../../lib/infra/agent-client.ts)): add
`backup(req)` / `restore(req)` (async generators over `streamEvents`, reusing the bridge) and
`s3Check(...)` / `s3Delete(...)` to the `AgentConnection` interface + `dial()` impl, mirroring
`deploy`/`reroute`. Add a long `BACKUP_DEADLINE_MS`. Extend the `destroyStack` wrapper with
the `removeVolumes` flag.

---

## Step 3 — Data layer: real execution + restore + runs

[lib/data/backups.ts](../../../lib/data/backups.ts):

- `createBackup()` — accept `targetKind` + `projectId`; validate target + destination belong
  to the team (mirror existing checks).
- `runBackup(id)` — **real**:
  1. Load backup + destination; **decrypt** S3 creds (`decryptSecret`).
  2. Resolve the **owning server** (DB's `serverId`, or project's `serverId`).
  3. Append a `BackupRun` (`status:"running"`), set schedule `lastStatus:"running"`.
  4. `connectAgent(serverId)`; preflight `backup` capability; `conn.backup(req)`; consume to
     the terminal result.
  5. Success → update the `BackupRun` (`success`, `objectKey`, `sizeBytes`, `finishedAt`) +
     schedule `lastRunAt`/`lastStatus`. Failure → `failed` + `error`.
  6. **Retention**: prune `BackupRun`s + S3 objects (`conn.s3Delete`) older than
     `retentionDays` for this backup, plus a per-target run cap.
  7. `recordActivity("backup", …)`.
- `runProjectBackup(projectId)` / ad-hoc run (no schedule) → shares the executor with
  `backupId: null`.
- `restoreBackup(runId)` — load `BackupRun`, decrypt creds, resolve server, `conn.restore(req)`,
  stream to completion, record activity. Guarded by `manage_infra` + (UI) typed confirmation.
- `listBackupRuns({ projectId?, databaseId? })` — for the UI artifact lists.
- [lib/data/s3.ts](../../../lib/data/s3.ts): `getS3WithSecrets(id)` (server-only, decrypted
  creds for the executor); make `testS3()` real via `conn.s3Check(...)` on any reachable agent
  advertising `backup`.
- **Project descriptor builder**: named volumes via `hostVolumeName`; compose-stack volumes
  **parsed from the rendered YAML** (`readStack(slug)` is the source of truth for host volume
  names — render uses `name: hostVolumeName(...)`); files-dir slug; compose/env snapshot (env
  secrets stay encrypted in the snapshot). **Host mounts excluded.**

---

## Step 4 — GraphQL surface

- [lib/graphql/types/backup.ts](../../../lib/graphql/types/backup.ts):
  - Extend `Backup` + `CreateBackupInput` with `targetKind` / `projectId`.
  - New `BackupRun` object type + `BackupRunStatus` enum.
  - Queries: `backupRuns(projectId, databaseId)`; keep `backups`.
  - Mutations: `runProjectBackup(projectId, destinationId)` (ad-hoc), `restoreBackup(runId)`;
    keep `createBackup/runBackup/toggleBackup/deleteBackup`.
- [lib/graphql/types/database.ts](../../../lib/graphql/types/database.ts): add `serverId` to
  `CreateDatabaseInput`.
- `schema.graphql` regenerates from the Pothos build.

---

## Step 5 — UI: project Backups tab + storage page + typed confirm

- **Typed confirmation**: add a typed variant to
  [components/shared/confirm-action.tsx](../../../components/shared/confirm-action.tsx) (type
  the slug/name to enable confirm) — used by every restore and by delete-with-artifacts.
- **New project tab "Backups"**:
  - Route `app/(dashboard)/projects/[slug]/backups/page.tsx` (server component; mirror
    [environment/page.tsx](../../../app/(dashboard)/projects/[slug]/environment/page.tsx)):
    gate on `manage_infra`, fetch project + its backup schedules + `backupRuns` + team S3
    destinations; render a client manager. Note Next 16: `params` is a `Promise` — `await` it.
  - Register the tab in [project-tabs.tsx](../../../components/projects/project-tabs.tsx)
    (add a `canBackup`/`manage_infra` prop set from
    [layout.tsx](../../../app/(dashboard)/projects/[slug]/layout.tsx) via `hasCapability`).
  - `components/projects/project-backups.tsx`: "Back up now" (`runProjectBackup`), a schedule
    editor (reuse `createBackup` with `targetKind:"project"`), and an **artifacts table**
    (timestamp, size, status, **Restore** with the typed confirm; UI warns of downtime +
    irreversibility).
- **Storage page** ([app/(dashboard)/storage/page.tsx](../../../app/(dashboard)/storage/page.tsx)):
  - Fetch `servers` too.
  - `create-backup.tsx`: target-kind toggle (Database | Project) + project select.
  - `backup-row.tsx`: show target (db or project), real `lastStatus` (`running` spinner), a
    **Restore** entry listing recent runs.
  - `create-database.tsx`: add the **server select** (Step 0).
  - On DB/project delete: prompt **keep vs delete S3 artifacts** (delete branch → `S3Delete`).

---

## Step 6 — Scheduler (so cron schedules fire)

- A `globalThis` singleton (`Symbol.for("deplo.backup.scheduler")`) started from
  `instrumentation.ts` `register()` (Node runtime only — guard `NEXT_RUNTIME`). Once per
  minute it reads enabled `backups`, evaluates each `schedule` (cron) against now, and for due
  ones **claims the lease** (Postgres advisory lock / `scheduler_lease` CAS) before invoking
  `runBackup`. Use a tiny cron matcher (`croner` or a ~30-line 5-field evaluator).
- **Concurrency / crash recovery**: skip a backup whose lease is held; a lease whose heartbeat
  is stale (e.g. > 2h) is considered crashed and re-armed (so a dead run never blocks forever).
  In dev (no Postgres) the lock is in-process; `next start` is single-process so that is safe.

---

## Files to create / modify (representative)

**Create**
- `app/(dashboard)/projects/[slug]/backups/page.tsx`
- `components/projects/project-backups.tsx`
- `lib/backups/scheduler.ts` (+ cron matcher) (Step 6)
- `lib/db/migrations/000X_scheduler_lease.sql` (Drizzle — lease only)
- `docs/adr/0007-…md` ✅ (done)

**Modify**
- `lib/types.ts` (Backup target fields, `BackupRun`, `DeploData.backupRuns`)
- `lib/seed.ts` / `normalize()` path (seed `backupRuns`)
- `lib/data/backups.ts`, `lib/data/s3.ts`, `lib/data/databases.ts`
- `lib/infra/agent-client.ts` (backup/restore/s3Check/s3Delete + `destroyStack.removeVolumes`
  + capability/error + `BACKUP_DEADLINE_MS`)
- `lib/agent/gen/agent.ts` (regenerated from the deplo-agent proto)
- `lib/graphql/types/backup.ts`, `lib/graphql/types/database.ts`
- `components/storage/{create-backup,backup-row,create-database}.tsx`
- `components/shared/confirm-action.tsx` (typed variant)
- `components/projects/project-tabs.tsx`, `app/(dashboard)/projects/[slug]/layout.tsx`
- `app/(dashboard)/storage/page.tsx`
- `instrumentation.ts` (start the scheduler)
- `CONTEXT.md` ✅ (Database / Backup / Backup run terms added) + regenerated `schema.graphql`

**Cross-repo (cannot build here)** — `../deplo-agent`
- `Backup`, `Restore`, `S3Check`, `S3Delete` RPCs; `DestroyStack.removeVolumes`; `"backup"`
  Hello capability; `minio-go` dependency. Then `make proto` to regenerate the TS client.

---

## Verification

1. **Typecheck/lint/tests**: `npm run lint && npx tsc --noEmit`; `node --test` for affected
   `lib/**`. Unit tests for: the cron matcher, the object-key builder, retention pruning, the
   project-descriptor builder (named + compose-stack volume resolution, host-mount exclusion),
   and the lease CAS.
2. **DB-on-agent (Step 0)**: create a DB choosing a server; confirm the container comes up on
   that server's agent (`readStack`/console), connection string unchanged, start/stop/delete
   route through the agent, and delete reclaims the data volume (`removeVolumes`).
3. **DB backup**: with a real S3 destination, "Run now" → a `BackupRun` appears `success` with
   non-zero size; the object exists in the bucket.
4. **DB restore**: write a sentinel row, restore an earlier artifact in place, confirm the row
   is gone (overwrite) after typed confirmation — proves drop-and-recreate, not append.
5. **Project backup/restore**: create a volume-bearing project (one single-container, one
   compose-stack), write data, back up (volumes + files + snapshot), change the data, restore,
   confirm data returns and the stack restarts; verify via the project **Backups** tab.
6. **Scheduler**: set `* * * * *`, confirm an unattended run fires within a minute, the lease
   prevents a double-run, retention prunes old runs + S3 objects.
7. **Capability gate**: against an agent without `"backup"`, every real path surfaces
   `AgentBackupUnsupportedError` ("update the agent") — not a fake success.
8. **Run the app** (`/run`) to click through the project Backups tab and storage flows.

> **Agent-gated parts** (real dump/upload/restore, `S3Check`/`S3Delete`, DB delete
> `removeVolumes`) require the `deplo-agent` RPCs to ship and the client to be regenerated;
> until then those calls surface `AgentBackupUnsupportedError`. All control-plane code, data
> model, GraphQL, scheduler, and UI are fully testable independently and degrade with a clear
> message rather than a fake success.
