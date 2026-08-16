# ADR-0015: An API token is a principal with its own capabilities

- **Status**: Accepted — 2026-08-03. §3 amended the same day (migrations `0062`, `0063`).
- **Amends**: the "API token" entry in `CONTEXT.md` (which said a token "acts as
  its creator" and "can only ever do what that member's Capabilities allow") and
  the authentication section of `docs/api/graphql.md`. Migration `0061`.

## Context

deplo gates forty fine-grained capabilities for people — `deploy_apps` is not
`configure_apps`, `delete_apps` is its own permission, `reveal_secrets` is
separate from `manage_env` — and then handed out a bearer credential that held
every one of them. `authenticateToken` resolved a `deplo_` token to
`{ userId, teamId }`, the request ran inside `runWithIdentity`, and
`currentCapabilities()` returned the creator's full membership set. A token
minted for a GitHub Action could delete the team.

There was no way to say "this token may only deploy". The create dialog had one
field: a name. That is the opposite of the product's own model, and it is the
single credential most likely to be pasted into a CI secret store, a webhook
config, or an AI agent's configuration file.

## Decision

1. **A token carries its own capability set, and it is mandatory.** Stored in
   `api_token_capabilities`, the same junction shape as
   `membership_capabilities` and `team_role_capabilities`. There is no
   "everything" default: a token created with no capabilities named is view-only.

2. **Effective power is an INTERSECTION, resolved live.** The bearer path
   intersects the member's effective capabilities with the token's, inside
   `membershipFor` — the one function every authorization decision already reads.
   So a token can never exceed its creator, loses a permission the moment they
   do, and nothing has to be re-materialized when a role changes. One
   intersection, no new authorization concept, no new gate at 132 call sites.

3. **A token's scope is a TREE, and "limited" includes reads.** *(amended: it
   started as one team plus a set of projects; migration `0062` made it whole
   teams, whole projects or individual apps, and `0063` added the level most apps
   actually live in — whole FOLDERS, subtree included, expanded at authentication
   time so moving or nesting one takes effect on the next request, with a project
   scope also covering the folders filed under it. Ticked at any depth, with
   nothing ticked meaning every team the creator belongs to. Breadth and depth stay
   separate questions — holding several whole teams restricts nothing inside
   them, and only naming a project or an app strips that team's team-wide
   capabilities. A bearer request acts in ONE of the token's teams, chosen with
   `X-Deplo-Team` and defaulting to the first in scope; the token is managed from
   the team it was created in, and any team it reaches can REVOKE it - which
   deletes the credential, in every team it reached, along with the OAuth consent
   and refresh token of a connection. Revoking was briefly per-team, dropping only
   the acting team's grant; that made one button mean two things and left a token
   somebody had just revoked still answering requests next door, so delete now
   means delete, with the trail written into every team that lost it.)* A
   scoped token cannot READ an app outside its projects, not merely not write
   one — an out-of-scope app answers exactly what a nonexistent id answers, so
   the scope is never an oracle for which ids exist. Enforcement is a pure,
   synchronous predicate (`appScopeWhere` / `inProjectScope`) folded into the two
   existing app ownership gates and the team-wide list queries, plus explicit
   refusals for the team-wide resources that have no per-project meaning.

4. **A scoped token also loses every team-wide capability.**
   `PROJECT_SCOPED_CAPABILITIES` is intersected in the same clamp, so managing
   members, roles, registries, the team itself, and every database capability
   (`databases` carries no `project_id` at all) fall away with no extra code.
   `move_apps` is deliberately in the dropped set: its own description is "move
   an app into a folder, project or another team", which is a token editing its
   own boundary.

5. **Instance administration is opt-in per token.** A new `instance_admin`
   column, grantable only by an instance admin, and mutually exclusive with a
   project scope — `requireInstanceAdmin` never consults team capabilities, so a
   scope could not narrow it, and a switch that does not do what it says is worse
   than an absent one.

6. **The intent to be scoped is a column, not "zero rows".**
   `api_tokens.scoped` exists because deleting a team, project or app cascades its
   scope row away; without the flag an emptied scope would read as "unscoped" and
   silently WIDEN the token to everything. A scope with no nodes left resolves to
   no team at all, so the token stops authenticating rather than quietly widening
   — a 401 is a far easier thing to debug than a credential that authenticates and
   then finds nothing anywhere.

7. **Templates ship in-tree and are not editable.** Five of them (Read only,
   Deploy hook & CI, MCP & AI agents, App automation, Root access) in
   `lib/token-presets.ts`. Unlike Roles — which a team owns, renames and resets —
   a token template that drifts per team is not something we can reason about,
   and "start from an existing token" would mean reading one credential's power
   to author another. Our templates, or from scratch.

8. **A live token's permissions are editable.** The secret is untouched by an
   edit, so tightening a token costs one save instead of a rotation across every
   CI secret, webhook and agent config that carries it. A tightening that costs a
   rotation is a tightening nobody performs, and root tokens would stay root.

## Consequences

- **Breaking API change**: `createToken(name: String!)` becomes
  `createToken(input: CreateTokenInput!)`. There was no safe default to keep it
  compatible with — defaulting to everything is the regression being removed, and
  defaulting to `view` mints a token that 403s everywhere with no explanation.
- Migration `0061` backfills every existing token with its creator's current
  effective capabilities, so **nobody's access changes** on upgrade, and sets
  `instance_admin = false` for all of them (implicit root is what is being
  removed, so it is not carried forward).
- Subscriptions needed a real fix: an async generator body does not inherit the
  async context of whoever created it, so the identity is now re-applied around
  every iterator tick in `lib/graphql/yoga.ts`. Without it a scoped token would
  have streamed an app it cannot otherwise see.
- Servers stay readable by a scoped token. They are explicitly the one shared
  cross-team resource, every server mutation is already instance-admin, and
  `App.serverId` is an exposed field whose decoration would otherwise break.
- Account-level calls (`me`, `myTeams`, `updateProfile`, `revokeSession`) gate on
  `assertUser()` alone and are therefore reachable by any token, as they were
  before this change. Out of scope here; worth revisiting.
