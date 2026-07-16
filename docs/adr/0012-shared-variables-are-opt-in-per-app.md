# ADR-0012: Shared variables are opt-in per app (scopes suggest, links inject)

- **Status**: Accepted — 2026-07-16.
- **Amends**: [ADR-0010](0010-unified-shared-variables.md) §2 ("in-scope vars
  auto-apply") and §4 (deploy precedence). The unified one-variable model, the
  storage (`shared_env_vars` + junctions) and the migration are untouched.

## Context

ADR-0010 made a shared variable's three sharing modes (team-wide / environment /
project) **auto-apply**: any app the mode covered — including every app created
later — silently inherited the variable on its next deploy. In practice that is
the wrong default: a team-wide `DEBUG=1` or a project-wide `DATABASE_URL`
landing in an app nobody pointed it at is invisible configuration, and the app's
developer never chose it. The owner's direction: **no variable is ever added to
an app unless a developer explicitly opted the app in.**

## Decision

1. **Only the per-app link injects.** The single mechanism through which a
   shared variable reaches an app's builds/runtime is the explicit
   `shared_env_var_apps` link — created from the app's Add-variable modal
   ("Shared" tab), from a shared row's actions, or by the wizard's "Specific
   apps" step (picking apps by hand IS the explicit choice, wherever it is
   made from).

2. **The three modes become AVAILABILITY scopes.** `team_wide`,
   `shared_env_var_environments` and `shared_env_var_projects` now only say who
   the variable is *offered* to: the app UI shows a covered variable as
   suggested ("Shared with this app's project"), sorted and labelled, but never
   applies it. Scopes are suggestions, not gates — any team variable remains
   linkable from any app (this is also what keeps migration-0027 link-only vars
   and out-of-scope escape-hatch links working unchanged).

3. **Deploy precedence collapses to** (low → high, later wins on a key
   collision): `instance globals < app's own var < linked shared var`. The link
   keeps the top slot it has held since the shared-groups era: an explicit
   attachment overrides the app's own value. Within the shared layer,
   `created_at ASC` still breaks same-key collisions. The seam stays
   `lib/deploy/env-resolve.ts::resolveEnvEntries`.

4. **`saveSharedVar`'s reach rule is unchanged in shape**: a variable must be
   shared *with* something — ≥1 availability scope or ≥1 link — so an authored
   value can never strand unreachable-and-invisible.

## Consequences

- **Deliberate behaviour change on live instances**: a variable that reached
  apps only through a scope (e.g. the old team-globals migrated to team-wide)
  stops injecting on the next deploy. It is not lost — it shows as suggested on
  every covered app's Environment tab, one click from opting in. No backfill of
  links is performed: backfilling would itself be an auto-add, the exact thing
  this ADR removes.
- Instance globals (admin-only "All teams" vars) are **untouched** — they remain
  the one deliberate, operator-level auto-injection layer.
- `AppSharedVar` (GraphQL) loses `via`/`applied`/`inherited` and gains
  `inScope`/`scope`; `applied` ≡ `linked` now. The app table's shared badge
  reads plain "Shared"; every shared row is removable from the app
  ("Remove from this app"), since every one is an opt-in.
- The migration-parity contract of ADR-0010 narrows: parity holds for
  link-derived vars (old shared groups); scope-derived vars intentionally stop
  injecting (`lib/db/shared-env-migration.test.ts` pins the new expectations).
