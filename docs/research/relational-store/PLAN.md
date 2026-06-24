# Relational Store — Single-JSONB → Full Relational Schema + Async Data Layer

> **Status:** plan synthesized from a 55-agent parallel analysis of the codebase
> (25 collection→table designs, 25 per-module access audits, 4 async-blast-radius
> surfaces), then **stress-tested in a grilling session (2026-06-24)**. The
> sections below are the **revised** decisions: where the grilling overturned an
> earlier claim, the old version is flagged **[superseded]** in place so a reader
> can see what changed and why. Two structural reversals dominate: **no JSONB
> anywhere** (the original hybrid §2 is gone) and **migrate per cut-set, not per
> module** (the original per-module Steps 4–6 were proven invalid). Domain terms
> in [CONTEXT.md](../../../CONTEXT.md). This is the implementation breakdown; not
> yet approved for build.

## Context

The user wants a **full database structure instead of a single JSON singleton**.

Today the entire control plane lives in **one JSONB row** — `deplo_state`,
`id = "singleton"` ([lib/db/document-store.ts](../../../lib/db/document-store.ts)) —
hydrated into a process-global in-memory cache and read through **synchronous**
`read()`/`mutate()` ([lib/store.ts](../../../lib/store.ts)). The whole `DeploData`
shape ([lib/types.ts:1145](../../../lib/types.ts#L1145)) is **27 top-level
collections** (some are `Record<>` maps such as `logs` and `notificationSettings`),
and the data-access layer reaches them through **~360 synchronous call sites across
42 files**.

### Why migrate (motivation = A + B + C + D)

The grilling confirmed all four motivations hold together, so a full migration —
not a half-measure — is justified:

- **A — Concurrency correctness.** The whole-document `mutate()` model has real
  lost-update and TOCTOU classes (registration-link reuse, admin-coverage,
  single-primary-domain). DB constraints + transactions are the only durable fix.
- **B — Scale.** A single ever-growing JSONB row (logs, activities, backup_runs
  append forever) is rewritten in full on every mutation — quadratic write
  amplification. Append-only child tables remove it.
- **C — Queryability.** Element-wise lookups (a token hash, a domain by host, a
  membership) scan an in-memory array today; indexed tables make them real queries.
- **D — Cleanup.** Cascades, FKs, and partial-unique constraints express
  invariants the app currently hand-maintains (and sometimes gets wrong — see the
  `deleteProject` orphan bug, §Backfill).

### Deployment reality (single-process today)

The product runs as a **single `next start` process** today (the Dockerfile `CMD`
is `node server.js`; there are no worker threads for rendering — see the
`globalThis` rationale in [lib/store.ts](../../../lib/store.ts)). So:

- **DB constraints are the correctness foundation** — not a multi-node lock
  scheme. We design for "the database enforces the invariant", and deliberately
  add **no speculative multi-node machinery**.
- The **one** exception we keep is the `scheduler_lease` CAS
  ([lib/backups/lease.ts](../../../lib/backups/lease.ts)), reused for the backfill
  gate (§Backfill) — because even a single process can boot twice (rolling
  restart overlap), and a backfill must run at most once.

### Decisions locked by the user

1. **Target:** full relational schema **+ async data layer** — real tables/FKs for
   every collection, and the in-memory cache is **removed**; data functions query
   Postgres directly (`await`).
2. **Migration:** **per-cut-set backfill** copying from the live JSONB at each
   cut-set's switch moment (see §Backfill — this **[supersedes]** the original
   "one backfill at Step 2" plan, which would diverge for weeks between the copy
   and the switch).

The synchronous `read()`/`mutate()` API exists for exactly one reason (documented
in the [lib/store.ts](../../../lib/store.ts) header and
[lib/graphql/context.ts:42](../../../lib/graphql/context.ts#L42)): keep reads
synchronous over an async backend. Once the data layer is async there is no
in-memory document to read or mutate, so that whole machinery
(`globalThis` `StoreState` cache, `queuePostgresWrite`, the serialized `writeChain`,
the `state.dirty` seed-then-adopt logic) is deleted.

---

## 1. Target architecture

### Drizzle schema layout

Extend [lib/db/schema.ts](../../../lib/db/schema.ts) (already holds the Better-Auth
`user`/`session`/`account`/`verification` tables plus `deploState` and
`schedulerLease`), split into per-domain modules to stay navigable:

- `lib/db/schema/auth.ts` — the existing Better-Auth tables, unchanged.
- `lib/db/schema/control-plane.ts` — the new relational tables, grouped by aggregate
  root (identity: `users`/`teams`/`memberships`(+`membership_capabilities`)/
  `invites`(+`invite_capabilities`)/`registration_links`; infra: `servers`;
  projects: `projects`(+`project_build`/`project_build_method_settings`/`project_dev`/
  `project_exposes`/`project_volumes`/`project_mounts`)/`deployments`/
  `deployment_logs`/`env_vars`(+`env_var_targets`)/`domains`(+`domain_middlewares`)/
  `dev_ssh_user`; data: `databases`/`s3_destination`/`backups`/`backup_runs`;
  integrations: `registries`/`github_apps`/`github_installation`/`installed_apps`/
  `shared_env_groups`(+`shared_env_group_vars`/`shared_env_group_projects`/
  `shared_env_group_targets`); per-team: `activities`/`notification_settings`;
  ordering: `team_project_order`/`team_folder_order`).
- `lib/db/schema/legacy.ts` — keep `deploState` and `schedulerLease`.
  **The JSONB row is NOT dropped during the migration** (see §Backfill, rollback
  artifact). **[Reconciliation needed — see Decision 21:]** the runtime types these
  tables are actually created with (`document-store.ts:21` uses `timestamptz`;
  `lease.ts:98` uses plain `timestamp`) drift from the Drizzle declarations in
  `schema.ts`. Align the declarations to the real DB type **before**
  `db:generate` includes this file (§Steps, Step 0).
- Re-export an aggregated `schema` object from `lib/db/schema.ts` so
  [drizzle.config.ts](../../../drizzle.config.ts) (`schema: "./lib/db/schema.ts"`)
  needs no change.

**Conventions:** `text("id").primaryKey()` for app-minted ids (`newId("prj")` etc.
from [lib/ids.ts](../../../lib/ids.ts)) — never serial/uuid; snake_case columns.

**Timestamps — `mode:"string"` is NOT byte-for-byte ([superseded] convention).**
The original plan said `timestamp(..., { mode: "string" })` "preserves byte-for-byte
behavior". The grilling proved this **false**: node-postgres renders a `timestamptz`
as `'2026-06-24 12:34:56.789+00'` (space separator, `+00`, trimmed fraction), but
[nowIso()](../../../lib/ids.ts#L9) = `toISOString()` produces `'2026-06-24T12:34:56.789Z'`.
**15+ modules sort `createdAt`/`startedAt` lexicographically** (e.g.
[lib/data/activity.ts](../../../lib/data/activity.ts#L13),
[lib/data/members.ts:357](../../../lib/data/members.ts#L357),
[lib/data/backup-objectkey.ts:100](../../../lib/data/backup-objectkey.ts#L100)) — and
a space sorts **before** `T`, so a mix of legacy-`T` and new-space strings inverts
the order during the migration window. **Fix:** register a node-postgres type parser
for OID `1184` (`timestamptz`) and `1114` (`timestamp`) →
`v && new Date(v).toISOString()`, a single choke point in
[lib/db/pg.ts](../../../lib/db/pg.ts) (or the new client). Then `*_at` columns return
canonical ISO `T…Z` strings on every read regardless of how they were written. A
write→read **round-trip test** must pass BEFORE any module swap, and the parser is on
the Step -1 pglite validation list.

**Enums:** **prefer plain `text` with NO `CHECK`** for the un-validated value sets
(`framework`, `build_method`) — the write paths today are unchecked (framework passed
`as never`, `buildConfigFor` returns `undefined` for unknowns, `source="dockerfile"`
persists), so a strict CHECK would reject legacy rows at backfill. Keep
`entrypoint`/`cert_provider`/`source`/`volume.type` **nullable** (no DEFAULT) to
round-trip the auto/manual tri-states. A `pgEnum` is justified only where the value
set is closed AND we coerce legacy values at backfill (`deployment_log_level`,
`github_account_type`, `dev_status`).

**Secrets** stay as `text` columns holding ciphertext/hashes exactly as today
(`password_hash`, `value_enc`, `connection_string_enc`, `*_key_enc`,
`client_secret_enc`/`webhook_secret_enc`/`private_key_enc`, `password_enc` on
`dev_ssh_user`, `token_hash` on invites/registration_links/api_tokens,
`bootstrap_token_hash`). They are excluded from default SELECT projections (the DTOs
already drop them).

### No JSONB anywhere — total normalization ([supersedes] the hybrid §2)

The original plan kept JSONB for "read/written whole, never queried element-wise"
fields (`projects.build`/`dev`/`exposes`/`mounts`/`volumes`, `teams.projectOrder`/
`folderOrder`, `memberships.capabilities`, `env_vars.targets`,
`notification_settings.events`, …). **The grilling reversed this.** Motivation: DB
integrity on *every* field + future queryability + a single paradigm (no "is this one
a column or a JSON blob?" cognitive tax). Concretely:

- Every **nested object** → its own 1-to-1 child table:
  `project_build` (the [BuildConfig](../../../lib/types.ts#L439)),
  `project_build_method_settings` (the [BuildMethodSettings](../../../lib/types.ts#L422)),
  `project_dev` (the [DevConfig](../../../lib/types.ts#L488)).
- Every **list** → an ordered child table or a junction (with a `position` column
  where order matters): `project_exposes`, `project_volumes`, `project_mounts`,
  `domain_middlewares`, `membership_capabilities`, `invite_capabilities`,
  `env_var_targets`, `shared_env_group_targets`, `team_project_order`,
  `team_folder_order`.
- `notification_settings.events` AND `channels` → **flat columns** (no JSONB map).

**Trade-off accepted:** every project read now JOINs 5–6 child tables. This makes
two things **mandatory**, not optional: (1) a **batch-load** layer (dataloader) so a
list of N projects is a bounded number of queries, not N×6 (§Reads); and (2)
**ORDER BY / LIMIT push-down** into SQL for the append-only collections (§Reads).

**Tri-states need explicit sentinels** (there is no "absent key" in a relational row
to lean on): `project_dev` **row absent** = dev mode never enabled (do NOT
materialize a default row); `domains.entrypoint` **NULL** = auto-derive at deploy
time (never coerce to `'websecure'`, and **no column DEFAULT** — see
[addDomain](../../../lib/data/domains.ts#L250) storing it only when given).

### Ordering junctions replace the deliberate stale-id self-healing ([superseded] note)

The original §2 kept `teams.project_order`/`folder_order` as `jsonb` ID[] *because*
[listProjects](../../../lib/data/projects.ts#L185) and
[listFolders](../../../lib/data/folders.ts#L71) **deliberately tolerate stale ids**:
a dead id ranks `Infinity` and is pruned only at the next reorder. A naive junction
would contradict that self-healing. **Resolution:** use a junction anyway
(`team_project_order` / `team_folder_order`, each `(team_id, target_id, position)`),
and:

- **Backfill** INTERSECTS each ordered array with the live same-team id set (reuse
  the valid-set filter from [mergeOrder](../../../lib/data/folders.ts#L122)),
  assigning `position` over the survivors only.
- Add **`ON DELETE CASCADE`** at runtime so deleting a project/folder removes its
  order rows automatically.

The self-healing stops being app logic and **becomes a DB invariant** — the array
can no longer carry a dead id at all. (This also retires the
`projectOrder`/`folderOrder` **array-race** the original §1 worried about: there is no
array to race; concurrent reorders write disjoint rows.)

### Where the async data layer lives

The data layer **stays where it is** — [lib/data/](../../../lib/data/),
[lib/auth.ts](../../../lib/auth.ts), [lib/membership.ts](../../../lib/membership.ts),
[lib/deploy/build.ts](../../../lib/deploy/build.ts), `lib/infra/*`,
[lib/github/app.ts](../../../lib/github/app.ts). The relational rewrite happens
**inside** these function bodies; signatures change only where a fn is currently sync
**or where a list resolver must change shape for push-down** (the explicit exception,
§Reads).

Add **`lib/db/client.ts`** exporting a single Drizzle instance bound to the existing
`getPool()` from [lib/db/pg.ts](../../../lib/db/pg.ts) (reuse the bounded pool — do
not open a second one). Pin it on `globalThis` with the same `Symbol.for` pattern
[lib/store.ts](../../../lib/store.ts) already uses, so the RSC vs route-handler
module-registry split (documented in the `STORE_KEY` comment, and the same reason
[lib/data/keyed-mutex.ts](../../../lib/data/keyed-mutex.ts) and
[lib/backups/lease.ts](../../../lib/backups/lease.ts) pin on `globalThis`) collapses
onto one Drizzle client.

Table access goes through thin per-table queries colocated with their data module
(e.g. `projects.ts` owns its `projects` queries directly via Drizzle), not a generic
ORM-of-an-ORM.

### How transactions are expressed — and where they MUST NOT reach

Multi-collection atomic `mutate()` blocks become **`db.transaction(async (tx) => …)`**.
Three rules the grilling pinned down:

**(a) NO agent RPC inside a transaction.** A `db.transaction` must never wrap a gRPC
call to an agent — the call can block for the whole dump/teardown, holding a DB
connection + locks hostage. Concretely:

- [executeBackup](../../../lib/data/backups.ts#L301) is **two short transactions**
  (the *start* mutate at line 301, the *terminal* mutate at line 379) with the gRPC
  `conn.backup(req)` dump **between** them — never one tx around the agent call. This
  is already the shape of the code; the migration must preserve it.
- Same structure for `deleteDatabase` (`DestroyStack`), the `deleteProject` cascade
  (its `teardownProject` dial), and `restore`: short control-plane tx, agent call
  outside, short terminal tx.

**(b) The keyed-mutex survives intact.** [lib/data/keyed-mutex.ts](../../../lib/data/keyed-mutex.ts)
serializes DB-lifecycle RPCs to close the delete-during-provision window. **No DB
constraint replaces it** — it orders *agent Docker state*, not control-plane rows.
Keep it exactly as-is.

**(c) `recordActivity` stays best-effort and non-transactional ([supersedes] the
`recordActivityTx` proposal).** The original §1 proposed threading a `tx` into a
`recordActivityTx(tx, …)` across ~65 call sites so the activity insert commits with
the primary write. **Dropped.** [recordActivity](../../../lib/data/activity.ts#L26) is
a *standalone separate mutate today* (it is not inside the caller's `mutate`), and an
audit-log insert failure must **never** roll back the user's action. It stays a
fire-and-forget best-effort insert. This also removes the ~65-call-site tx-threading
churn entirely.

The transaction set that **does** apply (FK-coupled multi-table writes only):

- **[lib/data/projects.ts](../../../lib/data/projects.ts):** `createProject` (the
  fan: `projects` + `env_vars`(+`env_var_targets`) + `project_build` +
  `project_build_method_settings` + `project_exposes` + `project_mounts` — one tx,
  see Decision 15), `updateProjectBuild` (parent `project_build` merge + child
  `project_build_method_settings` replace — one tx), `updateProjectSource`
  (`projects` + `domains` rehost), `deleteProject`/`deleteProjects` (the full cascade
  — **whose live orphan bug must be fixed here**, §Backfill), `reorderProjects` (now a
  `team_project_order` rewrite).
- **[lib/data/deployments.ts](../../../lib/data/deployments.ts):**
  `promoteToProduction` (`deployments` + `projects`).
- **[lib/data/domains.ts](../../../lib/data/domains.ts):** `setPrimaryDomain` (the
  multi-row primary flip — now a single UPDATE, §Concurrency), `syncProductionUrl`
  (`domains` → `projects`).
- **[lib/data/databases.ts](../../../lib/data/databases.ts):** `deleteDatabase`
  (short txs around the `DestroyStack` agent call, per rule (a)).
- **[lib/data/teams.ts](../../../lib/data/teams.ts):** `createTeam`
  (`teams` + `memberships`).
- **[lib/data/folders.ts](../../../lib/data/folders.ts):** `createFolder`
  (`folders` + `team_folder_order`), `deleteFolder` (re-parent `projects` + `folders`,
  drop the order row).
- **[lib/data/env.ts](../../../lib/data/env.ts):** `setProjectEnv` (N upserts + bulk
  delete on `env_vars`(+`env_var_targets`)).
- **[lib/data/github.ts](../../../lib/data/github.ts):** `removeGithubApp`
  (`github_apps` + `github_installation` cascade).
- **[lib/data/s3.ts](../../../lib/data/s3.ts):** `deleteS3` (`s3_destination` +
  `backups` cascade).
- **THE hard one — [lib/auth.ts](../../../lib/auth.ts) /
  [lib/data/members.ts](../../../lib/data/members.ts):** `createAccountWithTeam` +
  [consumeRegistrationLinkInDraft](../../../lib/data/members.ts#L513). The
  check-username/email/team + consume-registration-token + insert(users, teams,
  memberships(+capabilities)) critical section becomes ONE `db.transaction`, with the
  registration-link consume as a conditional
  `UPDATE … WHERE id=$ AND status='pending' AND expires_at >= now() RETURNING …`
  inside the tx — the loser of a double-submit updates 0 rows and throws. This
  replaces the synchronous-mutate atomicity that closes the TOCTOU today.

DB-level constraints replace several check-then-write races: `UNIQUE` on
`lower(email)`, `username`, `slug` (teams/projects); `(project_id, key)` on env_vars;
`(name, COALESCE(path_prefix,''))` on domains; partial `UNIQUE (project_id) WHERE
is_primary` on domains; `token_hash` uniques. The data layer drops pre-write
existence scans in favor of `ON CONFLICT`/constraint-violation handling. **But
count-invariants are NOT constraints — see §Concurrency.**

### Fate of `read()` / `mutate()` / `ensureStoreReady()` and the globalThis cache

- **`read()` / `mutate()` are deleted** at the end (Step 6). With per-table async
  queries there is no in-memory document to read or mutate.
- **The `globalThis` `StoreState` cache, `queuePostgresWrite`, `writeChain`,
  `state.dirty`, and the seed-then-adopt crutch in `load()`
  ([lib/store.ts:157](../../../lib/store.ts#L157)) are deleted.** Asyncifying reads
  actually *simplifies* the store — that crutch exists only to serve sync reads
  before hydration.
- **`ensureStoreReady()` is kept but repurposed** as the **per-cut-set backfill
  gate** (§Backfill): it no longer hydrates a cache, it runs each cut-set's one-time
  copy at most once per process. It is already awaited in the dashboard layout and
  the auth resolver, so the call sites stay valid. **It must NOT 500 the process on
  failure** — see Decision 20/23.
- **Test mode** (`isTestEnv()` via `NODE_TEST_CONTEXT`,
  [lib/db/pg.ts:33](../../../lib/db/pg.ts#L33)) changes paradigm: today tests run
  **pure in-memory with NO SQL** ([lib/db/pg.ts:11-16](../../../lib/db/pg.ts)). From
  the first Drizzle module that no longer works — the test backend becomes a real
  in-process Postgres (pglite). See §Test backend & Step -1.

---

## 2. Schema overview

All control-plane tables in `lib/db/schema/control-plane.ts`. **No JSONB columns.**
Non-obvious calls flagged. New columns added by the grilling: `seq` (bigint
identity, §Concurrency Decision 10) and tri-state sentinels.

| Table | Notes / trickiest decisions |
|---|---|
| `users` | Flat. `UNIQUE(lower(email))` (expression index — app does case-insensitive checks). `UNIQUE(username)`. 4 optional booleans → `NOT NULL DEFAULT false`. `password_hash` excluded from projections. No FKs out. |
| `teams` | `UNIQUE(slug)`. **`project_order`/`folder_order` are NO LONGER columns** — moved to the `team_project_order`/`team_folder_order` junctions (was jsonb; see below). |
| `team_project_order` | **Ordering junction** `(team_id, project_id, position)`, PK `(team_id, project_id)`. `ON DELETE CASCADE` on both FKs makes stale-id self-healing a DB invariant (replaces the `listProjects` Infinity-rank prune). Backfill intersects the legacy array with live team project ids. |
| `team_folder_order` | Same shape for folders, `(team_id, folder_id, position)`. |
| `folders` | Self-FK `parent_id`. **App re-parenting in `deleteFolder` is authoritative** — the FK is a safety net (`ON DELETE SET NULL`, or omit). `CASCADE` on `parent_id` would wrongly delete subtrees. |
| `memberships` | `UNIQUE(user_id, team_id)` closes the double-add race. **`capabilities` → `membership_capabilities` junction** (was inline jsonb/text[]). |
| `membership_capabilities` | `(membership_id, capability)`, PK on both. Loaded into memory and `.includes()`-checked as today (run `cleanCapabilities` at backfill). |
| `invites` | `token_hash` `UNIQUE`. Partial `UNIQUE (team_id, email) WHERE status='pending'`. **`capabilities` → `invite_capabilities` junction.** `status` soft-lifecycle (never hard-delete on revoke). `invited_by` is a display name, NOT an FK. |
| `registration_links` | `token_hash` `UNIQUE`. **Consume via conditional `UPDATE … WHERE status='pending' AND expires_at>=now() RETURNING`** for single-use atomicity. `created_by`/`used_by_username` denormalized strings, NOT FKs. |
| `servers` | No `team_id` (instance-wide). `agent_*`/`bootstrap_*` **flattened from nested objects** so `agent_cert_fingerprint` and `bootstrap_token_hash` are indexable for the two lookup paths (dial / call-home). Partial-unique on fingerprint excluding `''`/NULL; partial index on live token hash. |
| `projects` | Flat scalar columns only. `slug` `UNIQUE` *globally*. `folder_id` `ON DELETE SET NULL` (orphan tolerated). `server_id` `RESTRICT`. `latest_deployment_id` `SET NULL`. `repo`/`upload` flattened to columns (small fixed shapes). `expose` is **NOT stored** — it is derived as `exposes[0]` in the row-assembler (Decision 14). Legacy `source="dockerfile"` rewritten on backfill via the shared normalizer (Decision 12/13). |
| `project_build` | **1-to-1 child** (was `projects.build` jsonb). `project_id` PK + FK CASCADE. `framework`/`build_method` plain **text, no CHECK**. `runtime_version` (legacy `nodeVersion` remapped by `normalizeBuildConfig` at backfill). `NOT NULL` columns → backfill MUST run the read-time normalizer first (Decision 12). |
| `project_build_method_settings` | **1-to-1 child** (was nested `methodSettings`). `project_id` PK + FK. Every [BuildMethodSettings](../../../lib/types.ts#L422) field is a column; an `updateProjectBuild` with a provided `methodSettings` object **fully replaces this row** while the parent `project_build` columns merge field-by-field (Decision 15). |
| `project_dev` | **1-to-1 child** (was `projects.dev` jsonb). `project_id` PK + FK. **Row ABSENT = dev never enabled** (the [DevConfig](../../../lib/types.ts#L488) tri-state — do NOT seed a default row). `dev_status` pgEnum, legacy unknown → `'off'`. |
| `project_exposes` | **Ordered child** `(project_id, position)` of `{service, port, host?}`. `expose := exposes[0]` is derived, never stored. |
| `project_volumes` | **Ordered child**; `type` column NULLABLE (named/`host`/`project` discriminant). Backfill runs `normalizeVolumes` first (drops mountless entries) so NOT-NULL child columns hold. |
| `project_mounts` | **Ordered child** of `{filePath, content}` template config files. `content` byte-preserved (reconciliation asserts byte-equality, Decision 14). |
| `deployments` | Fully flat. **`seq bigint identity`** (Decision 10) — sorts are `ORDER BY created_at DESC, seq DESC`. `(project_id, created_at DESC, seq DESC)` index. No `team_id` (joined via project). |
| `deployment_logs` | **The `logs: Record<ID, LogLine[]>` map becomes this child table** — map key → `deployment_id` FK, each `LogLine` → one row, `id bigint identity` PK reproduces `Array.push` order; `(deployment_id, id)` index. `level` is pgEnum `deployment_log_level`. **Write via a batched buffer, NOT per-line — see §Reads Decision 18.** |
| `env_vars` | `value_enc` secret. `UNIQUE(project_id, key)` enables `ON CONFLICT` upsert. **`targets` → `env_var_targets` junction.** |
| `env_var_targets` | `(env_var_id, target)`, PK both. `target` ∈ production/preview/development. |
| `domains` | `primary` is a **SQL reserved word** — map TS `isPrimary`/db `is_primary` or quote. Partial `UNIQUE (project_id) WHERE is_primary`. `UNIQUE (name, COALESCE(path_prefix,''))`. `entrypoint`/`cert_provider`/`source` **NULLABLE, no DEFAULT** (auto/manual tri-state — never coerce NULL→`'websecure'`). **`middlewares` → `domain_middlewares` junction.** |
| `domain_middlewares` | Ordered child `(domain_id, position, name)`. |
| `databases` | `connection_string_enc` secret. `server_id` `RESTRICT`. `UNIQUE(team_id, name)`. |
| `s3_destination` | `access_key_enc`/`secret_key_enc` secrets (secret key never even masked-returned). `(team_id, created_at DESC)` index. Backfill may have rows without `team_id` → populate before NOT NULL. |
| `backups` | Schedule table (not run history). `target_kind` XOR CHECK on `database_id`/`project_id`. `destination_id` `RESTRICT`; database/project/team `CASCADE`. `last_status` enum includes `'never'` (wider than run status). |
| `backup_runs` | History; **separate table, NOT a child of backups**. **`seq bigint identity`** (Decision 10). `backup_id` `SET NULL` (history outlives schedule). `database_id`/`project_id` `SET NULL`. `size_bytes` **must be `bigint`**. Partial index `WHERE status='running'` for boot reconcile. Retention (`selectDoomedRuns`) orders by `(created_at, seq)`, never timestamp alone (Decision 10). |
| `api_tokens` | `token_hash` `UNIQUE` (hot auth lookup). CASCADE on team and user. **Leaf collection** (zero-cost-revert cut-set, Decision 3a). |
| `activities` | Append-only. **`seq bigint identity`** (Decision 10) — all sorts `ORDER BY created_at DESC, seq DESC`, push-down `LIMIT` into SQL. `(team_id, created_at DESC, seq DESC)` index. `actor` free text (incl. `"system"`), NOT an FK. `project_id` `SET NULL`. Backfill maps empty-string `team_id` to a real team before NOT NULL+FK, and assigns `seq` in source-array order. |
| `notification_settings` | **Map keyed by teamId → `team_id` IS the PK** (one row/team). Channels AND **`events` flattened to columns** (no jsonb — `*_enabled`/`*_url`/`email_address` + one boolean column per event). Missing row = `defaultNotificationSettings()`. **Leaf collection** (cut-set 3a). |
| `shared_env_groups` (+3 children) | **`shared_env_group_vars`** (`value_enc` secret, PK `(group_id, key)`, whole-set replace); **`shared_env_group_projects`** (true junction, PK `(group_id, project_id)`, index `project_id`); **`shared_env_group_targets`** (was `targets` jsonb on the parent → now a junction). |
| `registries` | `password_enc` secret. `(team_id, created_at DESC)` index. **Leaf collection** (cut-set 3a). |
| `github_apps` | 3 secrets (`client_secret_enc`/`webhook_secret_enc`/`private_key_enc`). `app_id` `bigint UNIQUE`. |
| `github_installation` | `installation_id` `bigint UNIQUE` (upsert conflict target; do NOT touch `created_at` on conflict). `account_type` pgEnum. No `team_id` (scoped via parent). |
| `dev_ssh_user` | `password_enc` reversible secret (write-only, masked as `hasPassword`). `UNIQUE(username)` **globally**. CHECK `public_key IS NOT NULL OR password_enc IS NOT NULL`. |
| `installed_apps` | `UNIQUE(team_id, catalog_id)` + `UNIQUE(slug)`. `(team_id, created_at DESC)` index. `status`/`url` deliberately NOT stored (computed). Backfill the derived `slug` for legacy empty-slug rows. **Leaf collection** (cut-set 3a). |

**FK ordering for creation/backfill** (roots first): `users`, `teams`, `servers` →
`memberships`(+`membership_capabilities`), `invites`(+`invite_capabilities`),
`registration_links`, `folders`, `team_project_order`/`team_folder_order` (after
projects/folders exist), `notification_settings`, `s3_destination`, `api_tokens`,
`activities`, `registries`, `github_apps`, `installed_apps`, `shared_env_groups`
(+children) → `projects` → `project_build` → `project_build_method_settings`,
`project_dev`, `project_exposes`, `project_volumes`, `project_mounts` →
`databases`, `github_installation` → `deployments`, `env_vars`(+`env_var_targets`),
`domains`(+`domain_middlewares`), `dev_ssh_user` → `deployment_logs`, `backups` →
`backup_runs`. The `latest_deployment_id` self-reference on `projects` is set in a
second pass after deployments exist (or left `SET NULL`-deferred).

---

## 3. Per-cut-set migration — the big structural reversal

> **[Supersedes] the original "migrate per data module" plan (old Steps 4–6).** The
> grilling proved per-module migration is **invalid**: a collection is read and
> written by modules scattered across *different* steps, so migrating "module by
> module" leaves a half-relational/half-JSONB store where one side reads stale data
> from the other. The fix is to migrate by **cut-set**: the closure of a collection
> *and every module that reads or writes it*, atomically in one PR.

### Why per-module is broken (verified contradictions)

- **users:** `account.ts` would write users at the old Step 4, but `auth.ts` login
  *reads* users at the old Step 6 → a password changed via the new relational path
  is invisible to the still-JSONB login → **stale-password login**.
- **memberships/users:** [membership.ts](../../../lib/membership.ts) (`membershipFor`,
  `teamsForUser`) is an **unassigned reader** sitting behind *all* of
  `requireCapability` — if memberships migrate but `membership.ts` still reads JSONB,
  a newly-added member is **invisible to authz**.
- **envVars/sharedEnvGroups/domains:** read by
  [build.ts](../../../lib/deploy/build.ts) (`projectEnv` at line 91,
  `routableRoutes`) → if those collections migrate but `build.ts` still reads the
  cache → **stale deploys / wrong routing**.
- **registrationLinks:** consumed by `auth.ts` (`consumeRegistrationLinkInDraft`) →
  splitting the producer (`members.ts`) from the consumer (`auth.ts`) across steps
  **reopens the single-use TOCTOU**.

### The "clean-rollback window" is NOT open through Step 7 ([superseded])

The original plan claimed the JSONB row stays a safe rollback artifact through Step 7
because it is "frozen read-only during the transition". **False.**
[saveDocument](../../../lib/db/document-store.ts#L35) writes the **whole** document, so
any *not-yet-migrated* module that calls `mutate()` overwrites the JSONB with stale
cache data — **clobbering collections that were already migrated**. Therefore:

- The **clean-rollback window closes at the END of the leaf cut-set** (the only
  zero-cost-revert collections), not at Step 7.
- An in-flight cut-set is **"roll FORWARD with a fix", not roll back.** If a bug
  ships, fix-forward; do not revert into a clobbering half-state.
- Only the **4 leaf collections** (`apiTokens`, `notificationSettings`, `registries`,
  `installedApps`) are truly zero-cost-revert: nothing else reads them, so a JSONB
  whole-document write can't be poisoned by them and they can't poison anything.

### The four cut-sets (each = one atomic PR), in order

**Cut-set (a) — Leaf / isolated collections.** `apiTokens`, `notificationSettings`,
`registries`, `installedApps`. The ONLY zero-cost-revert set. No cross-collection
reads. Migrate these first to prove the engine + test backend end-to-end on low risk.

**Cut-set (b) — Identity / auth.** `users` + `teams` + `memberships`(+capabilities) +
`registrationLinks`, together with **[lib/auth.ts](../../../lib/auth.ts)**, the
**[members.ts](../../../lib/data/members.ts) critical section**
(`createAccountWithTeam` → the one `db.transaction` with the conditional
registration-link `UPDATE … RETURNING`), and **[membership.ts](../../../lib/membership.ts)**
(the unassigned authz reader — it MUST move in this PR or authz reads stale
memberships). Includes the count-invariant fixes (`updateUserAdmin`,
`assertAdminCoverage` — §Concurrency).

**Cut-set (c) — Project graph.** `projects` (+ all 5–6 child tables) + `deployments` +
`domains` + `envVars` + `logs` + `sharedEnvGroups`, together with
**[build.ts](../../../lib/deploy/build.ts)** and `dev.ts` (the env/routing readers)
and **[folders.ts](../../../lib/data/folders.ts)** (ordering junctions). Includes:
the `loadProjectGraph` aggregate loader (§Reads Decision 16), the `summarize()`
batch-load (§Reads Decision 17), the `deployment_logs` buffered writer (§Reads
Decision 18), the `setPrimaryDomain` single-UPDATE flip (§Concurrency), the
`createProject`/`updateProjectBuild` transactions (Decision 15), and **the
`deleteProject` cascade orphan fix** (§Backfill Decision 14b).

**Cut-set (d) — Backups.** `backups` + `backupRuns`, migrated **with or after**
`databases` + `s3` (a backup target FKs a database/project/destination, so those must
exist relationally first). Includes the two-tx `executeBackup` (agent call outside
the tx, §Transactions rule (a)) and the `(created_at, seq)` retention ordering
(Decision 10).

Each cut-set carries its **own backfill** (§Backfill) and **rewrites the tests** that
seed/assert that cut-set's paths (§Test backend Decision 23) — none of that is
deferred to a final step.

---

## 4. Concurrency correctness — count-invariants

Three invariants are **lost-update races** that a `db.transaction` under READ
COMMITTED does **not** fix on its own, and that **no constraint can express**
(they're "at least one row still satisfies P", not "this row is unique"):

- [updateUserAdmin](../../../lib/data/members.ts#L409): "the instance must keep ≥1
  active (non-suspended) admin" — counts admins as they *would be* after the edit.
- [assertAdminCoverage](../../../lib/data/members.ts#L234): "the team must keep ≥1
  holder of each critical capability".
- [setPrimaryDomain](../../../lib/data/domains.ts#L616): "exactly one primary per
  project".

Two concurrent demotions each pass their own check against pre-update state, then both
commit → zero admins / zero primaries. **Fix (mix by shape):**

- **Single-UPDATE where expressible.** `setPrimaryDomain` becomes one statement —
  `UPDATE domains SET is_primary = (id = $target) WHERE project_id = $pid` — so the
  flip is atomic and the partial-unique `(project_id) WHERE is_primary` backstops it.
- **`SELECT … FOR UPDATE` over the candidate set where it's count-then-decide.**
  `updateUserAdmin` and `assertAdminCoverage` lock the candidate rows (the admin set /
  the capability-holder set) for the duration of the tx, so a concurrent demotion
  blocks until the first commits and then re-evaluates against the post-commit count.

Each gets a **two-concurrent-demotion test** (fire both, assert exactly one wins and
the invariant holds).

(The `projectOrder`/`folderOrder` array-race the original §1 listed here is **GONE** —
they're ordering junctions now, §1.)

---

## 5. Sortable identity — `seq` columns

Append-only collections sorted by timestamp are not totally ordered: two rows written
in the same millisecond tie, and a lexicographic `createdAt` sort returns them in
arbitrary order. Add a **`bigint` identity column `seq`** to `activities`,
`deployments`, and `backup_runs` (exactly like `deployment_logs` already has its
`id bigint identity`). Then:

- **All sorts** become `ORDER BY created_at DESC, seq DESC` (insertion order breaks
  the tie deterministically).
- **Retention** ([selectDoomedRuns](../../../lib/data/backup-objectkey.ts#L96)) ranks
  "newest" by `(created_at, seq)` — **critical**: a same-millisecond tie ordered by
  timestamp alone could pick the wrong "newest successful run to keep" and then
  `S3Delete` the **wrong object**.
- **Backfill** assigns `seq` in **source-array order** (the JSONB arrays already
  encode insertion order via `Array.push`).

---

## 6. Reads / performance — batch-load is mandatory

Because §1 removed JSONB (every project read JOINs 5–6 child tables) and because the
data layer is going async, the N+1 patterns that were free over an in-memory cache
become real round-trips. **This corrects the original §4 claim that "resolvers/RSC
need essentially zero edits"** — the *shape* of the list resolvers changes.

- **`summarize()` is N+1.** [summarize](../../../lib/data/projects.ts#L166) reads
  `deployments` and `domains` per project (lines 166–183). Fix: a **batch-load
  (dataloader)** — `listProjects` does **1** projects query + **1** deployments-by-
  latest-ids query + **1** `COUNT(domains) GROUP BY project_id`, and `summarize`
  becomes a **pure function** over preloaded data.
- **Generalize batch-load to ALL list-returning field resolvers** — `Project.deployments`,
  `Deployment.logs` (`project.ts:77` fans out `getLogs` per parent today).
- **Push `ORDER BY created_at DESC, seq DESC` + `LIMIT` into SQL** for append-only
  collections (`deployments`, `activities`) — an **explicit signature-change
  exception** (these resolvers gain a limit/cursor param rather than slicing in
  memory).
- **Wrap active-team `membershipFor` in React `cache()`** (the same way
  [getActiveTeamId](../../../lib/membership.ts#L55) is cached) so capability checks
  don't each issue a `SELECT`.

### One aggregate project loader

Add **`loadProjectGraph(id)`** — fetches the project + all child tables in a
**bounded** query set (not 6 separate awaits per call site). Route through it from
`runDeployment`, `renderProjectStack`, `getProjectById`, the dev lifecycle, and the
GraphQL detail resolver.

### SSE generators must stay cookie-free

[summarizeForTeam](../../../lib/data/projects.ts#L260) /
[findProjectSummaryBySlugForTeam](../../../lib/data/projects.ts#L269) take an
**explicit `teamId`** and must **stay cookie-free** once async: query Postgres with the
passed `teamId` directly. They must **never** call `requireActiveTeamId()` /
`getProjectById()` — those call `cookies()` (see
[membership.ts:69](../../../lib/membership.ts#L69)), which is not callable across the
async-iteration ticks of a long-lived SSE response and would **crash the generator
after the first tick**. Add a test that drives the generator across **>1 ping**.

### `deployment_logs` — buffered writer, not insert-per-line

[log()](../../../lib/deploy/build.ts#L58) pushes one `LogLine` per call; a verbose
docker build is **thousands** of lines. Do **not** `INSERT`-per-line (round-trip
storm) and do **not** keep a JSONB array (the write-amplification this whole migration
kills). Instead:

- **Batch buffer + periodic flush** (~250ms or N lines), one multi-row `INSERT` per
  flush. Buffer is **serialized per `deployment_id`**.
- **Guaranteed final flush** on deploy end/error; crash-loss is mitigated by
  `reconcileInFlightDeployments` marking orphaned `queued`/`building` deploys `error`
  at boot.
- The `logs[depId] = []` clear ([build.ts:344](../../../lib/deploy/build.ts) region)
  becomes **drain-then-DELETE** (or a per-deployment **epoch** the flush checks), so a
  late flush can't resurrect cleared lines.

---

## 7. Backfill — per cut-set, fidelity-preserving

**Goal:** at each cut-set's switch moment, copy that cut-set's collections from the
**fresh** JSONB into the relational tables exactly once — idempotently, in FK-safe
order, with **element-granular** verification.

### Per-cut-set, not one event ([supersedes] the single Step-2 backfill)

The original plan ran one big backfill at Step 2. **Reversed:** a single early
backfill would **diverge for weeks** between the copy and the per-module switches (the
JSONB keeps changing). Instead, **each cut-set's PR runs its own collections' backfill,
copying from the live JSONB at switch time.** Step 1 builds the **engine**; the
cut-sets use it.

### The engine (Step 1)

- **Per-cut-set markers** in a `store_migration` table:
  `backfill_leaf` / `backfill_identity` / `backfill_project_graph` / `backfill_backups`
  (`name text primary key, completed_at timestamptz`). A cut-set's backfill is a no-op
  once its marker exists; a fresh install writes all markers with zero rows.
- **Cross-process safety via the `scheduler_lease` CAS** reused from
  [lib/backups/lease.ts](../../../lib/backups/lease.ts). **But the existing CAS is a
  non-blocking try-once** (a 2h staleness window, no real heartbeat loop, "loser
  returns false immediately"). The backfill needs a **real poll-for-marker loop**: a
  loser instance must **block until the marker exists** before its reconcile / scheduler
  touches the relational tables — otherwise it reads half-copied data — and a long copy
  must not be **stolen mid-flight**. Add that polling wait around the CAS.
- **FK-ordered copy transaction** (the order in §2) + **element-granular reconciliation
  assert** (below).
- Gated inside `ensureStoreReady()`, **idempotent across boots** via the marker. **Not
  a 500 source** — Decision 20/23.

### Fidelity: normalize BEFORE exploding into strict child tables

Store rows are **never rewritten today** (projects are normalized on *read*, e.g.
[projects.ts:148](../../../lib/data/projects.ts#L148), but the stored shape stays
legacy). So a raw legacy row would violate the **NOT-NULL child columns** at INSERT.
The backfill MUST run the **per-entity read-time normalizers first**:

- `normalizeProject` composing `normalizeBuildConfig` (`nodeVersion → runtimeVersion`;
  missing `buildMethod`/`methodSettings` reseeded) +
  [normalizeVolumes](../../../lib/data/projects.ts#L83) (drop mountless entries).
- Make the **`dockerfile → github/git` source remap** part of that **shared**
  normalize (it already lives in [normalizeProject](../../../lib/data/projects.ts#L125)),
  **not bespoke backfill SQL**.

### Coerce legacy enum-ish values, don't reject

Write paths are un-validated (framework `as never`, `buildConfigFor → undefined` for
unknowns, `source="dockerfile"` persists). At backfill **coerce, never reject**:
unknown `framework → 'other'`, `buildMethod → framework default`,
`imageKind → 'preset'`, `dev_status → 'off'`; run
[cleanCapabilities](../../../lib/data/members.ts#L90) and `sanitizeTargets` first.
This is why §1 keeps `framework`/`build_method` as plain **text (no CHECK)** and
`entrypoint`/`cert_provider`/`source`/`volume.type` **nullable**.

### Orphan handling — the live `deleteProject` bug

[deleteProject](../../../lib/data/projects.ts#L929) / `deleteProjects` **do NOT
cascade** `d.backups` and **do NOT prune** `sharedEnvGroups.projectIds` (verified
projects.ts:929–941: it filters `deployments`/`envVars`/`domains`/`logs`/`projectOrder`
but never `backups` or shared-group `projectIds`). So the JSONB carries **dangling
project ids** that would **FK-violate the backfill and roll back the whole
transaction** → the instance becomes **un-migratable**, and a count-only assert is
**blind** to it. Fix all three:

- **(a)** Backfill **prunes** orphan project-target backups + dead `sharedEnvGroup`
  `projectIds` **before** insert.
- **(b)** Fix the **live `deleteProject` cascade** (cascade backups + prune shared-group
  project ids) in the **project-graph cut-set**.
- **(c)** The reconciliation assert becomes **element-granular**, not row-count:
  - sum `group.projectIds`, `variables`, `logs[*].length`;
  - **byte-equality** of `mounts.content`;
  - **structural equality** of `volumes` incl. the `type` discriminant;
  - **exhaustive** `BuildMethodSettings` column coverage via
    `satisfies Record<keyof BuildMethodSettings, …>` (so a new settings field can't be
    silently dropped);
  - **every FK resolves**.
  A mismatch **aborts the cut-set's backfill transaction** (crash → full rollback →
  clean re-run).
- Derive `expose := exposes[0]` in the **row-assembler**, don't store it independently
  (Decision 14, also §2 `projects`).

### Fate of the old `deplo_state` row

- **Keep it untouched** through the migration (don't drop `deploState`/`schedulerLease`
  from `schema/legacy.ts`). It is the rollback artifact **only for the leaf cut-set and
  earlier** — once a non-leaf cut-set switches, a JSONB whole-document write would
  clobber migrated collections (§3), so reverting past that point is fix-forward, not
  roll-back.
- A **final, much-later cleanup** (Step 7) drops `deplo_state`, the legacy code, and
  `schema/legacy.ts` after production soak.

---

## 8. Test backend & migration mechanics

### Step -1 GATE — spike pglite FIRST

Before any schema work, a **throwaway test** must exercise every Postgres feature the
plan leans on, because today tests run **pure in-memory with no SQL at all**
([lib/db/pg.ts:11-16](../../../lib/db/pg.ts)) — pglite is not currently a dependency.
The spike must prove:

- partial-unique (`WHERE is_primary`, `WHERE status='pending'`);
- expression index `UNIQUE(lower(email))`;
- `ON CONFLICT … RETURNING`;
- `bigint` identity columns;
- `pgEnum`;
- conditional-rollback tx (`UPDATE … WHERE status='pending' RETURNING` → 0 rows →
  throw → `ROLLBACK`);
- the multi-row **primary FLIP** (`SET is_primary = (id = $target)`);
- the **timestamp type-parser round-trip** (write `nowIso()` → read back canonical
  `T…Z`, §1).

**All green → pglite becomes the test backend under `NODE_TEST_CONTEXT`.** Any
divergence → **Testcontainers / real Postgres** (Docker is already the product's hard
prerequisite). This is a **paradigm change**, not config: from the first Drizzle module,
`npm test` (`node --test`) can no longer run SQL-free.

#### GATE RESULT (2026-06-24) — PASSED ✅, pglite is the test backend

The spike ([lib/db/pglite-spike.test.ts](../../../lib/db/pglite-spike.test.ts),
`@electric-sql/pglite@0.5.3` added as a bun devDependency) validated all 8 features
above: **10 checks green, full suite 392 pass / 0 fail**, the spike coexisting with the
existing SQL-free in-memory tests. No Testcontainers fallback needed. The spike is a
**throwaway** (raw `PGlite`, not the not-yet-existing Drizzle client) — delete it once
Step 0/1 land the real schema + a Drizzle test harness. Two findings carry into the
next steps:

- **The timestamp choke point must be installed in TWO places, not one.** §1 frames the
  type parser as a single node-postgres choke point in `pg.ts` (OIDs `1184`/`1114`).
  pglite does **NOT** use node-postgres's global `pg.types` registry — by default it
  returns a `timestamptz` as a JS **`Date`** (node-postgres returns a space-separated
  `'…+00'` string); both break the 15+ lexicographic `createdAt` sorts. pglite has its
  **own** `parsers` constructor option keyed by the same OIDs. The gate proved the
  equivalent override (`v && new Date(v).toISOString()`) yields canonical `T…Z` and that
  mixed-origin timestamps sort correctly. **Step 0 action:** install the parser in both
  the production node-postgres client (`pg.ts`) **and** the pglite test client, sharing
  one `isoTimestampParser` helper so the two regimes can't drift.
- **Plain `timestamp` (no tz) round-trips to a different hour — use `timestamptz`
  everywhere for `*_at`.** In the spike a `timestamp`-without-tz column read back an
  ISO write at a shifted hour (input interpreted without an offset), while `timestamptz`
  round-tripped byte-for-byte. This confirms §1's `withTimezone: true` convention for
  all `*_at` columns and the legacy-drift reconciliation in §8 (align `deplo_state`/
  `scheduler_lease` declarations to the real `timestamptz` runtime type).

### Migration runs as an explicit step — NOT inside `ensureStoreReady`

Migration does **NOT run in production today** (drizzle-kit is a *devDependency*, the
Dockerfile `CMD` is `node server.js`, there is no migrate step). Decision:

- **At scale:** migration runs as a **dedicated step in the Docker image BEFORE
  startup** (entrypoint / init-container).
- **For now (non-Docker dev):** run it manually via **`npm run db:migrate`**. A known
  operational **TODO**, recorded as such.
- It is **NOT** placed inside `ensureStoreReady()` — a migration failure there would
  500 auth/webhook/agent-bootstrap **for the life of the process** (the single-flight
  caches the rejection). Keep migration out of the request path.
- Step 1 (table defs) **prerequisite:** the migration must have been applied before any
  code reads the new tables.

### Reconcile the two table-creation regimes (latent drift)

There are **two** DDL regimes today and they **drift**: `schema.ts` declares
`deplo_state.updated_at` as `timestamp` (no tz), but
[document-store.ts:21](../../../lib/db/document-store.ts#L21) creates it `timestamptz`;
same risk for `scheduler_lease` ([lease.ts:98](../../../lib/backups/lease.ts#L98) plain
`timestamp`). Before `db:generate` includes `schema/legacy.ts`:

1. **Align the Drizzle declarations to the real runtime type** (`withTimezone: true`
   where the runtime DDL uses `timestamptz`).
2. **Generate a baseline migration reflecting current DB state** (NOT a re-create).
3. **Remove the runtime `CREATE TABLE IF NOT EXISTS`** so **one regime owns creation**.

### Async reconcile at boot ([instrumentation.ts](../../../instrumentation.ts))

The reconcile calls in `register()` become async. Ordering matters:

- `reconcileInFlightDeployments` **may be floated** (true fire-and-forget).
- `reconcileInFlightBackupRuns` **must be AWAITED before `startBackupScheduler`** —
  [instrumentation.ts:31](../../../instrumentation.ts#L31) requires the reconcile to
  complete first, or the first scheduler tick reads an un-reconciled `running` run.
  "Deliberately-floated" applies **only** to genuinely fire-and-forget paths.
- Add a **startup self-check** that the expected relations exist, surfacing a **clear
  operator message** instead of a generic 500, and **re-arm the `ensureStoreReady`
  single-flight on failure** (so a transient DB blip doesn't permanently cache a
  rejected promise).

### Rewrite the store-coupled tests inside the cut-sets ([supersedes] "defer to Step 7")

`reconcile.test.ts` and `scheduler.test.ts` seed/assert via `store.read/mutate/reseed`
(deleted at Step 7). **Budget their rewrite to a Drizzle test-seed helper in the
cut-set PRs that asyncify those reconcile/scheduler paths** — not deferred. (cut-set (c)
owns the deployment reconcile; cut-set (d) owns the backup-run reconcile + scheduler.)

---

## 9. Phased steps

Each step is independently shippable and keeps `npm test` green — but the test backend
is now pglite (Step -1), not SQL-free.

**Step -1 — GATE: spike pglite (throwaway).** §8. Validate partial-unique, expression
unique, `ON CONFLICT … RETURNING`, bigint identity, pgEnum, conditional-rollback tx,
the multi-row primary flip, and the timestamp type-parser round-trip. **All green →
pglite is the test backend; any divergence → Testcontainers.** Nothing else proceeds
until this passes.

**Step 0 — Drizzle client + schema scaffolding + drift reconciliation (no behavior
change).** Add `lib/db/client.ts` (Drizzle over the existing `getPool()`,
globalThis-pinned) and the **timestamp type parser** in `pg.ts`. Split `schema.ts` into
`schema/auth.ts`, `schema/legacy.ts`, re-exporting `schema`. **Reconcile the two DDL
regimes** (§8): align legacy declarations to the real runtime type, generate a
**baseline** migration, remove the runtime `CREATE TABLE IF NOT EXISTS` from
`document-store.ts`/`lease.ts`. *Test:* the round-trip test passes; `db:generate` shows
no drift.

**Step 1 — Relational table definitions + generated migration + backfill ENGINE
(additive, unused).** Add all tables (incl. every child/junction, `seq` columns,
sentinels) to `schema/control-plane.ts` with FKs/indexes/CHECKs from §2; `db:generate`
emits the `CREATE TABLE` migration. Build the **backfill engine**: the `store_migration`
per-cut-set markers, the `scheduler_lease`-CAS **+ poll-for-marker loop**, the FK-ordered
copy transaction, the **element-granular reconciliation assert**, and the shared
normalize/coerce helpers. Nothing reads the new tables yet; no cut-set has run.
*Test:* a `schema.test.ts` asserts the table set matches the design; an engine test
seeds a `DeploData` doc and runs one cut-set's backfill against pglite, asserting
element-granular fidelity + idempotent re-run + fresh-install marks-done-with-zero-rows.

**Step 2 — Cut-set (a): leaf collections.** Migrate `apiTokens`,
`notificationSettings`, `registries`, `installedApps` **atomically** (schema reads +
writes + per-cut-set backfill + test-seed-helper rewrite) in one PR. The **only**
zero-cost-revert cut-set. *Test:* per-collection data-layer tests against pglite;
backfill fidelity; revert leaves JSONB authoritative.

**Step 3 — Cut-set (b): identity / auth.** `users` + `teams` +
`memberships`(+capabilities) + `registrationLinks` + **`auth.ts`** +
**`members.ts` critical section** + **`membership.ts`** — one PR. Includes the
`createAccountWithTeam` `db.transaction` with the conditional registration-link
`UPDATE … RETURNING`, and the **count-invariant fixes** (`updateUserAdmin`,
`assertAdminCoverage` via `SELECT … FOR UPDATE`). *Test:* two-concurrent-registration
race (one wins), two-concurrent-demotion races for admin coverage + active-admin,
stale-password-login regression (proves the cut-set closed it), backfill fidelity.

**Step 4 — Cut-set (c): project graph.** `projects` (+5–6 child tables) +
`deployments` + `domains` + `envVars` + `logs` + `sharedEnvGroups` + **`build.ts`** +
`dev.ts` + **`folders.ts`** — one PR. Includes `loadProjectGraph`, the `summarize()`
batch-load + list push-down, the **`deployment_logs` buffered writer**, the
`setPrimaryDomain` single-UPDATE flip, `createProject`/`updateProjectBuild`
transactions with **post-commit deploy** (ensureAutoDomain + startDeployment fire only
AFTER commit), the ordering junctions, and the **`deleteProject` cascade orphan fix**.
*Test:* project-delete cascade (no orphaned deployments/logs/env/domains/backups/shared
ids), two-concurrent primary-domain races, SSE generator driven across >1 ping
(cookie-free), buffered-log final-flush + drain-then-DELETE, backfill fidelity.

**Step 5 — Cut-set (d): backups (with/after databases + s3).** Migrate `databases` +
`s3` (their FKs are prerequisites), then `backups` + `backupRuns` — one PR (or two,
databases+s3 then backups, kept adjacent). Includes the **two-tx `executeBackup`**
(agent call OUTSIDE the tx), `reconcileInFlightBackupRuns` (**awaited** before
`startBackupScheduler`), the `(created_at, seq)` retention ordering, and the
scheduler-test rewrite. *Test:* backup start/terminal atomicity, retention picks the
right object under a same-millisecond tie, reconcile-before-scheduler ordering, backfill
fidelity.

**Step 6 — Cutover: delete the cache and JSONB write path.** Remove the `globalThis`
`StoreState` cache, `queuePostgresWrite`, `writeChain`, `state.dirty`, the `load()`
seed-then-adopt crutch, and `read`/`mutate`. `ensureStoreReady()` keeps only the
backfill gate (now a no-op once all four markers exist). Update the doc comments in
[lib/store.ts](../../../lib/store.ts) and
[lib/graphql/context.ts:42](../../../lib/graphql/context.ts#L42). **Leave
`deploState`/`document-store.ts` in place** (frozen snapshot, rollback artifact for the
period before any non-leaf cut-set — see §3/§7). *Test:* full `node --test` against
pglite; manual smoke of register/deploy/backup flows.

**Step 7 — (much later) Drop the JSONB legacy.** After production soak, drop
`deplo_state`, `document-store.ts`, the `store_migration` table, the `normalize`/`migrate`
JSONB code, and `schema/legacy.ts`. Separate, deferred PR.

---

## 10. Risks & rollback

- **Half-migrated clobber (the cut-set hazard).** Because `saveDocument` writes the
  WHOLE document (§3), a not-yet-migrated module's `mutate()` overwrites migrated
  collections with stale cache data. Mitigation: migrate by **cut-set** (collection +
  every reader/writer in one PR), so no module straddles the JSONB/relational boundary
  for any collection. Only the 4 leaf collections are zero-cost-revert; everything else
  is **fix-forward**.
- **Count-invariant lost updates.** No constraint expresses "keep ≥1". Mitigation:
  single-UPDATE (primary flip) / `SELECT … FOR UPDATE` (admin coverage), with
  two-concurrent-demotion tests, landing in the **same PR** as each cut-set (§4).
- **Timestamp ordering corruption.** `mode:"string"` is not byte-for-byte; mixed
  legacy-`T`/new-space strings invert 15+ lexicographic sorts (§1). Mitigation: the
  node-postgres **type parser** (single choke point) + a round-trip test BEFORE any
  module swap (Step 0, validated in the Step -1 spike).
- **Same-millisecond tie deletes the wrong S3 object.** Retention ordered by timestamp
  alone is non-deterministic. Mitigation: `seq` columns + `(created_at, seq)` retention
  ordering (§5).
- **Agent RPC inside a transaction.** Wrapping a dump/teardown in `db.transaction`
  holds a connection + locks for the whole agent call. Mitigation: **two short txs with
  the agent call between** (`executeBackup`, `deleteDatabase`, `deleteProject`,
  `restore`), and **keep the keyed-mutex** (it orders agent state, not rows) (§1).
- **Backfill un-migratable instance (dangling FKs).** The live `deleteProject` bug
  leaves dangling backup/shared-group project ids → FK violation rolls back the whole
  backfill. Mitigation: backfill prunes orphans before insert **and** the live cascade
  is fixed in cut-set (c) **and** the assert is element-granular, not row-count (§7).
- **`ensureStoreReady` / migration as a 500 source.** A failure cached by the
  single-flight 500s the whole process. Mitigation: migration is an **explicit step
  outside the request path** (`db:migrate` / init-container), a **startup self-check**
  with a clear operator message, and a **re-armed single-flight on failure** (§8).
- **Test backend paradigm change.** From the first Drizzle module, SQL-free in-memory
  tests stop working. Mitigation: the Step -1 **pglite gate** (or Testcontainers on any
  divergence); store-coupled tests (`reconcile`/`scheduler`) rewritten to a Drizzle
  test-seed helper **inside** their cut-set, not deferred (§8).
- **N+1 over async child-table JOINs.** No-JSONB + async makes every per-parent fan-out
  a round-trip. Mitigation: **mandatory** batch-load (dataloader) for all list
  resolvers, `loadProjectGraph` aggregate loader, SQL `LIMIT` push-down for append-only
  collections, `cache()`-wrapped `membershipFor` (§6).
- **SSE generator crash.** A cookie-reading call across iteration ticks crashes the
  stream after the first ping. Mitigation: `summarizeForTeam`/`findProjectSummaryBySlugForTeam`
  stay explicit-`teamId` + cookie-free; tested across >1 ping (§6).
- **drizzle migration vs db:push.** Production uses `db:generate` + `db:migrate`
  (versioned SQL), never `db:push`. Mitigation: CI asserts `db:generate` produces no
  pending diff; the two DDL regimes are reconciled to one in Step 0 (§8).
