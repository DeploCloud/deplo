# ADR-0027: A shared variable reaches many teams, and the instance layer is one of them

- **Status**: Accepted - 2026-08-28.
- **Amends**: [ADR-0010](0010-unified-shared-variables.md) §3 ("instance globals stay
  a separate admin-only system") and §4, and
  [ADR-0012](0012-shared-variables-are-opt-in-per-app.md) §2/§3 (the auto-injecting
  layer is no longer admin-only, and it now has a name).

## Context

A variable could be shared with **exactly one team**, or with **every team on the
instance**, and those were two different systems with nothing in between:

|                 | storage                         | who writes it           | how it reaches an app                      |
| --------------- | ------------------------------- | ----------------------- | ------------------------------------------ |
| Shared variable | `shared_env_vars` + 4 junctions | `manage_env`, team-wide | only the explicit per-app link             |
| "All teams"     | `instance_env_vars` + targets   | instance admin          | auto-injected into every app of every team |

A lead running two teams could not share one SMTP password with both without
asking an instance admin to push it to everybody, or writing it twice. And the
third `/variables` tab existed only to hold the second system.

## Decision

1. **The team-wide flag becomes a set.** `shared_env_var_teams(var_id, team_id)`
   replaces the `team_wide` boolean: one row per team the variable reaches. One
   row is exactly what `team_wide = true` meant.

2. **`shared_env_vars.team_id` is ownership and is NULLABLE.** `NULL` =
   instance-owned, which is what a migrated global becomes. Ownership decides who
   may EDIT; the junction decides who SEES and RECEIVES. A team that a variable
   merely reaches sees it read-only, with the owner named, and may link it to its
   own apps - linking is the receiving team's opt-in, not an edit of someone
   else's row.

3. **Reaching one team suggests; reaching more than one injects.** With one team
   ADR-0012 holds unchanged - the scope offers, the per-app link injects. With two
   or more (or when the instance owns it) the variable is added to every app of
   every team it reaches, with no link, in the **lowest** precedence slot, exactly
   where instance globals sat. The wizard's Review step says which of the two is
   happening, and the sentence changes as teams are ticked.

4. **`auto_inject` is a COLUMN, never `count(teams) > 1`.** Two failures a derived
   rule causes: a single-team instance would stop injecting every migrated global,
   and deleting one of two teams would cascade a junction row away and silently
   disarm the variable in the surviving team. Same shape as ADR-0015's "the intent
   to be scoped is a column, not zero rows".

5. **The gate is per team.** A team may be ticked only by a caller holding
   `manage_env` across the WHOLE of that team - membership, no folder/project
   scope, the token's own capabilities and its `wholeTeamIds`. `membershipFor`
   cannot answer this: `clampToToken` bails out for a team other than the
   request's and returns the member's unclamped set, so
   `holdsTeamWideCapability` reads the token grant itself.

6. **`instance_env_vars` is folded in and dropped** (0131 backfills, 0132 drops -
   the 0027/0028 shape), and `/variables` goes back to two tabs. `createTeam`
   inserts a reach row for every instance-owned variable, so "instance-wide" keeps
   meaning instance-wide rather than "the teams that existed on upgrade day".

## Consequences

- **Auto-injection stops being instance-admin-only.** Anyone holding team-wide
  `manage_env` in two teams can now introduce a key into every app of both,
  including apps inside folders they cannot open. It sits at the lowest slot, so
  it can never overwrite a value an app set for itself - but it can add one. That
  is the deliberate cost of the feature; the per-team gate in §5 is what bounds it.
- An auto-injected variable is **visible read-only on the app's Environment tab**,
  which instance globals never were. Invisible configuration is the failure mode
  ADR-0012 exists for, and the old layer had it.
- `saveSharedVar` and `deleteSharedVar` write **one activity row per team the
  variable reaches**, naming the author's team, so "where did this variable come
  from" is answerable in the receiving team's own trail.
- Deleting a team destroys the variables it owns, including ones another team is
  running on. The delete confirmation counts them.
- `SaveSharedVarInput.teamWide` becomes `teamIds`, and `GlobalEnvVar`,
  `instanceEnv`, `upsertInstanceEnv` and `deleteInstanceEnv` leave the schema.
- Parity is pinned by `lib/db/instance-env-migration.test.ts` (the resolved
  key -> ciphertext map per app per target, before and after) and the cross-team
  boundary by `lib/data/shared-var-cross-team.test.ts`.
