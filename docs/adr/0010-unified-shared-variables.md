# ADR-0010: Unified shared variables (one model, three sharing modes)

- **Status**: Accepted — 2026-07-12.
- **Amends**: the env-var scoping in [ADR-0008](0008-projects-own-environments-services-are-the-deployable-unit.md)
  (environment-scoped vars) and the glossary ([CONTEXT.md](../../CONTEXT.md)).

## Context

The platform had grown **five** separate environment-variable systems, surfaced as
five tabs on `/variables` and a dedicated "Shared groups" button on every app:

| System | Storage | How it reached an app |
|---|---|---|
| Per-app standalone | `env_vars` | the app owns the row |
| Shared **groups** | `shared_env_groups` (+ vars/apps/targets) | a per-app junction |
| Environment-scoped | `environment_env_vars` | the app's `environment_id` membership |
| Team globals | `team_global_env_vars` | every app in the team |
| Instance globals | `instance_env_vars` | every app of every team (admin) |

Three of these are really "one variable, shared to several apps," modelled three
different ways — confusing to use and to reason about. Product direction: collapse the
surface to **App** and **Shared**, and give a shared variable a small, explicit sharing
model matching Vercel / Railway / Cloudflare.

## Decision

1. **One individual `shared_env_vars` row = one shared variable** (not a group). It is
   owned by a team, carries a value + type, and reaches an app through any of **three
   non-exclusive sharing modes** plus a **per-app link**:
   - **team-wide** (`team_wide` bool) — every app in the team;
   - **environment** (`shared_env_var_environments`) — apps whose `apps.environment_id` ∈ the set;
   - **project** (`shared_env_var_projects`, a whitelist) — apps whose `apps.project_id` ∈ the set;
   - **per-app link** (`shared_env_var_apps`) — an explicit link attached from the app UI.
   At least one **mode** is required (enforced in the data layer). An orthogonal
   `shared_env_var_targets` (production/preview/development) gates the runtime, defaulting
   to all three.

2. **In-scope vars auto-apply.** A newly created app in a shared environment/project/team
   inherits the variable with no extra step. The app's "Shared" tab additionally links a
   shared variable to that one app.

3. **Absorb** `environment_env_vars` → environment-mode shared vars and
   `team_global_env_vars` → team-wide shared vars. **Instance globals stay** a separate
   admin-only, cross-team system (untouched).

4. **Deploy precedence (low→high, later wins on a key collision):**
   `instance globals < team-wide < environment < app's own var < project < per-app link`.
   This preserves every migrated system's old slot exactly: team-global and environment
   vars still sit below an app's own var; a shared group (→ per-app link) still overrides
   it. Same-key collisions within one layer break by `created_at ASC`. The single seam is
   `lib/deploy/env-resolve.ts::resolveEnvEntries`, shared by the production stack, the dev
   container, and the backup snapshot.

## Migration (0027 create + backfill, 0028 drop)

Deterministic, source-tagged ids (`svar_<md5(tag:source)>`) let junction backfills join
back without random ids:

- **team-global → team-wide** (copy targets);
- **environment var → environment-mode** with `targets = all three` (reproduces the old
  membership = every-runtime behaviour);
- **shared-group var-key → per-app-link** (links = the group's apps; targets = the group's,
  or all three when it had none). Mapping to a *link* is what preserves both the exact
  attached-app set AND the "overrides app-own" precedence.

Parity is asserted by `lib/db/shared-env-migration.test.ts` (replays to 0027, seeds the old
world incl. a colliding key, checks the resolved key→value map is byte-identical per app
per target) and `lib/deploy/env-resolve.test.ts` (the precedence unit parity).

## Consequences

- The `/variables` page is two team-facing tabs (App, Shared) + an admin "All teams" tab.
  The dedicated "Shared groups" button on the app Environment tab is gone; shared vars are
  linked from the Add-variable modal's "Shared" tab.
- `lib/data/shared-env.ts`, `lib/data/environment-env.ts`, and their GraphQL modules are
  removed; `lib/data/shared-vars.ts` owns the unified model. `global-env.ts` is instance-only.
- Behaviour change (deliberate): the three modes now auto-apply to *future* apps in scope,
  where a shared group previously required attaching each app. Existing links are preserved,
  so nothing loses a variable at migration time.
