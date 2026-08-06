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
The join row binding a user to a team: the assigned **Role** (`role_id`), the member's
`role` **rank** (only `owner` outranks — it is what the "only an owner may act on an
owner" guards read), and the **effective `capabilities`** set. The capabilities are
written from the role and re-written whenever that role changes; a membership with no
`role_id` carries a hand-picked ("Custom") set that belongs to no role. The source of
truth for what a user may do **in a team** — `User.role` is a legacy instance-wide label
kept only for back-compat / defaults.
_Avoid_: team user, role (a membership *has* a role; it is not one).

**Primary owner**:
The one member who owns a **Team** — its founder "crown" (`teams.founder_user_id`), and
the team-level twin of the **instance owner**. Claimed by whoever creates the team, and
**immutable to every other hand**: no owner, and no instance admin, may remove, demote or
edit them, which is what stops an assigned owner from evicting the person whose team it
is. Distinct from the `owner` RANK: a team has many owners and exactly one primary owner
(zero only on a legacy team whose founder account is gone). Not a dead end — ownership
**transfers** (`transferTeamOwnership`, Settings → Members → the member → Advanced), but
only by the primary owner, only to a member of the same team, and only with their password
re-entered plus a second factor when their account has one. The transfer PUTS the new one
on the Owner role with the whole team in reach, in the same transaction — the crown is
full access by definition, and a crowned member whose access had been narrowed could never
be widened again. An API token can never fire it.
_Avoid_: team owner (that is the rank, which many members can hold), founder (fine in
code and prose, but the UI and this glossary say primary owner), team admin.

**Role**:
A named capability set **owned by a team** (`team_roles`, id prefix `role_`) and assigned
to its members from Settings → Team → Members. Every team has three **default** roles —
Owner, Member, Viewer (`builtin_key`) — which it may rename and re-scope and then reset to
what deplo ships, plus any number it authors itself. **Owner is locked at full access**:
the founder's rank is immutable by rule, so a team can never edit its way out of
administering itself. A role IS its members' capabilities: editing one rewrites them for
everyone holding it in the same transaction, and no edit may leave the team with zero
holders of `manage_members` / `manage_roles` / `manage_team`. Seeded lazily per team by
`ensureTeamRoles`, so every team-creation path gets them without knowing they exist.
Edited on its own **page** (`/settings/roles/[id]`, roles rail on the left, summary and the
primary action on the right — the new-app shape), never in a dialog: forty permissions and
a search box do not fit in a modal. "New role" asks first whether to start blank or from an
existing role, so the editor has no "start from" field of its own.
_Avoid_: permission group, preset (a role is not a template you copy — it stays bound to
its members), user group, team role level.

**Capability**:
ONE action a member may be allowed to take — `create_apps`, `deploy_apps`, `delete_apps`,
`open_app_console`, `create_databases`, `restore_backups`, `manage_tokens`,
`organize_folders`, … (forty of them; the catalog with labels, descriptions, search
keywords and browse categories is `lib/capabilities.ts`). Never a bundle: if a name covers
two actions an admin might want to separate, it is two capabilities. `view` is the
always-on floor. Capabilities are the enforcement primitive; a **Role** is the named set a
member is assigned. Enforced server-side on every mutating action via `requireCapability`.

They replaced eight coarse ones (`deploy`, `manage_infra`, …) in migration 0056, which
expanded every stored row into exactly what its old name already implied
(`LEGACY_CAPABILITY_EXPANSION`) — so the split granted and revoked nothing. The old names
are still accepted from API clients and expanded the same way; they are not capabilities.
_Avoid_: permission (use capability), scope, grant, permission group / bundle (a capability
is one action), the retired coarse names in new code.

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

**API token**:
The `deplo_` bearer token a **user** mints from Settings → API tokens to drive
Deplo's GraphQL API from outside the dashboard (a script, CI, an AI agent). It is a
**principal with its own Capabilities**, chosen when it is created and editable afterwards
without re-minting it — never an impersonation of its creator. Its **effective** power is the
INTERSECTION of what it was granted and what its creator can still do in the team the request
resolves to, computed
live on every request, so revoking a person's access blunts every token they minted. Two
orthogonal switches ride alongside: a **scope** and an opt-in **instance-admin** bit (only an
instance admin can grant it; mutually exclusive with a scope). The scope is a TREE — whole
**Teams**, whole **Projects**, whole **Folders** (subfolders included), or individual **Apps**,
ticked at whatever depth fits, and nothing ticked means every team its creator belongs to. A
folder's subtree is expanded at authentication time, never stored, so moving or nesting one
takes effect on the next request; a Project scope also covers the folders filed under it. Breadth and depth are different
questions: holding several whole teams restricts nothing inside them, while naming a project or
an app narrows the token in that team and drops every team-wide capability it holds there. A
bearer request acts in ONE of the token's teams, picked with the `X-Deplo-Team` header and
defaulting to the first in scope. It is MANAGED from the team it was created in; any team it
reaches can revoke it. Shown **once** at creation; only its **sha256** is
stored, so it is revocable but never re-readable. The dashboard itself never uses one — the
browser carries the Better Auth session cookie (`deplo.session_token`) instead.
_Avoid_: "the token inherits its creator's capabilities" (pre-0061 language), personal access
token (it belongs to the team, not the person).
A token also inherits its creator's **2FA** standing: if the team (or their role) requires
two-factor authentication and they have not enrolled, the token resolves nothing at all.
_Avoid_: caller token (a retired name), API key (reserve for third-party provider keys in
env), secret key.

### Plugins

> **Deferred — not a live feature (ADR-0013).** Plugins have no UI, no GraphQL surface and no
> catalog client today. The terms below describe the ground the feature returns on — the
> `installed_plugins` table, `lib/plugins/*`, and the reserved `/plugins/<slug>` path — not
> anything a user can reach. Don't build against them until ADR-0013's open questions are
> settled; do keep using the words, so the revival doesn't invent a second vocabulary.

**Plugin**:
An optional, self-contained feature a team **installs** from a **plugin repository** to
extend the platform. An installed plugin is a **host-managed container**
(Deplo owns the container lifecycle → real start/stop/restart + true status) — but it is
**not an "App"**: it never appears on the Overview, in the app count, or the
`apps` API. It is platform infrastructure that happens to run a container, like Traefik.
It is **not** deployed through the deploy pipeline and gets **no per-plugin
domain, sslip.io, or TLS cert**; when a plugin needs to be reached it is served on the **plugin
path** under Deplo's own public URL. Its **status is never stored** — it is read
**live** from the container, computed rather than managed. The UI never touches Docker:
status and start/stop flow **UI → GraphQL → data layer → the host**, never UI → socket.
_Avoid_: App (a plugin runs on host container machinery but is never an App, nor a
Project container), extension, add-on. (The container/label identity `deplo-app-<slug>` and
the `app_` id prefix persist for compatibility, but the concept is a **Plugin**.)

**Plugin repository**:
The remote, online catalog of installable plugins (`catalog.json` + per-plugin manifests) an
operator points Deplo at. Deplo fetches it read-only and treats a manifest's `image` and `env`
as **opaque** — validated for shape, never evaluated. The source of every plugin's image and
manifest. Distinct from **Templates**, which ship inside Deplo; plugins are fetched from
outside. **Which repository Deplo would ship pointing at is undecided** (ADR-0013) — the
former default was a private host and has been removed.
_Avoid_: app store, marketplace, registry (that is a container-image credential).

**Plugin path**:
The route under Deplo's **own public URL** at which a reachable plugin is served (e.g.
`https://<deplo>/plugins/<slug>/…`), reusing Deplo's existing TLS. Deliberately **not** a
per-plugin domain, sslip.io name, or `Domain` row — a plugin never gets its own cert. The path
stays **reserved** while the feature is deferred: no dashboard route may claim `/plugins/*`.
_Avoid_: plugin domain, plugin URL (it is a path on Deplo's domain, not a domain of its own),
route (reserved for Traefik service routes).

**Event**:
Something that happened at a known Deplo lifecycle point (e.g. a deployment succeeded or
failed), emitted by the control plane and delivered **observe-only** to subscriber plugins —
fire-and-forget with retries, never blocking. A plugin reacts by calling the capability-scoped
API back; it can *observe and then act*, but it can **never veto or pause** a pipeline. This
is how a plugin "does things when something happens." Blocking gates (a true pre-deploy veto)
are deliberately **out of scope** and reserved for a future ADR. *(Not built — deferred with
the rest of the feature.)*
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

**Framework**:
The JavaScript framework Deplo **recognised** in an App's own source — Next.js, Nuxt,
SvelteKit, Astro, NestJS, … — stored as a catalog id on `apps.framework` and shown with the
project's real brand mark. It is a **fact about the code, never a setting**: there is no
preset to pick, no mutation that writes it, and it changes nothing about how the App is
built. Every deploy re-derives it from the App's `package.json` + root config files (read
over the GitHub API for a repo, off the extracted tree for an upload) and overwrites — so it
follows the source instead of drifting from it, and clears itself when it no longer applies.
It exists **only under the auto-detecting builders** (Nixpacks / Railpack), the one gate the
deploy hook, the API and every screen share (`supportsFrameworkDetection`): with a Dockerfile
or the static builder the user has already spelled the build out, so naming a framework there
would be a label that changes nothing. The one thing derived FROM it is the App's default
container **Port** — the port that framework's production server actually binds (Vite's 4173,
Angular's 4200), applied while the user is creating the App and theirs to override from the
moment they touch the field. Catalog (ids, names, ports, signals) in
[`lib/apps/framework-catalog.ts`](../lib/apps/framework-catalog.ts), the pure rules in
[`framework-detect.ts`](../lib/apps/framework-detect.ts), the source reads in
[`framework-source.ts`](../lib/apps/framework-source.ts), and the marks — inlined, never a
CDN, because a self-hosted Deplo may have no internet — in
[`components/shared/framework-icons.tsx`](../components/shared/framework-icons.tsx).
_Avoid_: framework **preset** (the user-picked kind was removed on purpose — the builders
detect the stack), calling it a build method (that is the separate `buildMethod` axis),
stack (that word is the App's Docker **Production stack**), language (recognition names a
framework, and a repo with no JavaScript framework simply has none).

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
the **API token** (a user's long-lived `deplo_` token for the external API) and from the
short-lived **git token** the control plane hands an agent to clone a private repo.
_Avoid_: agent token (the agent's lasting credential is its mTLS cert, not this), join token,
enrollment key, API token (that is the user's own external-API credential, not this).

**Production stack**:
The immutable, image-baked runtime for an app (`deplo-<slug>`). Built by
cloning the repo to a temp dir, building an image, then discarding the clone — the
source is not editable at runtime.
_Avoid_: deployment (that is the build event, not the runtime), production container.

**Deployment**:
A single build-and-release event that produces or updates the production stack (or a
preview). Always image-based; recorded as a `Deployment` row.
_Avoid_: build (the build is one phase of a deployment), release.

**Deploy hook**:
The per-app URL that starts a **Deployment** from outside Deplo — a GitLab/Bitbucket webhook,
a CI job, a script — `POST /api/apps/<id>/deploy-hook/<token>`. It carries **two** independent
secrets, and neither is sufficient alone: the URL's last segment (per app, rotatable, stored
encrypted so the operator can read their own link back) says *which* app, and an **API token**
sent as `Authorization: Bearer deplo_…` says *who* — the deploy then runs through the same
gates the dashboard button does. Per-app `deploy_hook_enabled` is the kill switch. Distinct
from **automatic deployments** (deploy-on-push), which only the GitHub App source can drive
because it is the only provider that delivers pushes to Deplo.
_Avoid_: webhook on its own (ambiguous with the inbound GitHub App webhook and with a plugin
**Event**'s delivery), deploy key (that is an SSH credential), trigger URL.

**Build cache**:
The layers and builder cache mounts a **server** keeps from previous builds, so a redeploy
that changes nothing takes seconds. It lives on the **server** (one BuildKit cache per host,
shared by every app on it), not on the app — which is why an app can only turn its own use of
it off (`build_cache`, every build then runs `--no-cache`) or **clear** it
(`build_cache_clear_pending`, the next build reads nothing and rewrites what it replaces).
Nothing is pruned from a per-app control: reclaiming disk is **Docker cleanup**'s job, server-wide.
_Avoid_: "delete the build cache" for the per-app action (nothing is deleted), layer cache
(that is only part of it — the builders' `type=cache` mounts are the other).

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

**S3 destination**:
A team-owned S3-compatible bucket + credentials that **backup runs** write to (creds
encrypted at rest, never returned to a client). Its `status` is `unverified` until someone
runs the **connection test**, which is not a guess: a backup-capable **server agent** probes
the bucket for real — head it, write a 0-byte `.deplo-s3check`, remove it — so a read-only
key reads as *failed*, not *connected*. The verdict is persisted with its reason
(`last_test_*`), which is what lets the card say WHY it is red and the **connection log**
(the destination's three-dot menu) show the whole probe sequence, the agent's verbatim
message, and the equivalent commands to reproduce it by hand. A failed probe is a normal
result of `testS3`, NOT a mutation error — read `report.ok`; the mutation used to return only
the destination, which is how the UI came to report success over a failing bucket.
_Avoid_: bucket (a destination is bucket + endpoint + region + creds + verdict); "connection
verified" for anything but a passed probe; calling the reproduce block "the command deplo
ran" (the agent does it in-process with minio-go, no shell).

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

**Domain**:
A hostname routed to an app — one row per `(hostname, path)`, and the **sole** routing
source the renderers read (`routableRoutes` ⇒ `traefikRouterLabels`). Carries its own DNS
`status` (only `valid`/`cloudflare` are routed), certificate provider (opt-in; `none` ⇒
plain HTTP), container port, compose service, optional path prefix and middleware chain.
Exactly one domain per app is **primary** — the *canonical host*, the app's
`productionUrl`.

**Custom certificate**:
A TLS certificate the operator brought themselves (a wildcard, a company CA, a domain no
HTTP challenge can reach), installed on ONE **server** from Settings, Servers, its
Certificates tab. It lives in that host's own Traefik stack file and nowhere else: Deplo
keeps no copy, the list is read back off the host, and the private key has no read path.
The proxy picks it by the hostname the browser asked for. Installing one is only half of
it: a **Domain** reaches it by setting its `certProvider` to `custom` ("Installed on the
server"), which serves that hostname over HTTPS with no ACME resolver named. A Domain left
on `letsencrypt` also gets it — Traefik stops issuing for a hostname the store already
covers — but one left on `none` never does, because its router is on plain HTTP.
Instance-admin only, and expiry is nobody's job but the operator's: nothing renews one, so
the certificate account page warns in the last three weeks.
_Avoid_: SSL cert upload, bring-your-own-cert (feature-brochure names), certificate store.

**Alert**:
One notifiable EVENT a team subscribes to, dispatched to every channel that team has
switched on. The catalogue lives in `lib/alerts.ts` (label, one-line description, search
keywords, default) and is browsed with the same picker as a role's **Capabilities**:
search box, categories, a description per row. Distinct from **Activity**, which is the
audit ROW written for what somebody did — an Alert interrupts, an Activity is looked up
later, and many things write one without the other. Storage splits the two halves the way
the schema rules demand: the CHANNELS are flat columns on the team's single
`notification_settings` row, the subscribed alerts are rows in `notification_alerts`,
where an ABSENT row means "never decided" and falls back to the catalogue default — which
is what lets a new alert key ship with no backfill. Every key must have a real emitter;
one that dispatches nothing is a switch that promises an alert and delivers silence.
_Avoid_: notification (say Alert for the event, **channel** for where it goes,
notification settings only for the page); event (that is the audit type); subscription
(reserve it for GraphQL SSE).

**Channel**:
Where a team's Alerts are delivered: a Discord or Slack incoming webhook, a Telegram bot,
a generic outbound webhook, email (through the team's own SMTP server or a Resend key), or
browser push. ONE set per team — every subscribed Alert goes to every enabled channel,
there is no per-alert routing matrix. Slack, Telegram and browser push are **beta**.
Credentials are `*_enc` with no reveal path; a stored one surfaces to the UI as a
`…Set: boolean`, and leaving its field blank on save keeps what is stored.
_Avoid_: integration, provider (that is the email TRANSPORT: `smtp` | `resend`),
notifier.

**Redirect domain**:
A Domain that serves nothing and answers a permanent 301 to another hostname of the same
app, named in its `redirect_to`. It exists so the `www` and non-`www` spellings of one
site settle on a single address: the pair is set from the **Redirect** advanced setting of
whichever half serves, and the redirecting half is a real Domain row — its own DNS check,
its own certificate, its own Traefik router (never folded into the canonical host's, or an
unresolvable `www` would sink that host's cert order). `source: "redirect"` marks a
companion Deplo generated, and is what makes un-pairing safe to delete the row while a
hostname the user typed is only un-redirected. `primary` always follows the half that
serves.
_Avoid_: alias, CNAME (a DNS record type, not a deplo concept), URL forwarding.

**Port**:
An app has **one** container port — the image-baked `build.port` (`preview` reuses it) —
read through the single `portFor(app)` accessor in `lib/deploy/ports.ts` (ADR-0001's
choke point, kept through the collapse of the old per-target axis). A hostname's
*effective port* — its per-domain override (single-image apps only) folded onto the
default — comes from `effectivePortFor` in the same module.
_Avoid_: port target (the old per-target axis died with dev mode), exposed port.

**Volume**:
Persistent storage a user mounts into an app from **Settings → Storage**, for **every**
source — single-container (the `renderCompose` path) *and* **compose** stacks, which get
the same editor plus the compose `service` each row mounts into (blank ⇒ the stack's
default service; a name the compose lacks is a hard render error, never a silent remount).
Nobody has to hand-write `volumes:` into their YAML to keep data. Stored on the app as
`{ type, name, service, mountPath, readOnly }`. Three kinds — **UI name / stored `type`**,
and the UI name is what every screen, tooltip and doc says:
 - **Volume** (`named`) — disk space deplo creates and keeps. The default.
 - **File** (`app`) — a file or folder from the app's own **Files** (its isolated files dir).
   Its CONTENT is written from the Storage editor too (`appStorageFile` / `writeAppFile`,
   over the agent) — not a copy in the database, the same file the Files tab shows — so an
   entry never points at a path with nothing behind it. Files are written **before** the
   rows, because Docker answers a missing bind source by inventing an empty *directory*.
 - **Bind** (`host`) — a folder that already exists on the server: outside deplo and shared
   with everything else on the machine, so it needs the `canMountHostVolumes` grant. A Bind
   is also the only kind with a **propagation** (`rslave` / `rshared`, absent ⇒ docker's
   `rprivate`): without it the container keeps a SNAPSHOT of the submounts that existed when
   it started, so a network disk, a FUSE share or a volume another container mounts inside
   that folder never appears — silently, an empty folder rather than an error. The other two
   kinds have no submounts (and docker rejects the option on a managed volume), so the field
   is dropped for them on write.
Only the **source** is ever required. `mountPath` left empty is **derived** —
`derivedMountPath`: the storage lands in the app's own working directory under the name its
source gives (`uploads` → `/app/uploads`, Files `conf/app.toml` → `/app/conf/app.toml`,
`/srv/media` → `/app/media`) — and the editor sends that path explicitly, so the row stores
what it previewed. Offered ONLY where `containerWorkdir` is a fact (anything deplo builds);
a prebuilt image or a compose service picked its own, and mounting at an invented path is
the silent failure — the app writes where it always did and the disk stays empty — so there
the field stays required.
The stored discriminants never change (a rename would be a migration for a caption); the
label ⇄ `type` mapping and the copy live in `lib/apps/volume-model.ts`, which the server's
`validateVolumes` shares constants with so the editor can't accept what the writer refuses.
A **Volume**'s **on-host** name is namespaced per app at render time
(`deplo-<slug>-<name>`, via `hostVolumeName`) — identical on both render paths, so an app
that changes source keeps its data — and can never collide with or leak into another
team's app on the shared daemon (the same isolation reason compose strips
`container_name`). In a compose stack the app's own compose always wins: a service that
already mounts that container path keeps its mount. Data survives redeploys and is never
auto-deleted; removing a row just stops mounting it. A single-image reroute reads volumes
back from the on-disk stack (like image/env), so a domain-only change never silently
applies a pending volume edit; a compose stack is re-rendered from the app, so its
reroute carries whatever Storage currently holds.
_Avoid_: **named volume** / **app file** / **host path** (the old labels — "nobody knows
what a named volume is" was exactly the problem; say Volume / File / Bind); **mount** as a
synonym for Volume (reserve it for a template's bind-mounted **config files**,
`app.mounts` — content-bearing, written next to the stack at deploy; a Volume carries no
content); the `deplo-data` volume (Deplo's own data store).
