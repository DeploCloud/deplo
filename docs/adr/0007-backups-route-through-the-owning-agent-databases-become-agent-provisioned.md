# Backups route through the owning agent; databases become agent-provisioned

## Context

Backup/restore is entirely stubbed today: `runBackup()` flips `lastStatus` to `"success"`
without dumping or uploading anything, `testS3()` fakes the connectivity check, there is no
restore, no per-run artifact record, no scheduler, and backups can only target a database
(no project backups). We want real end-to-end backups and restore — for both **databases**
and **projects** — pushed to S3-compatible storage, with an in-place restore.

Two facts about the platform shape every decision:

- **The control plane holds no Docker socket and no S3 SDK.** Every host (the Deplo host
  included) is reached uniformly over mTLS via `connectAgent(serverId)`; the agent is the
  only thing that runs `docker`/shell on a host (ADR-0006). So the dump, the compression,
  and the S3 transfer must all happen **agent-side**, with the control plane passing
  decrypted S3 credentials over the (already-encrypted) RPC.
- **Databases are still LOCAL.** `createDatabase()` hardcodes `read().servers[0]` and calls
  `docker(["compose", … "up","-d"])` directly, even though `Database.serverId` already
  exists. This is the last deploy-adjacent surface that bypasses the agent boundary — and a
  backup that dumps a DB must reach that DB through *its owning agent* anyway, so the two
  problems share a path.

When we examined the existing agent stack RPCs against this need, two things the original
plan assumed turned out to be wrong, and they change the contract:

- The plan proposed a new `ProvisionStack` RPC to create a DB stack from compose. But
  **`Reroute` already does exactly that**: it writes `<stackDir>/<slug>.yml` and runs
  `docker compose -p deplo-<slug> up -d --remove-orphans`, idempotently, creating the stack
  if absent (`deplo-agent` `internal/server/server.go` `Reroute`). No new provision RPC is
  needed.
- `DestroyStack` runs `docker compose down --remove-orphans` **without `-v`** and leaves the
  compose file on disk. For an app that is correct; for a **database** it orphans the data
  volume forever. A naive reuse would silently leak DB data on delete.

## Decision

**Databases are agent-provisioned, exactly like projects.** `createDatabase()` takes a
chosen `serverId` (defaulting to the sole server when there is one), renders the compose with
the existing `generateDatabaseCompose()`, and provisions it on the owning agent via the
**existing `Reroute`** RPC with `slug = db-<name>` — no new provision RPC. `start`/`stop`
route to `StartStack`/`StopStack`. The DB container keeps its DNS name `db-<name>` on the
`deplo` network, so connection strings are unchanged and legacy local DBs (which already have
a `serverId` and a stack on that host — itself an agent now) keep working by the same slug.

**Delete gets the one new stack-RPC affordance:** `DestroyStack` gains a `removeVolumes`
flag. When true the agent runs `compose down -v` **and** removes the on-disk compose file, so
deleting a database reclaims its data volume (matching today's local `down -v`). Apps keep
calling it with `removeVolumes` unset.

**Backup/restore are agent RPCs, gated behind a `"backup"` capability.** New to the
`proto/agent.proto` contract:

- `Backup(BackupRequest) → stream BackupEvent` — DB: `docker exec` the engine's dump tool;
  Project: `tar` the named volumes (via a throwaway helper container) + the project files
  dir + a compose/env snapshot. Either way: compress and stream to S3 via **multipart PUT
  using an S3 client compiled into the agent** (`minio-go`; no temp file, no control-plane
  transfer). Returns `{ objectKey, sizeBytes }`.
- `Restore(RestoreRequest) → stream RestoreEvent` — pull the object from S3; **in-place
  overwrite**. The overwrite guarantee lives in the **dump format**, not in hope: Postgres
  `pg_dump -Fc` + `pg_restore --clean --if-exists`, MySQL `mysqldump --add-drop-table` +
  `mysql`, Mongo `mongodump` + `mongorestore --drop`. Project restore: stop stack → wipe +
  untar volumes + files → `Reroute` the snapshotted compose/env (which also restarts the
  stack) — a **full restore of data *and* config**.
- `S3Check(...)` — a HEAD/list to make `testS3()` real, run on any reachable agent that
  advertises `backup`.
- `S3Delete(...)` — delete objects by key/prefix. **Required, not optional**: it backs both
  retention pruning and the "also delete the backups" branch of target deletion.

The control plane preflights the `"backup"` capability like `self-update` and raises
`AgentBackupUnsupportedError` ("update the agent") when absent, so **all control-plane code
ships and is testable now** and degrades with a clear message until the agent ships the RPCs.
`ListBackupArtifacts` (listing bucket objects with no local run record) is **deferred** — the
`BackupRun` history is the primary source.

**Run history is a `DeploData` array; the scheduler lock is relational.** Each executed
backup is a `BackupRun` appended to `backupRuns: BackupRun[]` in `DeploData` (defaulted via
`normalize()` — JSONB, **no SQL migration**), consistent with how `activities`/`deployments`
already model growing history; retention prunes rows and S3 objects (cap per target) so the
whole-document write stays cheap. The **only** relational addition is the scheduler's
mutex: the single-JSONB-document store offers no cross-process compare-and-set, so the
once-a-minute tick (a `globalThis` singleton started from `instrumentation.ts`) claims due
backups via a **Postgres advisory lock / dedicated lease row** with a heartbeat/timeout (a
crashed run's lease expires and is re-armed). In file-backend dev mode (no Postgres) the lock
degrades to in-process — acceptable because `next start` is single-process.

## Consequences

- Step 0 (DB-on-agent) is **much smaller** than first scoped: create/start/stop reuse
  existing `Reroute`/`StartStack`/`StopStack`; the only agent-side change for it is the
  `DestroyStack` `removeVolumes` flag.
- Cross-repo surface is bounded to: `Backup`, `Restore`, `S3Check`, `S3Delete` (new),
  `DestroyStack.removeVolumes` (modify), the `"backup"` Hello capability, and an S3 client
  dependency in the agent binary. Everything else is control-plane TypeScript shippable and
  unit-testable here behind the capability gate.
- Backup and restore are **coupled on the dump format** per engine; the format table
  (engine → dump flags → restore flags → object-key extension) is the contract both sides
  honour. Getting it wrong corrupts data, so it is fixed here, not "decided later in Go".
- Project restore is **destructive and causes downtime** (stop → wipe → untar → restart):
  it requires a typed confirmation and surfaces both facts in the UI. There is **no
  automatic pre-restore snapshot** (a known limitation); recovering a deleted-and-restored
  state is out of scope for now.
- Full project restore re-applies the **snapshotted compose/env**, which can reintroduce
  rotated secrets or point at an image/tag that no longer exists; such a restore can fail at
  restart and the `RestoreEvent` stream must report it clearly.
- Deleting a database/project prompts an explicit choice — keep the S3 artifacts (default)
  or delete them too (via `S3Delete`); schedules are always removed, and orphaned
  `BackupRun`s stay visible but their in-place restore is disabled (no target to restore
  into) until a restore-to-new path exists.
- S3 credentials are decrypted control-plane-side and cross the mTLS wire to the agent for
  each backup/restore — the same trust model as per-deploy env; the agent never persists
  them and never holds the encryption key.
