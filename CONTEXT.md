# Deplo

Self-hosted deploy platform: turns repositories and templates into Docker stacks
fronted by Traefik on a single host. This glossary fixes the language the codebase
and docs use; it is not a spec.

## Language

### Tenancy

**Team**:
An isolated workspace owning services, domains, env vars, databases, S3 destinations,
registries, GitHub apps, API tokens, activity, members and notification settings. The
unit of multi-tenancy. A user may belong to **many** teams and switches the **active
team** from the topbar; everything in the dashboard is scoped to it. **Servers are the
one shared resource** — instance-wide infrastructure any team's services can target
(one host, many teams). A team has a `plan` (`pro` | `enterprise`; the old `hobby` plan
was removed). Created at first-run setup and via the topbar "Create team".
_Avoid_: organization, workspace (that is the dev-mode source tree), tenant, account.

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

**Registration link**:
A single-use link (`/register/<token>`) that lets a NEW person self-register a brand-new
account **and their own team** — like first-run setup, not a join. Minted by an instance
admin from Settings → Users; only the **sha256 of the raw token** is stored, and the
token is consumed inside the same atomic write that creates the account+team (no replay).
There is no email delivery — the admin copies the link and shares it however they like.
Adding an **existing** user to a team is a separate flow: the team-members page searches
registered users by username and attaches a `Membership` directly.
_Avoid_: invite (reserved for adding an existing user to a team), email invite (removed).

### Apps

**App**:
An optional, self-contained feature a team **installs** from the **app repository** to
extend the platform. An installed app is a **host-managed container** (Deplo owns the Docker
socket → real start/stop/restart + true status) — but it is
**not a "service"**: it never appears on the Overview, in the service count, or the
`services` API. It is platform infrastructure that happens to run a container, like the
**SSH gateway**. It is **not** deployed through the service pipeline and gets **no per-app
domain, sslip.io, or TLS cert**; when an app needs to be reached it is served on the **app
path** under Deplo's own public URL. The first app is the **MCP app** — a **stateless relay**
that serves MCP over that path and **holds no credential of its own**: it forwards the
caller's `deplo_` token verbatim to Deplo's GraphQL API, so a caller can only ever do what
*their own* token's team capabilities allow. Its **status is never stored** — it is read
**live** from the container
at query time and exposed through the GraphQL API, like the Preview route's URL is "computed,
not managed." The UI never touches Docker: status and start/stop flow **UI → GraphQL → data
layer → socket**, never UI → socket.
_Avoid_: service (an app runs on host container machinery but is never a Service, nor a
Project container), plugin (implies in-process code in Deplo itself — an app is its own
container), extension, add-on.

**App repository**:
The remote, online catalog of installable apps (`catalog.json` + per-app manifests),
served over HTTP at `devrepo.pixelfederico.com`. Deplo fetches it read-only and treats a
manifest's compose as **opaque text** handed to the deploy pipeline — never evaluated. The
source of every app's image and manifest. Distinct from **Templates**, which ship inside
Deplo; apps are fetched from outside.
_Avoid_: app store, marketplace, registry (that is a container-image credential).

**Caller token**:
The plain team-scoped `deplo_` API token a **user** mints from Settings → API Tokens and
pastes into their own MCP client. It is the **only** credential in the MCP flow: the client
sends it to the **app path**, the app forwards it **verbatim** to Deplo's GraphQL API, and
Deplo authenticates it on every call. There is **no separate app-held secret and no
`MCP_BEARER`** — *reaching* the app and *doing* something through it collapse into one
capability check on this token. Per-user, per-client: revoking one user's token cuts off only
that user; the same app container serves many callers, each as their own principal.
_Avoid_: secret key / app token (the app holds no token of its own), MCP_BEARER (removed —
there is no separate door key), API key (reserve for third-party provider keys in env).

**App path**:
The route under Deplo's **own public URL** at which a reachable app is served (e.g.
`https://<deplo>/apps/mcp-<slug>/…`), reusing Deplo's existing TLS. Deliberately **not** a
per-app domain, sslip.io name, or `Domain` row — an app never gets its own cert. The app
authenticates **nothing** at this path itself; it relays the **caller token** through to
Deplo's API, which performs the real auth.
_Avoid_: app domain, app URL (it is a path on Deplo's domain, not a domain of its own),
route (reserved for Traefik service routes).

**Event**:
Something that happened at a known Deplo lifecycle point (e.g. a deployment succeeded or
failed), emitted by the control plane and delivered **observe-only** to subscriber apps —
fire-and-forget with retries, never blocking. An app reacts by calling the capability-scoped
API back; it can *observe and then act*, but it can **never veto or pause** a pipeline. This
is how an app "does things when something happens." Blocking gates (a true pre-deploy veto)
are deliberately **out of scope** and reserved for a future ADR. *(Phase 2 — not yet built.)*
_Avoid_: hook (implies blocking/in-process), webhook (that is the delivery mechanism, not
the event), trigger.

### Structure

**Service**:
The **deployable app** (formerly *Project* — renamed in [ADR-0008](../docs/adr/0008-projects-own-environments-services-are-the-deployable-unit.md)):
a repository or template turned into a Docker stack `deplo-<slug>` fronted by Traefik.
Owns its build/dev config, source, domains, env vars, deployments, and an optional dev
container. It may sit at the team top level, inside a **Folder**, and/or belong to a
**Project** container (at most one). Its id keeps the historical `prj_` prefix (opaque;
not migrated).
_Avoid_: project (that is now the **container**), app (reserved for an installed **App**),
component (a compose service inside one stack).

**Project**:
A top-level, team-scoped **advanced folder** (ADR-0008, remodeled by ADR-0009) whose
contents are scoped per **Environment**: each environment (picked from a dropdown in the
Overview drill-in) holds its **own Services** — like sub-folders — and its own shared
variables. Folder-like (owner, colour, team-wide order) but it **never nests** in another
Project and **Folders never live inside it**. No page of its own: browsed on the Overview
via the `/?project=<id>&env=<envId>` drill-in (old `/projects/<slug>` URLs redirect there);
id prefix `prc_`. Adoption is **additive**: top-level folders and services that belong to
no Project keep working.
_Avoid_: container (it is not a passive grouping — the environment axis is the point),
folder (a Project owns environments; a folder does not), workspace, group, the old sense of
"project" (the deployable app, now a **Service**).

**Environment**:
A per-**Project**, first-class **isolated deploy target** (ADR-0008): its own containers,
URL(s), git branch, and env vars. Seeded **Development / Preview / Production** on Project
create; renamable and extensible. Carries a well-known `kind`
(`development|preview|production|custom`) — the bridge that keeps legacy **env target**
resolution and global-env targeting working. The default environment (seeded: Production)
keeps the bare `deplo-<slug>` deploy key so live stacks are untouched; others get
`deplo-<slug>__<envSlug>`. id prefix `environ_`. An Environment **owns shared env vars**
(`environment_env_vars`): a variable stored on it reaches EVERY service of the Project in
that environment's context, with **no target axis** — the environment IS the scope, its
`kind` bridging to the runtime until the pipeline is environment-parameterized (a `custom`
kind's vars are inert until then). Deploy precedence: above team/instance globals, below a
service's own vars. Managed from the Project detail page and the Variables page's
**Environments** tab; gated `manage_env` like every other var surface.
_Avoid_: env target (the legacy fixed enum, now `Environment.kind`), stage, deployment
environment (the two-valued build axis).

### Runtimes

**Server agent**:
The single-purpose **Go binary** (`deplo-agent`) that runs on a **server** and owns that
host's Docker socket, build pipeline, log/console streaming, host metrics, and the
bind-mounted service config files under `/data/stacks/files/<slug>/` — the host-coupled half
of the platform, on its own machine. Platform infrastructure, the moral
sibling of the local Docker socket — **not a service and not a frontend**. The control plane
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
re-enabled for remote). **Part D** moves the last per-host singletons (ADR-0002): the **dev
container** lifecycle (`StartDev`/`StopDev`/`ResetDevWorkspace`/`TeardownDev` — `StartDev` streams
like a deploy), the **SSH gateway** (`EnsureGateway`/`ProvisionSshUser`/`DeprovisionSshUser` — the
store's `DevSshUser[]` stays the source of truth, the control plane renders the config + the
per-user exec-step plan, the agent applies them), the **VS Code tunnel**
(`StartTunnel`/`GetTunnel`/`StopTunnel`), and a new **`SOURCE_KIND_DEV_WORKSPACE`** so "deploy from
dev workspace" builds on the owning host. The browser GraphQL + SSE contracts
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
[`lib/infra/agent-client.ts`](../lib/infra/agent-client.ts) +
[`lib/deploy/agent-dev.ts`](../lib/deploy/agent-dev.ts).)*
_Avoid_: agent (ambiguous — say "server agent"), node, worker, runner (CI term), daemon
(reserve for the Docker daemon it drives), deplo agent on the remote being a "second Deplo".

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
The immutable, image-baked runtime for a service (`deplo-<slug>`). Built by
cloning the repo to a temp dir, building an image, then discarding the clone — the
source is not editable at runtime.
_Avoid_: deployment (that is the build event, not the runtime), production container.

**Dev container**:
A service's mutable, long-lived development runtime (`deplo-dev-<slug>`), a sibling
of the production stack — not a kind of deployment. Runs the app in development with
hot reload over a bind-mounted source tree. A service may have a production stack and
a dev container at once, with independent lifecycles. Its state lives on `service.dev`,
never in a `Deployment` row. `dev.status` is **push-only** (set by the dev lifecycle
actions, never reconciled against live docker) — exactly like `service.status`, with the
same known consequence that a manually-stopped container can show a stale status. All
SSH users of a service **share one** dev container and one workspace — there is no
per-user isolation *within* a service; the isolation guarantee is strictly **between**
services.
_Avoid_: dev deployment, dev mode (the feature is "dev mode"; the running thing is a
"dev container"), dev server (that is the process inside it).

**Workspace**:
The persistent, bind-mounted source tree of a dev container (`/data/dev/<slug>` on the
host → `/workspace` in the container). Seeded once on first start — cloned for
`github`/`git` sources, extracted from the archive for `upload`; survives
restart/redeploy; user edits land here. The unit of persistence for dev mode. `git` is
installed regardless of source, so an `upload` workspace can be `git init`'d and
committed locally even with no upstream. **Never auto-pulled** — a production redeploy
is orthogonal and never touches it; the tree is the developer's. Preserved when dev mode
is **disabled** (re-enabling resumes the edited tree); wiped only on full **service
delete**. Disable is reversible; delete is not.
_Avoid_: clone, source dir, working tree.

**Dev image preset**:
The coarse base-language image a dev container runs on — `node | python | go | rust |
php | java` — or a free-text custom image string. A *different, coarser* axis than
`framework` (app type) and `runtimeVersion` (language version): a Next.js service's
preset is `node`. **Derived by default from `framework`** so the user rarely picks it,
overridable only for the custom-image case. Resolves to an **official base image**
(`node:22`, `python:3.12`, …) used directly — Deplo builds no per-language dev images.
_Avoid_: dev base image (when you mean the preset id), language.

**Source-bearing source**:
A `DeploySource` that puts editable source on the server — `github`, `git`, `upload`.
Dev mode is eligible **only** for these. `docker-image` (a prebuilt image) and
`compose` (a multi-service stack, no single repo) have no runnable source tree, so dev
mode is disabled for them.
_Avoid_: git-based source (excludes upload), buildable source.

**Deployment**:
A single build-and-release event that produces or updates the production stack (or a
preview). Always image-based; recorded as a `Deployment` row. Dev containers are
explicitly **not** deployments and produce no `Deployment` rows.
_Avoid_: build (the build is one phase of a deployment), release.

**Preview route**:
The dev container's public URL, `dev-<slug>.<ip>.sslip.io`. A **Traefik-label-only
route** computed at render time from slug + server IP — **not** a `Domain` row. It is
ephemeral (exists only while the dev container runs), derived (the user never
adds/verifies it), and never appears in the Domains tab. `DevConfig` stores only
`previewEnabled` (default on); the URL is computed, not managed. Distinct host from the
production primary domain, so the two routers never collide.
_Avoid_: preview domain (it is not a `Domain`), dev domain, auto domain (that is the
production sslip.io domain).

**Database**:
A managed datastore container (`postgres`/`mysql`/`mariadb`/`mongodb`/`redis`/`clickhouse`)
keyed by slug `db-<name>` on the `deplo` network, so apps reach it by a stable DNS name and
the connection string never changes. **Agent-provisioned like a service** — it has a chosen
`serverId` and is materialised on the owning agent via `Reroute` (`up -d`), started/stopped
via `StartStack`/`StopStack`, and **deleted via `DestroyStack(removeVolumes: true)`** so its
data volume is reclaimed (a plain `DestroyStack` would orphan it). The control plane never
touches the host Docker socket for a DB. See
[ADR-0007](../docs/adr/0007-backups-route-through-the-owning-agent-databases-become-agent-provisioned.md).
_Avoid_: DB instance, datastore (use "database"), local database (none are local now — every
DB lives on an agent, the Deplo host included).

**Backup**:
A **schedule**: a cron expression + S3 destination + retention, targeting **one** thing via
`targetKind` — a `Database` or a `Service` (never a service's linked databases; those are
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
destructive** — DB drop-and-recreate per engine, service wipe-and-untar (stop → wipe → untar
→ `Reroute` snapshot, a full data+config restore) — and so requires a typed confirmation. See
[ADR-0007](../docs/adr/0007-backups-route-through-the-owning-agent-databases-become-agent-provisioned.md).
_Avoid_: backup (that is the schedule), artifact (use for the S3 object specifically),
restore point.

### SSH access

**SSH gateway**:
A single platform-wide container (`deplo-ssh-gateway`) that publishes the one SSH port
(`2222`) and fans every dev SSH user into *their own* service's dev container via an
un-bypassable `ForceCommand`. Platform infrastructure, like Traefik or the `deplo`
network — not a service, not a database. Created lazily on the first SSH user (never at
install), and a disposable **projection** of the store: its Linux accounts, keys, and
maps are rebuilt from `DevSshUser[]`, which is the sole source of truth.
_Avoid_: SSH server, bastion, jump host, per-service sshd.

**Dev SSH user**:
A Linux account on the SSH gateway, scoped to exactly **one** service. Namespaced
gateway-globally as `<slug>-<name>`. Authenticates by key and/or password — **at least
one is required** (the "neither" state is rejected at both action and data layers; key
is the default, password an opt-in). The password is stored **reversibly** (encrypted,
not scrypt-hashed like `User.passwordHash`) only because `chpasswd` needs the cleartext;
it is **write-only from the dashboard** — masked in the DTO with no reveal path, so a
service owner who forgets it must reset it, not retrieve it. Always lands inside that
service's dev container as `devuser` (the gateway always `docker exec -u devuser`) — the
exec target is fixed, never user-configurable.
_Avoid_: dev user (that is the in-container account this resolves to), SSH account.

**devuser**:
The single in-container identity for a dev container, fixed at **UID 1000**. The host
workspace dir is `chown 1000`, the image creates `devuser` as UID 1000, the dev server
runs **as** `devuser` (not root-PID-1), and every SSH session execs in as `devuser`. One
UID end-to-end so the dev server and the developer never fight over file ownership across
the bind mount. There is no configurable exec target and no root path inside the
container.
_Avoid_: target user (removed), non-root user (be specific: it is `devuser`/UID 1000).

### Configuration

**Env target**:
The axis (`production` | `preview` | `development`) that decides which runtime an env
var reaches. It applies to per-service vars, global vars, and shared env groups — but
**not** to an Environment's own shared vars, which carry no target (the Environment IS
the scope; its `kind` plays this axis's role). A dev container
inherits **only** entries that target `development` — its own `development`-tagged vars
plus any attached shared group that targets `development` — never production/preview-only
entries. Nothing is inherited implicitly: a fresh service's dev container is empty until
a `development` var or group is added.
_Avoid_: environment (that is the per-Project entity); scope.

**Shared env group**:
A reusable set of env vars attached to many services, injected into each attached
service's stack for the runtimes the group **targets** (same `production`/`preview`/
`development` axis as a per-service var). A group reaches a service's dev container only
when it targets `development`. Legacy groups stored before the target axis default to all
three targets. Attachment is editable from both the global Variables page and a service's
Environment tab. Distinct from an **Environment**'s shared vars: a group is attached
service-by-service across the team; an Environment's vars reach every service of one
Project automatically, in that environment's context only.
_Avoid_: shared variables (Coolify's term), env group.

**Port target**:
The runtime a port belongs to: `production` or `development` (a two-valued narrowing
of env target — preview reuses the production port). Each target has exactly one port;
this is a per-target *map*, not a list, so two ports can never claim the same target.
Realized as `build.port` (production, image-baked) + `dev.port` (development), read
through a single `portFor(service, target)` accessor in `lib/deploy/ports.ts`. A
hostname's *effective port* — its per-domain override (single-image services only)
folded onto the target default — comes from `effectivePortFor` in the same module.
_Avoid_: container port (ambiguous about which runtime), exposed port.

**Volume**:
A persistent **docker-managed named volume** a user mounts into a **single-container**
service's one service (the `renderCompose` path — github/git/docker-image/upload), edited
from service settings and gated by `usesComposeStack` (a **compose** service declares its
own volumes inside its YAML, so the settings card hides there). Stored on the service as
`{ name, mountPath, readOnly }`; the **on-host** name is namespaced per service at render
time (`deplo-<slug>-<name>`, via `hostVolumeName`) so it can never collide with or leak
into another team's service on the shared daemon — the same isolation reason compose
strips `container_name`. **Named only** (no user-typed bind mounts: a host path handed to
the shared docker socket is a cross-tenant footgun). Data survives redeploys and is never
auto-deleted; removing a row just stops mounting it. A reroute reads volumes back from the
on-disk stack (like image/env), so a domain-only change never silently applies a pending
volume edit.
_Avoid_: **mount** (reserve for a template's bind-mounted **config files**, `service.mounts`
— content-bearing, written next to the stack at deploy; a Volume carries no content);
bind mount (deliberately unsupported); the `deplo-data` volume (Deplo's own data store).
