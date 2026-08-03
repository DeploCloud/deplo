# ADR-0016: A node capability set overrides the team role inside that node

- **Status**: Accepted — 2026-08-03. Migrations `0064`, `0065`.
- **Amends**: the module contract of `lib/data/folder-access.ts` (which said a
  grant is "NEVER more than the grantee holds at the team level", so "revoking a
  team capability silently revokes it everywhere per-folder"), the **Membership**
  and **Capability** entries in `CONTEXT.md`, and ADR-0015 §2's claim that the
  token intersection needed "no new authorization concept, no new gate at 132 call
  sites".

## Context

deplo gates forty fine-grained capabilities, and until now a person's set in a
team came from exactly one place: the role on their membership. The only per-node
dimension was `folder_grants`, and it could not GIVE anything — every read of it
was intersected live with the grantee's team capabilities, so a grant could only
ever narrow.

That makes the most ordinary team request unexpressible. "Marta runs Prod, and
nothing else" has to be built out of two moves: give her `manage_env` **team-wide**,
then hope no folder grant elsewhere lets her use it. The clamp does not prevent
the over-grant — it *forces* it. A model whose safe path is "widen the role first"
is upside down, and it is the opposite of what the fine-grained split was for.

The second half of the problem is administrative. Roles and per-team capabilities
are editable only from inside the team, by someone who holds `manage_members`
there. An instance admin looking at one person's account has no place to see, let
alone change, what that person can reach across the instance — the honest answer
to "who can touch Prod?" was "ask whoever runs each team", which the mission
explicitly rules out.

## Decision

1. **A node capability set REPLACES the team role's set inside that node, and may
   exceed it.** Precedence is most-specific-wins:

       app grant → nearest ancestor folder → further ancestors → project → membership

   The first rung that says anything wins outright — a union would make "they can
   deploy everywhere except here" impossible, which is half the point. `view` is
   implied at every rung, so an empty result always means "no access" and never
   "read-only".

2. **The live clamp becomes membership EXISTENCE, not membership capabilities.**
   Removing someone from the team, suspending them, or an unmet 2FA policy still
   revokes everything, everywhere, live — every path goes through `membershipFor`
   first. Revoking a single *capability* no longer revokes it everywhere; the
   answer to "take their access away" is "remove them", and the UI says so.

3. **One semantics, not two.** The folder Share dialog writes the same
   `folder_grants` rows, so it is an override too. Two mechanisms writing one
   table with different meanings is precisely what this ADR exists to forbid. What
   keeps it safe is the **granter** bound, which stays: nobody can hand out a
   capability they do not themselves hold on that node, and a grantee may never
   re-share (`requireFolderOwnerOrAdmin`).

4. **Reachability is unchanged.** A Folder stays private to its owner and its
   grantees — an empty capability set is still the folder-not-visible signal. A
   Project and an App have no privacy story today (every member sees every app),
   and they do not acquire one: a grant on either is a capability override and
   nothing more. The one widening is that a folder grant now reaches the whole
   SUBTREE below it, matching the tree the admin ticks in and the way token scopes
   already expand folders.

5. **`NODE_GRANTABLE_CAPABILITIES` bounds what a node may carry.** It is
   `PROJECT_SCOPED_CAPABILITIES` plus `move_apps`, `organize_folders` and
   `delete_folders`. Every team-wide capability is absent, so a node grant can
   never satisfy the last-admin check, mint a token, manage members or roles,
   touch a database, or re-share. A node is never a route back to team
   administration, however it is asked for.

6. **The mode is a column, not "zero rows".** `memberships.granular` records the
   admin's choice. Node rows cascade away with the app or folder they name;
   without the column, "granular with nothing left ticked" would be
   indistinguishable from a plain hand-picked set and the admin page would flip
   its own toggle back. Same shape as `api_tokens.scoped` (ADR-0015 §6) for a
   narrower reason: nothing widens on cascade here, because the base capabilities
   are stored independently of the nodes.

7. **The role still supplies the base.** Granular mode is role **plus** overrides,
   not instead of a role: `memberships.role_id` stays set, so editing a Role keeps
   reaching everyone who holds it and every authorization check stays a read of
   the member's effective set (the invariant `lib/data/roles.ts` depends on).

8. **The token intersection is preserved AT THE NODE.** A node grant replaces the
   membership set and so never passes through `membershipFor`'s own clamp;
   `lib/data/node-access.ts` therefore ends with `clampCapabilitiesToToken`.
   Without that one line a scoped CI token would inherit its creator's grants —
   the exact impersonation ADR-0015 removed. `lib/data/node-access-token.test.ts`
   is what keeps it honest.

9. **One gate, not two.** `requireAppCapability(appId, cap)` folds the team check,
   the app-in-team check and the node check into a single call. The old split
   cannot survive an override: `requireCapability` reads membership capabilities
   and would refuse before the node was ever consulted. The team-wide call sites
   keep `requireCapability` unchanged, which is what stops a node grant from
   leaking into a team-wide action.

## Consequences

- **Existing folder grants now inherit down the folder tree.** A grant on a parent
  reaches its subfolders, which it did not before. Nothing stored changes; the
  live answer does. It is the one genuine widening in this change and worth an
  upgrade note.
- The Share dialog shows the set that was granted rather than a silently narrowed
  copy of it — previously it could report less than it had just saved.
- `ctx.capabilities` in `lib/graphql/context.ts` becomes the union of the role's
  set and every capability reachable through a node grant in the active team. It
  was always documented as "a convenience snapshot, not the security boundary";
  it is now explicitly so, and the boundary is node-precise.
- "Revoke the capability team-wide to revoke it everywhere" stops being true. The
  replacement answer, which an admin must be told in the UI, is "remove them from
  the team".
- `lib/data/folder-access-integration.test.ts` had a test asserting the old clamp.
  It is inverted rather than deleted, so the reversal is recorded where someone
  reading the suite will find it.
- `project_grants` — in the schema since the Project container landed, never read
  or written — becomes live, and `app_grants` joins it (migration `0065`).
