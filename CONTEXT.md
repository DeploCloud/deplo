# Deplo

Self-hosted deploy platform: turns repositories and templates into Docker stacks
fronted by Traefik on a single host. This glossary fixes the language the codebase
and docs use; it is not a spec.

## Language

### Tenancy

**Team**:
An isolated workspace owning apps, domains, env vars, databases, S3 destinations,
registries, GitHub apps, API tokens, activity, members and notification settings. The
unit of multi-tenancy. A user may belong to **many** teams and switches the **active
team** from the topbar; everything in the dashboard is scoped to it. **Servers are the
one shared resource** — instance-wide infrastructure any team's apps can target
(one host, many teams). A team has a `plan` (`pro` | `enterprise`; the old `hobby` plan
was removed). Created at first-run setup and via the topbar "Create team".
_Avoid_: organization, workspace, tenant, account.

**Active team**:
The team a request operates in, resolved server-side from the `deplo_team` cookie
(validated against the user's memberships, falling back to their first team) and cached
per-request — exactly like `getCurrentUser()`. The data layer never threads a `teamId`
through signatures: read functions call `requireActiveTeamId()` and filter by it;
mutations call `requireCapability(cap)`. See `lib/membership.ts`.
_Avoid_: current team (ambiguous with the team being viewed), selected team.

**Membership**:
The join row binding a user to a team with a `role` and an **effective `capabilities`**
set. Seeded from the role preset on invite/create, then editable per member. The source
of truth for what a user may do **in a team** — `User.role` is a legacy instance-wide
label kept only for back-compat / defaults.
_Avoid_: team user, role (a membership has a role; it is not one).

**Capability**:
One permission a member may hold in a team — `view`, `deploy`, `manage_domains`,
`manage_env`, `manage_infra`, `manage_members`, `manage_team`. `view` is the always-on
floor. **Roles are presets** over capabilities (`owner` = all; `member` = deploy +
domains + env; `viewer` = view), but a member's exact set can be tailored beyond the
preset. Enforced server-side on every mutating action via `requireCapability`.
_Avoid_: permission (use capability), scope, grant.

**Instance owner**:
The single user who owns the Deplo instance — the tier ABOVE **instance admin**, and the
instance-level twin of a team's founder "crown". Held on the `instance_settings` singleton
(`owner_user_id`), claimed by the account created at first-run setup, and **immutable to
every hand but its own**: no other admin may demote, suspend or password-reset the owner,
and the owner may not drop their own admin flag either. It exists because
`is_instance_admin` is a flat boolean any admin can write on any other admin — the
last-active-admin invariant is satisfied by the attacker themselves — so before the crown a
single promoted admin could seize the whole instance, first account included. Not a dead
end: ownership **transfers**, but only by the owner, only to an active instance admin, and
only with their password re-entered. The sole way back from a locked-out owner is the
host-side `bun run recover` CLI (the one intended shell path in the product).
_Avoid_: root user (that is Unix root), founder (that is the TEAM-level
crown, `teams.founder_user_id`), super admin, instance admin (a different, lower tier).

**Registration link**:
A single-use link (`/register/<token>`) that lets a NEW person self-register a brand-new
account **and their own team** — like first-run setup, not a join. Minted by an instance
admin from Settings → Users; only the **sha256 of the raw token** is stored, and the
token is consumed inside the same atomic write that creates the account+team (no replay).
There is no email delivery — the admin copies the link and shares it however they like.
Adding an **existing** user to a team is a separate flow: the team-members page searches
registered users by username and attaches a `Membership` directly.
_Avoid_: invite (reserved for adding an existing user to a team), email invite (removed).

### Plugins

**Plugin**:
An optional, self-contained feature a team **installs** from the **plugin repository** to
extend the platform (like an MCP server). An installed plugin is a **host-managed container**
(Deplo owns the Docker socket → real start/stop/restart + true status) — but it is
**not an "App"**: it never appears on the Overview, in the app count, or the
`apps` API. It is platform infrastructure that happens to run a container, like Traefik.
It is **not** deployed through the deploy pipeline and gets **no per-plugin
domain, sslip.io, or TLS cert**; when a plugin needs to be reached it is served on the **plugin
path** under Deplo's own public URL. The first plugin is the **MCP plugin** — a **stateless relay**
that serves MCP over that path and **holds no credential of its own**: it forwards the
caller's `deplo_` token verbatim to Deplo's GraphQL API, so a caller can only ever do what
*their own* token's team capabilities allow. Its **status is never stored** — it is read
**live** from the container
at query time and exposed through the GraphQL API — computed, not managed. The UI never
touches Docker: status and start/stop flow **UI → GraphQL → data
layer → socket**, never UI → socket.
_Avoid_: App (a plugin runs on host container machinery but is never an App, nor a
Project container), extension, add-on. (The container/label identity `deplo-app-<slug>` and
the `app_` id prefix persist for compatibility, but the concept is a **Plugin**.)

**Plugin repository**:
The remote, online catalog of installable plugins (`catalog.json` + per-plugin manifests),
served over HTTP at `devrepo.pixelfederico.com`. Deplo fetches it read-only and treats a
manifest's compose as **opaque text** handed to the deploy pipeline — never evaluated. The
source of every plugin's image and manifest. Distinct from **Templates**, which ship inside
Deplo; plugins are fetched from outside.
_Avoid_: app store, marketplace, registry (that is a container-image credential).

**Caller token**:
The plain team-scoped `deplo_` API token a **user** mints from Settings → API Tokens and
pastes into their own MCP client. It is the **only** credential in the MCP flow: the client
sends it to the **plugin path**, the plugin forwards it **verbatim** to Deplo's GraphQL API, and
Deplo authenticates it on every call. There is **no separate plugin-held secret and no
`MCP_BEARER`** — *reaching* the plugin and *doing* something through it collapse into one
capability check on this token. Per-user, per-client: revoking one user's token cuts off only
that user; the same plugin container serves many callers, each as their own principal.
_Avoid_: secret key / plugin token (the plugin holds no token of its own), MCP_BEARER (removed —
there is no separate door key), API key (reserve for third-party provider keys in env).

**Plugin path**:
The route under Deplo's **own public URL** at which a reachable plugin is served (e.g.
`https://<deplo>/plugins/mcp-<slug>/…`), reusing Deplo's existing TLS. Deliberately **not** a
per-plugin domain, sslip.io name, or `Domain` row — a plugin never gets its own cert. The plugin
authenticates **nothing** at this path itself; it relays the **caller token** through to
Deplo's API, which performs the real auth.
_Avoid_: plugin domain, plugin URL (it is a path on Deplo's domain, not a domain of its own),
route (reserved for Traefik service routes).

**Event**:
Something that happened at a known Deplo lifecycle point (e.g. a deployment succeeded or
failed), emitted by the control plane and delivered **observe-only** to subscriber plugins —
fire-and-forget with retries, never blocking. A plugin reacts by calling the capability-scoped
API back; it can *observe and then act*, but it can **never veto or pause** a pipeline. This
is how a plugin "does things when something happens." Blocking gates (a true pre-deploy veto)
are deliberately **out of scope** and reserved for a future ADR. *(Phase 2 — not yet built.)*
_Avoid_: hook (implies blocking/in-process), webhook (that is the delivery mechanism, not
the event), trigger.

### Structure

**App**:
The **deployable unit** (formerly *Project*, then *Service*, now **App** — the Project→Service step is [ADR-0008](../docs/adr/0008-projects-own-environments-services-are-the-deployable-unit.md)):
a repository or template turned into a Docker stack `deplo-<slug>` fronted by Traefik.
Owns its build config, source, domains, env vars, and deployments. It may sit at the
team top level, inside a **Folder**, and/or belong to a
**Project** container (at most one). Its id keeps the historical `prj_` prefix (opaque;
not migrated). The agent wire (`deplo.project=<id>` label, `deplo-<slug>` stack naming) also
keeps the legacy token — it carries the App id.
_Avoid_: service (that is now a **compose service** inside a stack, or a Traefik route),
project (that is now the **container**), plugin (reserved for an installed **Plugin**),
component (a compose service inside one stack).

**App status**:
`apps.status` is **INTENT** — the last thing the control plane was *asked* to do — never an
observation of the host, which is exactly what separates it from **Server health**. Six
values: **queued**, **building**, **active**, **error**, **stopping**, **idle**. There is no
"stopped": `idle` **is** the stopped state, and "Stopped" is only the (grey) label it renders
with. What the UI shows is never the raw column — two folds sit on top of it, split **by
direction**. **Downward** is live and never persisted: `displayStatus`
([`lib/apps/display-status.ts`](../lib/apps/display-status.ts)) folds an `active` App with a
live runtime probe into **restarting** / **degraded** / **unhealthy** / **down**, because
`active` is the only value that is a claim *about the host* and so the only one worth
contradicting. **Upward** is persisted and belongs to the telemetry stream:
([`lib/data/app-status-reconcile.ts`](../lib/data/app-status-reconcile.ts)) clears a stale
`error` off an App whose containers a `StreamMetrics` frame proves are running — the one
transition anything reconciles, guarded to Apps with no in-flight **Deployment**, no pending
server move, and containers on the host that reported them. An App **absent** from a frame is
**unknown, never failed**. Note that `error` means *the last deploy attempt failed*, which is
a different fact from *the App is down*: a failed redeploy leaves the previous stack serving,
and that gap is precisely what the upward reconcile closes.
_Avoid_: "stopped" as a stored value (it is `idle`), reading `apps.status` as a live fact,
adding a writer of the column whose guard is not in its own `WHERE`, treating an App missing
from a telemetry frame as evidence of anything.

**Project**:
A top-level, team-scoped **advanced folder** (ADR-0008, remodeled by ADR-0009) whose
contents are scoped per **Environment**: each environment (picked from a dropdown in the
Overview drill-in) holds its **own Apps** — like sub-folders — and its own shared
variables. Folder-like (owner, colour, team-wide order) but it **never nests** in another
Project and **Folders never live inside it**. No page of its own: browsed on the Overview
via the `/?project=<id>&env=<envId>` drill-in (old `/projects/<slug>` URLs redirect there);
id prefix `prc_`. Adoption is **additive**: top-level folders and apps that belong to
no Project keep working.
_Avoid_: container (it is not a passive grouping — the environment axis is the point),
folder (a Project owns environments; a folder does not), workspace, group, the old sense of
"project" (the deployable app, now a **App**).

**Environment**:
A per-**Project**, first-class **isolated deploy target** (ADR-0008): its own containers,
URL(s), git branch, and env vars. Seeded **Development / Preview / Production** on Project
create; renamable and extensible. Carries a well-known `kind`
(`development|preview|production|custom`) — the bridge that keeps legacy **env target**
resolution and global-env targeting working. The default environment (seeded: Production)
keeps the bare `deplo-<slug>` deploy key so live stacks are untouched; others get
`deplo-<slug>__<envSlug>`. id prefix `environ_`. An Environment is one of the three
**availability scopes** of a **Shared variable** (ADR-0010/0012): a variable scoped to an
environment is SUGGESTED to every app that LIVES in it — each app still opts in itself.
(It no longer owns its own var table — `environment_env_vars` was folded into the
unified `shared_env_vars` model.)
_Avoid_: env target (the legacy fixed enum, now `Environment.kind`), stage, deployment
environment (the two-valued build axis).

### Runtimes

**Server agent**:
The single-purpose **Go binary** (`deplo-agent`) that runs on a **server** and owns that
host's Docker socket, build pipeline, log/console streaming, host metrics, and the
bind-mounted app config files under `/data/stacks/files/<slug>/` — the host-coupled half
of the platform, on its own machine. Platform infrastructure, the moral
sibling of the local Docker socket — **not an app and not a frontend**. The control plane
(GraphQL/data/auth, which stays TypeScript) never reaches a remote Docker socket directly; it
drives each agent over a **versioned gRPC contract** (`proto/agent.proto`) on **mTLS**, the
*second system boundary* alongside the GraphQL UI contract. **The host running Deplo is an agent
too** — installed, bootstrapped, pinned, and dialed over mTLS *exactly* like a remote (there is no
in-process "local agent" and no `type: "localhost"`), so every server is one uniform execution path
parameterised only by which agent. The compose
is rendered control-plane-side and handed to the agent as **opaque YAML**; decrypted env
crosses the wire per-deploy but the agent **never holds the encryption key**. An agent is born
by **call-home bootstrap** — the control plane never SSHes in: the operator runs a paste-on-the-
server script that installs it and **calls home** with a **bootstrap token**, then the control
plane (which is the agents' private **CA**, derived from `DEPLO_SECRET`) signs its mTLS cert.
The agent pins the control plane by cert **fingerprint** over HTTPS, or — on a bare-IP, no-TLS
install — by an **HMAC over the bootstrap response keyed by the one-time token** (so both worlds
work). Because a remote agent's key must never leave the box, the agent **generates its own key
and sends a CSR**; the control plane CA **signs the CSR** (it never sees the agent's private key).
Health is **read live** (never a stored value that goes stale). See
[ADR-0006](../docs/adr/0006-server-agent-is-a-per-host-go-binary.md). *(**Parts A + B + C + D
built — the full arc is complete**: the localhost server's deploy runs through the agent (Part A),
and a **remote** agent is real (Part B) — call-home provisioning, remote routing with
fingerprint-pinned mTLS, the **git source the agent clones itself**, and **reconnection/replay** so
a control-plane restart mid-build does not lose the deploy. **Part C** moves the rest of the
host-coupled surface onto the owning agent: live **logs** (`FollowLogs`), **console/attach** (bidi
`Attach`, pty now Go `creack/pty`), the **console exec + introspection**
(`Exec`/`ListInstances`/`ShellLabel`), per-server **metrics** (`Metrics`), the **lifecycle verbs**
(`Stop`/`Start`/`DestroyStack`), and the **Files** tab (`ListFiles`/`ReadFile`/`WriteFile`/…,
re-enabled for remote). **Part D** moved the last per-host singletons (the dev-container lifecycle, the SSH
gateway, the VS Code tunnel) onto the agent; **dev mode was later removed from the
product entirely**, so the control plane no longer calls that surface — the RPCs stay
dormant in the Go binary because the V1 contract is additive-only. The browser GraphQL + SSE contracts
are unchanged — only the backing is repointed. Every container RPC label-checks
`deplo.project=<id>` agent-side; the files sandbox is re-enforced agent-side; an agent that is
unreachable **fails clearly with NO in-process fallback** (no synthetic container, no host metrics,
no wrong-disk teardown) — this holds for EVERY server, the host running Deplo included. The legacy
direct-Docker deploy/logs/console/files/metrics path has been **removed entirely**; build methods
the agent can't run (heavy builders) are a clear deploy error, not a local fallback. Routing changes
and the "View full compose" preview also go through the owning agent (`Reroute`/`ReadStack`). A planned **backup** capability adds `Backup`/`Restore` (server-streaming, like deploy) plus
`S3Check`/`S3Delete` and a `removeVolumes` flag on `DestroyStack`, so dumps/archives and the
S3 transfer happen agent-side (an S3 client in the binary); the control plane preflights the
capability and degrades with `AgentBackupUnsupportedError` until it ships
([ADR-0007](../docs/adr/0007-backups-route-through-the-owning-agent-databases-become-agent-provisioned.md)).
Agent
code in its own repo (**DeploCloud/deplo-agent**), contract in
[`proto/agent.proto`](../proto/agent.proto), control-plane side in [`lib/agent/`](../lib/agent/) +
[`lib/infra/agent-client.ts`](../lib/infra/agent-client.ts).)*
_Avoid_: agent (ambiguous — say "server agent"), node, worker, runner (CI term), daemon
(reserve for the Docker daemon it drives), deplo agent on the remote being a "second Deplo".

**Server health**:
A server's **status** is an OBSERVATION, not a lifecycle the control plane drives: the outcome of
the last live agent **Hello**, stamped with **when** it was observed (`statusCheckedAt`) and, when
it isn't green, **why** (`statusMessage`, from a closed set of curated strings — never a raw agent
error, which would leak the pinned fingerprint and the dial address). The five values:
**provisioning** (no agent has called home yet — never dialed, never demoted), **online** (Hello
answered, Docker reachable), **warning** (agent up and trusted, but Docker is unreachable, so
nothing can deploy there), **error** (the peer answered but its agent is wrong — untrusted cert,
unsupported contract, application error), **offline** (nothing answered, confirmed by a retry).
The stored value is a **cache the UI must qualify**, never a **gate**: past a staleness window the
Servers page renders it as *Unknown* rather than a confident stale green, and **nothing in the
deploy path consults it** — the gate there is the mandatory live Hello pre-flight
([ADR-0006](../docs/adr/0006-server-agent-is-a-per-host-go-binary.md)). Probing is throttled and
watermarked on probe-START time, and an inconclusive probe writes **nothing** (a fabricated
check is the same lie as a stale badge). Written by the Servers page's on-load sweep, the
per-server *Check status* button, and the metrics poll — all through the one recorder
([`lib/data/server-health.ts`](../lib/data/server-health.ts)), classified by
[`lib/infra/server-health.ts`](../lib/infra/server-health.ts).
_Avoid_: "the server is up/down" (say which of the five), treating **warning** as a soft
**error** (it is a *deployability* verdict), gating anything on the stored status.

**Server readiness**:
A **live, never-stored** answer to *"is this host's installation complete enough to deploy Apps
to?"* — distinct from **Server health**, which answers *"can we reach and trust this agent right
now?"*. A **readiness check** (Settings → Servers → a server's ⋯ menu → *Check readiness*) dials
the owning agent once and assembles a **readiness report**: rows grouped as **agent** (handshake,
protocol, version, the platform features the binary supports), **docker** (the daemon answered),
**routing** (a running Traefik container; host ports 80/443 bind-tested), **capacity** (disk
headroom on the host's root filesystem), **build methods** (which the agent supports), and
**Deplo configuration** (team access, deploy concurrency). Each row is `pass`/`info`/`warn`/
`fail`/`skip`, where **fail** means a deployment to this server cannot succeed, **warn** means it
succeeds but the result is not fully usable, and **skip** means we could not evaluate it (an
agent too old to bind-test ports degrades to a skipped row — never a faked pass). The report is
**NOT a sixth `ServerStatus`**, is **never persisted**, and **nothing gates on it** — the deploy
gate is and stays the mandatory live Hello pre-flight (ADR-0006), and `servers.status` stays the
health prober's alone. Its discipline is **honesty**: a Hello flag proves the agent *knows how to
run* Nixpacks — not that the nixpacks binary is on the host (it is fetched on the first build) —
and Docker being unreachable forces the agent's Traefik answer false, so that row is **skipped**,
not warned. Classified by [`lib/infra/server-readiness.ts`](../lib/infra/server-readiness.ts)
(pure), orchestrated by [`lib/data/server-readiness.ts`](../lib/data/server-readiness.ts)
(instance-admin, dials once, writes nothing).
_Avoid_: "health check" (that is the Hello classifier — `checkServerHealth`), calling readiness a
**status** or a **Capability** (that word is the authz term; the agent's Hello flags are only
"what the agent supports"), "installed" for anything a Hello flag reports, gating a deploy on a
readiness verdict.

**Bootstrap token**:
The **one-time, short-lived** secret that lets a freshly-installed **server agent** prove it is
an authorized newcomer when it first **calls home** to the control plane — after which the
control plane signs the agent's mTLS cert and the token is spent. Carried in the paste-on-the-
server bootstrap command; **single-use**, expires (~1h), and stored only as its **sha256**
(never the raw value) — the same handling as a **registration link**, with an added expiry
because a provisioning token is more dangerous (it gives rise to a trusted agent). Distinct from
the **caller token** (a user's `deplo_` API token, long-lived, for the MCP flow) and from the
short-lived **git token** the control plane hands an agent to clone a private repo.
_Avoid_: agent token (the agent's lasting credential is its mTLS cert, not this), join token,
enrollment key, API token (that is the caller token).

**Production stack**:
The immutable, image-baked runtime for an app (`deplo-<slug>`). Built by
cloning the repo to a temp dir, building an image, then discarding the clone — the
source is not editable at runtime.
_Avoid_: deployment (that is the build event, not the runtime), production container.

**Deployment**:
A single build-and-release event that produces or updates the production stack (or a
preview). Always image-based; recorded as a `Deployment` row.
_Avoid_: build (the build is one phase of a deployment), release.

**Database**:
A managed datastore container (`postgres`/`mysql`/`mariadb`/`mongodb`/`redis`/`clickhouse`)
keyed by slug `db-<name>` on the `deplo` network, so apps reach it by a stable DNS name and
the connection string never changes. **Agent-provisioned like an app** — it has a chosen
`serverId` and is materialised on the owning agent via `Reroute` (`up -d`), started/stopped
via `StartStack`/`StopStack`, and **deleted via `DestroyStack(removeVolumes: true)`** so its
data volume is reclaimed (a plain `DestroyStack` would orphan it). The control plane never
touches the host Docker socket for a DB. See
[ADR-0007](../docs/adr/0007-backups-route-through-the-owning-agent-databases-become-agent-provisioned.md).
_Avoid_: DB instance, datastore (use "database"), local database (none are local now — every
DB lives on an agent, the Deplo host included).

**Backup**:
A **schedule**: a cron expression + S3 destination + retention, targeting **one** thing via
`targetKind` — a `Database` or an `App` (never an app's linked databases; those are
backed up as databases). Stored metadata only; running it produces a **backup run**. A
backup never holds artifacts itself.
_Avoid_: backup job (that is a run), snapshot (reserve for a point-in-time artifact, which is
a run), dump (that is the DB-specific artifact contents).

**Backup run**:
One **executed** backup — the artifact record you restore *from*. A `BackupRun` row
(`running`→`success`/`failed`) carries the S3 `objectKey`, size, and timestamps; the dump or
archive itself lives **only** in S3 (the agent streams it there via multipart PUT, never
through the control plane). The run history is the source of truth for the UI's artifact
list (`ListBackupArtifacts` on the agent is deferred). Restore is **in-place and
destructive** — DB drop-and-recreate per engine, app wipe-and-untar (stop → wipe → untar
→ `Reroute` snapshot, a full data+config restore) — and so requires a typed confirmation. See
[ADR-0007](../docs/adr/0007-backups-route-through-the-owning-agent-databases-become-agent-provisioned.md).
_Avoid_: backup (that is the schedule), artifact (use for the S3 object specifically),
restore point.

### Configuration

**Env target**:
The axis (`production` | `preview`) that decides which runtime an env var reaches. It
applies to per-app vars, instance globals, and **Shared variables** (the orthogonal
runtime axis, alongside their sharing modes). The third value, `development`, died with
dev mode (migration 0041): its only consumer was the dev container's env resolution.
_Avoid_: environment (that is the per-Project entity); scope.

**Shared variable** (ADR-0010, opt-in per ADR-0012):
ONE variable owned by a team, the unified replacement for shared-env groups,
environment-scoped vars, and team-global vars. It INJECTS into an app through exactly one
mechanism: the explicit **per-app link** (the opt-in — attached from the app's
Add-variable modal, a shared row's actions, or the wizard's "Specific apps" step). The
three non-exclusive **availability scopes** — **team-wide** (every app in the team),
**environment** (apps living in one of the selected **Environments**), **project** (apps
in one of the selected **Projects**) — only say who the variable is SUGGESTED to; they
never auto-apply, and they don't gate linking (any team var is linkable from any app).
At least one scope or link is required. An orthogonal **env target** axis gates the
runtime (defaults to both). Deploy precedence (low→high): instance globals < an
app's own var < linked shared var. Managed on the Variables page's **Shared** tab
(create / edit / assign the scopes). Stored in `shared_env_vars` (+ target / environment
/ project / app junctions). id prefix `svar_`.
_Avoid_: shared env group (the old model), sharing mode (pre-0012 auto-apply language),
shared variables as Coolify's whole-set concept.

**Port**:
An app has **one** container port — the image-baked `build.port` (`preview` reuses it) —
read through the single `portFor(app)` accessor in `lib/deploy/ports.ts` (ADR-0001's
choke point, kept through the collapse of the old per-target axis). A hostname's
*effective port* — its per-domain override (single-image apps only) folded onto the
default — comes from `effectivePortFor` in the same module.
_Avoid_: port target (the old per-target axis died with dev mode), exposed port.

**Volume**:
A persistent **docker-managed named volume** a user mounts into a **single-container**
app's one app (the `renderCompose` path — github/git/docker-image/upload), edited
from app settings and gated by `usesComposeStack` (a **compose** service declares its
own volumes inside its YAML, so the settings card hides there). Stored on the app as
`{ name, mountPath, readOnly }`; the **on-host** name is namespaced per app at render
time (`deplo-<slug>-<name>`, via `hostVolumeName`) so it can never collide with or leak
into another team's app on the shared daemon — the same isolation reason compose
strips `container_name`. **Named only** (no user-typed bind mounts: a host path handed to
the shared docker socket is a cross-tenant footgun). Data survives redeploys and is never
auto-deleted; removing a row just stops mounting it. A reroute reads volumes back from the
on-disk stack (like image/env), so a domain-only change never silently applies a pending
volume edit.
_Avoid_: **mount** (reserve for a template's bind-mounted **config files**, `app.mounts`
— content-bearing, written next to the stack at deploy; a Volume carries no content);
bind mount (deliberately unsupported); the `deplo-data` volume (Deplo's own data store).
