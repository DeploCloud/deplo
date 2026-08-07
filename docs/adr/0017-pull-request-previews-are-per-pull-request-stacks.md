# ADR-0017 — Pull request previews are per-pull-request stacks, keyed off the deploy key

**Status:** Accepted (2026-08-07). Supersedes the withdrawn ADR-0014 of the same name
(shipped and reverted on 2026-08-01, commit `a88a050`; the slot was reused by
Better Auth). Decisions 1-10 are unchanged from it; 11-15 are new.

Consumes the deploy-key primitive ADR-0008 §Phase 3b specified and nothing had used.
Amends [ADR-0012](./0012-shared-variables-are-opt-in-per-app.md) on one point (Decision 6).

## Context

deplo could deploy an App from GitHub and redeploy it on every push, but there was no way to
see a pull request running before it merged. The open-source competitors all ship this; it is
the loudest gap in the competitive analysis and the feature that makes "self-hosted Vercel"
credible rather than aspirational.

This decision was made once already. The feature shipped on 2026-08-01 and was withdrawn the
same day (`a88a050`) for scheduling reasons — the roles epic was about to land on the same
files — not because anything here was found wrong. It is restored on today's `main` with five
changes, recorded below as Decisions 11-15. The revert also put the two latent bugs in the
Context back into the tree, where they sat as dead code until this ADR was implemented again.

Most of the machinery was already in the tree and dormant:

- `deployments.environment` already carried `production | preview`, and `startDeployment` had
  a branch that minted an ephemeral host for the second case. **No caller had ever passed
  `"preview"`.**
- `lib/deploy/env-deploy-key.ts` (renamed to `deploy-key.ts` here) already defined the collision-free `<slug>__<suffix>` scheme,
  consumed only by its own test.
- The GitHub App manifest already requested `pull_requests: read`, with a comment saying
  "preview deployments from PRs".

Two things in that dormant path were not merely unfinished but **wrong**, and would have
destroyed production the first time anything reached them:

1. `runDeployment` computed `` `deplo-${slug}` `` before it read `dep.environment`. A preview
   would have overwritten the production container, stack file, files dir and named volumes.
2. `startDeployment` wrote `apps.status`, `apps.latest_deployment_id` and
   `apps.production_url` unconditionally, so every pull request build would have turned the
   production app's badge orange and repointed its URL at a host that disappears when the
   pull request closes.

Separately, `defaultRoute` hardcoded `letsencrypt` — which is precisely wrong for the nip.io
hosts previews use, since nip.io is a single registered domain whose Let's Encrypt issuance
budget is shared with the entire internet (the same reason deplo's own auto domains are born
`certProvider: "none"`).

## Decisions

### 1. A preview is neither an App nor an Environment

It is an `app_previews` row: one per (App, pull request). It has no team placement, no
folder, no domains table entry, no Console, Files, Backups or Monitoring surface. Making it
an App row would multiply every team/folder/ordering/quota/domain invariant and hand
`apps_slug_uq` authority over preview naming; making it an Environment would collide with the
`kind: "preview"` Environment that already exists and means a per-Project scope.

The user-facing word is **pull request preview**, and the nav entry is "Pull requests" — never
a bare "Preview", which is already an Environment's name in the same product.

### 2. The deploy key becomes a real parameter, and production's key is the app slug

Every host-side artifact is named after the **deploy key**: the container, the stack file, the
files dir, the named volumes, the router `baseKey`, every slug-shaped agent RPC. Production's
key IS `apps.slug`, so introducing the concept changed nothing that was already running —
byte-identically, which is what preserves the reroute contract of ADR-0006 §D6.

Alternative rejected: `if (environment === "preview")` at each `deplo-${slug}` site. About
fifteen sites across build / compose / console / agent, each an independent chance to leak
into the production stack. One parameter makes the isolation a type obligation instead of a
discipline.

The key resolves back to its app **structurally**: a slug is `[a-z0-9-]`, so everything before
the first `__` is the app slug and nothing else can be. No new column, index or join.

The key is denormalized onto `deployments.deploy_key`, for the reasons `server_id` already is:
read on `runDeployment`'s one-row hot path and by the queue drain, and — the part that matters
— it outlives the preview row, so a deploy still in flight when its preview is destroyed can
still name the stack it touched.

### 3. A preview writes its own state, and only its own

`apps.status` / `latest_deployment_id` / `production_url` belong to production. A preview
writes `app_previews.status` / `latest_deployment_id` / `url`. Its containers carry
`deplo.project=<previewId>` (with `deplo.app=<appId>` alongside), because the telemetry stream
buckets container stats by that label — which is what keeps a preview out of the App's live
status, monitoring charts and console instance list without touching the agent.

The supersede is scoped to the deploy key, so a push to pull request #42 cannot cancel #43's
queued build, and neither can cancel production's. Framework and logo auto-detection are
gated to production: a pull request's branch must not repaint the app's badge.

### 4. Teardown removes volumes, unlike an App's

`destroyStack` gained a `removeVolumes` flag; a preview passes true and an App still does not.
An App's named volumes hold the user's data and must survive a teardown they can undo. A
preview's volumes were created by, and only by, that preview; nobody asked to keep their
contents and nothing would ever point at them again. Left behind, they are one orphaned volume
set per closed pull request, forever, that no cleanup scope can reclaim.

The row **survives** the close (`state = 'closed'`), which is what makes teardown idempotent
AND retryable: `torn_down_at IS NULL` is the reaper's retry predicate, and stamping it is the
only proof the stack is really gone. Deleting the row on close would silently leak a container
and a volume set the moment an agent happened to be unreachable.

### 5. The zero-configuration URL is nip.io on plain HTTP; a real domain is advanced

`previewHost` is **deterministic** per (app, pull request) — the URL is commented on the pull
request, so a host regenerated on each rebuild would strand a link somebody is testing. With
no configuration it is `<slug>-pr-<n>-<hash6>-<hexip>.nip.io` with `certProvider: "none"`.
With a base domain set, it is `<slug>-pr-<n>.<base>` with a per-preview HTTP-01 certificate
from the resolver that already exists — one wildcard DNS record, and no change to Traefik's
static configuration. A wildcard certificate was rejected: it needs DNS-01, which needs static
config and provider credentials.

Preview hosts are never `domains` rows. One there would be picked up by `routableRoutes` and
baked into the **production** router's rule, and would count against the per-team certificate
quota.

### 6. A preview override outranks a linked shared variable — amending ADR-0012

A preview inherits the App's variables in full (which, since the env-target picker was
removed, means all of them). `app_preview_env_vars` folds LAST in `resolveEnvEntries`, above
the app's own value and above a linked Shared variable, and only for the `preview` target.

This is a deliberate exception to ADR-0012 §Decision 3's "the link keeps the top slot",
applying that decision's own logic once more: a shared variable is a **team default**, an
override is the most specific statement a user can make ("in previews, use this"). Without it
the feature cannot do the one thing it exists for — pointing a pull request's preview at a
scratch database instead of the production one. ADR-0012's substance is untouched: scopes
still never inject, only the explicit per-app link does.

A separate table, not a second `env_vars` row, because `env_vars_app_key_uq` is
`UNIQUE(app_id, key)` — two values for one key are not representable there.

### 7. Fork pull requests wait for a person

A pull request from a fork is attacker-authored code that would run with the App's decrypted
secrets on the operator's host. Two independent layers:

- **Policy** (`preview_fork_policy`, default `approve`): the preview appears in the list as
  blocked and builds nothing until a member with `manage_previews` approves it. `deny` ignores forks
  entirely; `allow` is expert mode.
- **Secrets, unconditionally**: a fork preview never receives a `secret`-typed variable,
  whatever the policy says.

Approval is per pull request, not per commit. Per-commit is safer on paper and unusable in
practice (a click per push), and it is how GitHub's own "Approve and run" behaves;
`approved_sha` records what was reviewed. The residual risk is stated plainly in the approval
dialog and here: an approved fork preview runs untrusted code on the shared `deplo` network.
A per-preview network is the follow-up.

Fork clones use the **fork's own** clone URL, because a fork's head ref does not exist on the
base repo and `git clone --branch` accepts neither a SHA nor `refs/pull/N/head`. A fork of a
private base is therefore not buildable until the agent grows a pull-ref capability.

### 8. `promoteDeployment` is removed, not kept

It only ever flipped `deployments.environment` to production and repointed
`apps.production_url`. Once a preview is a real, separate stack that is a triple lie: no
container work runs, so production keeps serving the old image; the app's advertised
production URL becomes an ephemeral host the reaper deletes; and the promoted row's deploy key
still names the preview's stack. A mutation that lies is worse than a missing one. Merging the
pull request is the honest promotion, and the existing push auto-deploy already ships it.

### 9. The reaper needs no cron and no catch-up window

A third lease-guarded loop beside backups and docker-cleanup (`scheduler_lease.name` is the
PK, so a third loop is a third row — no migration, no coupling). Unlike those two, every
predicate here is a DB state query, so a tick that never ran costs nothing: the next one sees
the same rows. Catch-up is intrinsic; the boot tick is what turns an outage into minutes of
delay rather than a lost day.

### 10. The GitHub App gap is surfaced, not worked around

The manifest now requests the `pull_request` event and `pull_requests: write` (which covers
both reading pull requests and posting the one sticky comment). GitHub has **no API** to
change an existing App's permissions or events, so an instance that connected GitHub before
this feature keeps the old set. `readAppCapabilities` reads what the App actually has, and
three surfaces say what to click. Meanwhile the manual "Deploy a pull request" action still
works, because listing pull requests needs only `pull_requests: read` — which every Deplo
GitHub App has always had.

### 11. At the limit the cap evicts the stalest preview; it does not refuse the new one

The withdrawn version refused a pull request over the limit. "Keep at most 3" is now meant
literally: the new preview builds and the open preview with the oldest `last_activity_at` is
torn down.

It evicts by **activity, never by pull request age**. The oldest open pull request is usually
the one the team has been reviewing all week; killing it to make room for a drive-by typo fix
is exactly backwards.

The evicted row **survives** at `status = 'evicted'` with `state` still `open`. It keeps its
deploy key and host, so Redeploy revives the same URL — and nothing revives it automatically.
That asymmetry is the whole design: if a push brought an evicted preview back, then N active
pull requests under a cap of N would evict each other on every commit, burning a full build per
cycle forever. A push onto an evicted preview still updates its title and head SHA, so the list
never lies about the pull request; it just does not build.

`blocked` (an unapproved fork) and `evicted` previews hold **no slot**: neither has a stack, so
neither may keep a real one out. Reviving an evicted preview reclaims a slot exactly like a new
one, which is why that logic lives in `deployPreviewRow` — every way back through it.

### 12. `manage_previews` is the 41st capability, not a reuse of the deploy one

The withdrawn version gated on the coarse `deploy`, which no longer exists. Rather than fold
previews into `deploy_apps`, they get their own capability: a contributor can then run the pull
request previews of an app without also being able to ship it to production, which is a
distinction a company will actually want. It covers the switch, the advanced settings,
deploy/redeploy/destroy of a preview, and approving a fork.

The real gate is `requireAppCapability(appId, "manage_previews")`, which resolves team, folder
and per-node grants together (ADR-0016) and answers "App not found" to all three — so it is
never an oracle for which ids exist. `lib/deploy/preview-lifecycle.ts` stays session-free; the
gate belongs to its callers.

### 13. Previews may run on a different server than production

`apps.preview_server_id`, NULL ⇒ the app's own server, set from Advanced. The default is the
honest one — a preview is only worth trusting if it runs where production runs — but deplo is
multi-server and the competitors are not, so an operator who wants pull request builds off the
box serving users can have that for one dropdown.

`deployments.server_id` becomes the single authority on where a deploy runs. It was already
denormalized for the queue drain; `runDeployment` now reads it instead of the app, which is
also simply more correct: the row records where a deploy actually went.

`ON DELETE SET NULL`, so retiring that server quietly returns later previews to the app's own
server rather than failing to deploy.

### 14. A preview publishes no host ports

Production keeps its `ports:` — a published port is a deliberate choice by the person who wrote
the compose. A preview did not make that choice, it inherited it, and a host port is a
singleton: the second preview of an app, or the first alongside its own production stack, would
die with "port is already allocated". So the preview render drops every published `ports:`
mapping. Services still reach each other over the `deplo` network and the outside world reaches
them through Traefik, which is how a preview is meant to be visited anyway.

### 15. Turning the switch off destroys the previews that are up

"Off" means "no more pull request containers on my server". It is also the only reading that
leaves nothing behind: the Pull requests page disappears with the switch, so a preview left
running would be a container with no surface left to manage it from. The confirm dialog says
how many it is about to destroy. Turning previews **on** destroys nothing and asks nothing.

## Consequences

- Previews are **off by default**. They are containers on the operator's own server, and
  turning them on for every existing GitHub app unasked is not a default anyone chose.
- Four brakes bound host usage: the switch, a per-app live limit (default 3, which EVICTS —
  see Decision 11), destroy-on-close, and an idle timeout (default 3 days).
- Production deploys are ordered ahead of previews in the queue, so a wall of pull request
  builds never delays a release.
- `deleteApp`, `deleteApps`, team delete and user delete all destroy preview stacks **before**
  the cascade drops the rows that name them.
- Out of scope, deliberately: branch previews outside a pull request, non-GitHub sources
  (no other provider has a webhook route at all), a throwaway database per preview, and
  preview-only access protection.
