# Deplo

Self-hosted deploy platform: turns repositories and templates into Docker stacks
fronted by Traefik on a single host. This glossary fixes the language the codebase
and docs use; it is not a spec.

## Language

### Runtimes

**Production stack**:
The immutable, image-baked runtime for a project (`deplo-<slug>`). Built by
cloning the repo to a temp dir, building an image, then discarding the clone — the
source is not editable at runtime.
_Avoid_: deployment (that is the build event, not the runtime), production container.

**Dev container**:
A project's mutable, long-lived development runtime (`deplo-dev-<slug>`), a sibling
of the production stack — not a kind of deployment. Runs the app in development with
hot reload over a bind-mounted source tree. A project may have a production stack and
a dev container at once, with independent lifecycles. Its state lives on `project.dev`,
never in a `Deployment` row. `dev.status` is **push-only** (set by the dev lifecycle
actions, never reconciled against live docker) — exactly like `project.status`, with the
same known consequence that a manually-stopped container can show a stale status. All
SSH users of a project **share one** dev container and one workspace — there is no
per-user isolation *within* a project; the isolation guarantee is strictly **between**
projects.
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
is **disabled** (re-enabling resumes the edited tree); wiped only on full **project
delete**. Disable is reversible; delete is not.
_Avoid_: clone, source dir, working tree.

**Dev image preset**:
The coarse base-language image a dev container runs on — `node | python | go | rust |
php | java` — or a free-text custom image string. A *different, coarser* axis than
`framework` (app type) and `runtimeVersion` (language version): a Next.js project's
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

### SSH access

**SSH gateway**:
A single platform-wide container (`deplo-ssh-gateway`) that publishes the one SSH port
(`2222`) and fans every dev SSH user into *their own* project's dev container via an
un-bypassable `ForceCommand`. Platform infrastructure, like Traefik or the `deplo`
network — not a project, not a database. Created lazily on the first SSH user (never at
install), and a disposable **projection** of the store: its Linux accounts, keys, and
maps are rebuilt from `DevSshUser[]`, which is the sole source of truth.
_Avoid_: SSH server, bastion, jump host, per-project sshd.

**Dev SSH user**:
A Linux account on the SSH gateway, scoped to exactly **one** project. Namespaced
gateway-globally as `<slug>-<name>`. Authenticates by key and/or password — **at least
one is required** (the "neither" state is rejected at both action and data layers; key
is the default, password an opt-in). The password is stored **reversibly** (encrypted,
not scrypt-hashed like `User.passwordHash`) only because `chpasswd` needs the cleartext;
it is **write-only from the dashboard** — masked in the DTO with no reveal path, so a
project owner who forgets it must reset it, not retrieve it. Always lands inside that
project's dev container as `devuser` (the gateway always `docker exec -u devuser`) — the
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
var reaches. A dev container inherits **only** per-project vars tagged `development` —
not production/preview vars, and **not** attached shared env groups (those have no
target axis and flow only to the production stack). Day one, `development` vars must be
added by hand; nothing is inherited implicitly.
_Avoid_: environment (overloaded with "dev environment"); scope.

**Shared env group**:
A reusable set of env vars attached to many projects, injected unconditionally into
their production stacks. Has no env-target axis, so it never reaches dev containers.
_Avoid_: shared variables (Coolify's term), env group.

**Port target**:
The runtime a port belongs to: `production` or `development` (a two-valued narrowing
of env target — preview reuses the production port). Each target has exactly one port;
this is a per-target *map*, not a list, so two ports can never claim the same target.
Realized as `build.port` (production, image-baked) + `dev.port` (development), read
through a single `portFor(project, target)` accessor in `lib/deploy/ports.ts`. A
hostname's *effective port* — its per-domain override (single-image projects only)
folded onto the target default — comes from `effectivePortFor` in the same module.
_Avoid_: container port (ambiguous about which runtime), exposed port.
