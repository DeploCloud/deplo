# ADR-0008: Projects own Environments; the deployable unit is a Service

- **Status**: Proposed — 2026-07-07
- **Amends**: [ADR-0001](0001-ports-are-per-target-not-a-single-scalar.md) (the two-scalar
  `build.port`/`dev.port` model narrows to a per-environment port)
- **Touches**: the glossary ([CONTEXT.md](../../CONTEXT.md)), the whole control-plane, and the
  deploy pipeline — but **not** the agent wire contract (see Decision 4).

## Context

Today the tenancy tree is **Team → Folder(s) → Project**, where a **Project** is the *deployable
app* (server, framework, source, one production stack + one dev container, deployments, domains,
env vars). "Environment" is **not an entity** — it is the fixed enum
`EnvTarget = production | preview | development` ([lib/types.ts:750](../../lib/types.ts#L750)) woven
through three pure seams — env selection ([env-resolve.ts](../../lib/deploy/env-resolve.ts)),
ports ([ports.ts](../../lib/deploy/ports.ts)), and the deployment axis
(`deployments.environment`) — plus the dev-container renderer ([dev.ts](../../lib/deploy/dev.ts)).

We want the **Railway model**: a top-level, folder-like **container** that owns a customizable set
of **Environments** (default Development / Preview / Production), each a *fully isolated deploy
target* — its own containers, URL(s), git branch, and env vars. Folders live inside the container;
the container cannot nest in another container. Adoption is **additive** — existing top-level
folders and un-grouped apps keep working with no forced migration.

The blocking problem: the word **"Project"** is already the deployable app, and the codebase (and
its glossary) is militantly precise about naming. The new container needs that word.

## Decision

### 1. Rename the deployable app: **Project → Service**

Everywhere — DB tables/columns, `lib/types.ts`, `lib/data/*`, `lib/graphql/*`, UI routes/components,
and the glossary. The target tree is **Team → Project (container) → Folder(s) → Service(s)**.

- **IDs stay.** `newId("prj")` keeps minting Service ids ([lib/ids.ts](../../lib/ids.ts) prefixes are
  opaque — nothing parses them), so no PK/FK **value** rewrite. Existing `prj_…` rows remain Services.
- **The rename is entity-aware, never a blind `sed`.** Two words are already overloaded and must be
  left alone: (a) `domains.ts` uses **"service"** for *compose* services
  (`composeServiceNames`, `RoutableDomain.service`, `domains.service`) — untouched; (b) the enum
  value **"development"** and `Deployment.environment` collide with the new *Environment* entity —
  disambiguated per Decision 3.

### 2. New entity: **Project** (the container)

A top-level, team-scoped, **folder-like** grouping — modeled on [`folders`](../../lib/db/schema/control-plane.ts#L159)
(name, `color`, `owner_user_id` + per-container **grants**, team-wide ordering) — that additionally
**owns Environments**. New tables `projects`, `project_grants`, `team_project_order` (the names are
*reclaimed* after the Service rename frees them). New id prefix **`prc`**. A Project has **no
`parent_id`** (Projects never nest). The owner+grants authorization is cloned verbatim from
[folder-access.ts](../../lib/data/folder-access.ts); creating a Project needs the **`deploy`**
capability, exactly like a folder.

Folders and Services gain a nullable `project_id` FK (`ON DELETE SET NULL`) — top-level items keep
`NULL` (additive). A Service may sit **directly** under a Project or inside a Folder inside a Project.

### 3. New entity: **Environment** (a per-Project isolated deploy target)

New table `environments` (`project_id` FK CASCADE, `name`, `slug`, `kind`, `git_branch`,
`is_default`, `position`). New id prefix **`environ`** (`"env"` is taken by env vars). On Project
create, seed **Development / Preview / Production**; all are renamable/customizable and new ones can
be added.

`kind ∈ {development, preview, production, custom}` is the **well-known-role discriminant** — the
bridge that keeps the legacy world resolving: team-/instance-global and shared env vars (which span
all services and cannot name a specific project's `environment_id`) target **by kind**; the legacy
`EnvTarget` enum maps onto it. The enum therefore **survives as `Environment.kind`**, not as the
source of truth.

### 4. Per-(Service, Environment) runtime — a **join**, not a row-per-env

Per-environment runtime state (status, URL, `latest_deployment_id`, per-env deploy config) lives in a
new **`service_environments`** join keyed `(service_id, environment_id)`. A Service is **not**
instantiated once per environment.

**Deploy key** (the slug's role on the wire): the seeded **Production** environment keeps the **bare
`deplo-<slug>`** — so every already-running container, on-disk `<slug>.yml`, `deplo-<slug>-<name>`
volume, and issued cert is **byte-identical and untouched** (the pipeline's whole reroute contract
depends on this). Every **other** environment gets **`deplo-<slug>__<envSlug>`**, using the
collision-proof `__` separator [routing.ts](../../lib/deploy/routing.ts#L110) already engineers.
Because the agent keys every stack op on `slug`, this needs **no proto change**; the
`deplo.project=<serviceId>` label stays a **frozen wire constant** (renaming it would strand live
stacks from teardown/console/health). An optional additive `deplo.environment=<id>` label for
agent-side observability is deferred.

### 5. Environment-parameterized pipeline, one seam preserved

`resolveEnvEntries(target, …)` becomes `resolveEnvEntries(environment, …)`: per-service vars match
`environment_id`, globals/shared match `environment.kind`. This stays the **single** resolver both
the production stack and the dev container use, so the two runtimes can never drift
([env-resolve.ts:10](../../lib/deploy/env-resolve.ts#L10)). Ports move per-environment (amends
ADR-0001). `deployments.environment` (text) → **`environment_id`** FK; `routableForDeploy`'s
`environment === 'production'` fork dissolves — every environment routes to its own registered
domain set. Git branch resolves from the Environment.

### 6. Additive / legacy coexistence

A Service with **no Project** has no Environment rows → it keeps **today's single-runtime behavior**
(bare `deplo-<slug>`, the `EnvTarget` enum, one production stack + one dev container) — an *implicit
Production*. When a Service joins a Project, its live runtime is adopted as the **Production**
environment (bare `<slug>` preserved → zero churn), and it gains the project's other environments.

### 7. The Development environment IS the dev container

The seeded **Development** environment's runtime kind = today's mutable, hot-reload **dev container**
(`deplo-dev-<slug>`, workspace, SSH gateway, VS Code tunnel, preview route) rather than an
image-baked stack. `DevConfig` becomes that environment's config. This avoids two parallel "dev"
concepts.

### 8. UI: `?env=` switch; `/projects` freed for the container

Environment switching rides a **`?env=<envSlug>`** query param (matching the codebase's `?folder=` /
`?tab=` conventions — minimal route churn), sourced from the URL. Service detail moves to
**`/services/[slug]`**; **`/projects/[slug]`** becomes the container detail; **`/`** (Overview) stays
the mixed workspace root and gains a third card kind (Project container) alongside top-level folders
and un-grouped services.

### 9. GraphQL is a hard versioned break

The rename frees `projects` / `project` / `createProject`, which the container immediately reclaims —
so **no `@deprecated`-alias dual-run window exists**. External callers via the MCP relay (which
forwards `deplo_` tokens verbatim to this API) must update field names. This is **durably
authorized** (the chosen scope was "rename … GraphQL … everywhere"); curated examples and MCP tool
defs update in lockstep.

## Consequences

**Good**: a clean Railway-style model; the single env-resolve seam and opaque-id data survive intact;
**zero churn to live stacks and no agent-repo change**; fully additive adoption.

**Costs / risks**: a large **build-atomic** rename (Phase 1 must land whole); ADR-0001's two-scalar
port simplification is superseded; the **external GraphQL API breaks**; env-scoped domains multiply
Traefik router/cert surface (per-env ACME issuance); the dev-container→Development reconciliation is
invasive; `schema.test.ts` (exact table/constraint names) and `curated-examples.test.ts` must move in
lockstep; the drizzle rename migration must be **hand-authored** (`ALTER … RENAME`) or drizzle-kit
will emit `DROP+CREATE` (data loss).

## Phased plan (each phase ends green + verified)

- **Phase 1 — Service rename (atomic, no behavior change).** Hand-authored migration `0015`
  (`ALTER TABLE/COLUMN/CONSTRAINT/INDEX … RENAME`), reconciled meta snapshot; `projects→services`
  (+6 child tables), all `project_id→service_id` FKs, indexes, `team_project_order→team_service_order`,
  `backups.target_kind 'project'→'service'` (CHECK + data + code literals). Rename types, data-layer
  files/functions, GraphQL types/ops, UI routes (`/projects→/services`), `components/projects→
  components/services`, inline GraphQL strings, pubsub channel, copy. Keep `newId("prj")`, the
  `deplo.project` label, and `deplo-<slug>` naming. Fix the `isUniqueViolation(e,"projects_slug_uq")`
  string coupling. *Verify*: `bun test` (esp. `schema.test.ts`, `curated-examples.test.ts`),
  typecheck, drive the app.
- **Phase 2 — Project container (additive, no environments yet).** Migration `0016`: `projects`,
  `project_grants`, `team_project_order` + `folders.project_id` / `services.project_id`. New
  `project-container.ts` (CRUD mirroring `folders.ts`) + `project-access.ts` (mirroring
  `folder-access.ts`); `moveFolderToProject` / `moveServiceToProject`. GraphQL module reclaiming
  `projects`/`project`/`createProject`. UI: `/projects` index + `/projects/[projectSlug]` detail
  reusing `ProjectsGrid` scoped to the container, `project-container-card.tsx`, "New project" menu.
  *Verify*: create a project, move a folder/service in, reorder, share.
- **Phase 3 — Environments + pipeline rewire (sub-phased).** `environments` + `service_environments`
  + per-env config; seed 3 on create (backfill existing projects). `deployments.environment→
  environment_id`; env-var scoping → environment (+ kind fallback). Pipeline: per-env deploy key
  (Production = bare `<slug>`), env-parameterized `env-resolve`/`ports`/`routing`/`domains`, per-env
  branch; Environment CRUD + `?env=` switcher; Development-as-dev-container. *Verify*: deploy one
  service to two environments → isolated containers/URLs, per-env vars.

## Proposed glossary (CONTEXT.md)

- **Service** — the deployable app (formerly *Project*): server, framework, source, deployments,
  domains, env vars, one runtime **per environment**. _Avoid_: project (now the container), app
  (reserved for an installed App), component.
- **Project** — a top-level, team-scoped, folder-like **container** that owns **Environments** and
  holds folders/services. Never nests. _Avoid_: folder (a Project owns environments; a folder does
  not), workspace, group.
- **Environment** — a first-class, per-Project **isolated deploy target** (Development / Preview /
  Production + custom): its own containers, URL(s), git branch, env vars. Carries a `kind` role.
  _Avoid_: env target (the legacy enum, now `Environment.kind`), stage, deployment environment.
