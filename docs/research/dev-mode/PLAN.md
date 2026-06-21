# Plan: Dev Mode — live-editable per-project dev container with shared SSH gateway

## Context

Today Deplo only runs **production** containers: `runDeployment()` clones the repo to a
tmp dir, builds an immutable image, then `rm`s the clone (`lib/deploy/build.ts:294-334`).
Code lives baked in the image — there is no live, editable source tree, no hot reload, and
no shell that survives a restart.

The user wants a per-project **dev mode**: the app runs in development (`npm run dev` / the
language equivalent) with hot reload, the user joins over **real SSH** as users they create
from project **Settings** (multiple users per project, each scoped to only their project),
`git` is installed so they can commit/pull, and **file edits persist across restarts**.

This is a genuinely new capability — a _mutable, long-lived_ dev container alongside (not
replacing) the production stack — plus a single platform-wide SSH gateway that fans users
out to their own project's container.

> **Terminology:** this plan uses the glossary in [`/CONTEXT.md`](../../../CONTEXT.md)
> (production stack, dev container, workspace, preview route, SSH gateway, dev SSH user,
> `devuser`, env/port target, dev image preset, source-bearing source). Four decisions
> below are recorded as ADRs: [0001 ports][adr1], [0002 lazy gateway][adr2],
> [0003 proxied socket + key-default][adr3], [0004 official base images][adr4].

[adr1]: ../../adr/0001-ports-are-per-target-not-a-single-scalar.md
[adr2]: ../../adr/0002-ssh-gateway-is-lazy-platform-infrastructure.md
[adr3]: ../../adr/0003-gateway-socket-access-is-proxied-and-key-auth-is-default.md
[adr4]: ../../adr/0004-dev-containers-use-official-base-images-not-built-presets.md

## Decisions locked with the user

1. **Transport: real sshd via ONE shared platform SSH port.** A single `deplo-ssh-gateway`
   container publishes **one** host port (`2222`). **Multiple SSH users per project**; each
   user reaches **only their own** project's dev container, via an un-bypassable
   `ForceCommand` that `docker exec`s them into `deplo-dev-<slug>`. The gateway is **lazy
   platform infrastructure** (Traefik-like), created on the first SSH user — never reserved
   at install (ADR-0002). (Not one-port-per-project, not the browser terminal.)
2. **Auth: key is the default; password is an explicit per-user opt-in** (ADR-0003). At
   least one credential is required.
3. **Hardening is mandatory, not optional:** the gateway **never mounts the raw docker
   socket** — a `tecnativa/docker-socket-proxy` sidecar exposes only `exec`+`inspect` and
   ships in the gateway compose from day one (ADR-0003).
4. **Base image: dev image preset, derived by default from `framework`** — presets `node`,
   `python`, `go`, `rust`, `php`, `java`, **plus** a free-text custom image string. Resolves
   to an **official base image** used directly; Deplo builds **no** per-language dev images
   (ADR-0004). Setup happens in a bind-mounted entrypoint at first boot.
5. **One in-container identity: `devuser` = UID 1000**, end-to-end (host dir, image user,
   dev server process, SSH exec target). No configurable exec target; no root path inside.
6. **Eligibility: source-bearing sources only** — `github`, `git`, `upload`. Disabled for
   `docker-image` and `compose` (no runnable source tree).
7. **Env isolation: dev inherits ONLY per-project vars tagged `development`** — not
   production/preview vars, and **not** shared env groups. Empty by default; user adds
   `development` vars by hand.
8. **Ports are per-target** (ADR-0001): `build.port` (production, image-baked, untouched) +
   `dev.port` (development, defaults to `build.port`), behind a `portFor(project, target)`
   accessor. Preview reuses the production port.
9. **Preview route: ON by default** — the dev app is Traefik-routed to
   `dev-<slug>.<ip>.sslip.io` as a **label-only route**, never a `Domain` row.

## Key codebase facts (confirmed; cite during implementation)

- **Port stripping is deliberate** (`buildComposeStack` compose-stack.ts:291
  `delete target.ports`). **Traefik has only `web:80`/`websecure:443` entrypoints**
  (`install.sh:126-129`) — no TCP entrypoint. → SSH cannot go through Traefik; the gateway
  is the one deliberate published-port exception, mirroring how Traefik owns 80/443 in
  `install.sh:135-136`.
- **`build.port` is exclusively production** — baked into the image (`EXPOSE`,
  `PORT=` build-arg in `dockerfile.ts`/`builders.ts`) and used as Traefik's
  `loadbalancer.server.port` (`renderCompose` build.ts:93). It is read at ~12 sites, all
  production. → the dev port is a **separate** `dev.port`; `build.port` is never touched.
- **Status is push-only.** Nothing in the codebase reconciles stored status against live
  docker (no monitor loop; the only `setInterval` is the rate-limiter sweep,
  `lib/security.ts:54`). → `dev.status` is push-only too, set by the dev lifecycle actions.
- **Deplo app runs as root** in `node:22-alpine` with `git` + `docker-cli` + `docker-cli-compose`
  and the docker socket mounted (`Dockerfile:15,25,61`); `/data` ← host `/opt/deplo/data`.
- **Persistence = named volumes / bind mounts under `/data`.** Bind paths must be translated
  to the host path via `dataVolumeHostMountpoint()` (`builders.ts:532`) because the daemon
  resolves `-v` against the **host** fs, not Deplo's container fs.
- **Existing PTY/exec infra** (`lib/infra/docker.ts` `execInContainer`, `attachContainerPty`;
  `lib/attach/session.ts`) is reused by the gateway's `docker exec`, and the dashboard's
  browser terminal already lists any container labeled `deplo.project=<id>` (console.ts:99) —
  so the dev container shows up there **for free** as a secondary shell.
- **Secrets:** `encryptSecret`/`decryptSecret` (AES-256-GCM, `lib/crypto.ts`). SSH passwords
  must be stored **reversibly** (encrypted, not scrypt-hashed) because `chpasswd` needs the
  cleartext — same trust level as registry/db creds Deplo already stores reversibly.
- **Lifecycle idiom:** `docker compose -p <project> -f <stackFile> up -d|stop|down`
  (`build.ts:716-759`). Dev reuses this with its own project names.

---

## Architecture

Two new long-lived pieces (the gateway is a 2-container stack), both independent of the
production stack:

**A) `deplo-ssh-gateway`** (lazy platform infra, ADR-0002) — a **2-container** compose
stack:
- `socket-proxy` (`tecnativa/docker-socket-proxy`) — the only thing that mounts the docker
  socket; exposes **only** `exec`+`inspect` to an internal network (ADR-0003).
- `gateway` (Alpine + `openssh-server` + `docker-cli`) — runs `sshd` on the one published
  port `2222`, talks docker **through the proxy** (`DOCKER_HOST=tcp://socket-proxy:2375`),
  **never** sees the raw socket. Mounts only the config dir `/data/ssh-gateway/`.

Every dev SSH user is a real, locked-down Linux account in group `devusers`; a global
`ForceCommand` wrapper replaces their shell with a fixed
`docker exec -it -u devuser deplo-dev-<slug>` into **their** project's container, resolved
from a root-owned per-user map file. The exec target user is **always `devuser`** — not
client-configurable. Users can never reach the gateway shell or raw `docker`. Survives Deplo
app redeploys (separate stack, `restart: unless-stopped`); rebuilt from the store on first
boot (`reconcileGateway`).

**B) `deplo-dev-<slug>`** — one per dev-enabled project, on an **official base image**
(preset→base, or the custom string; ADR-0004) — Deplo builds no dev images. Bind-mounts a
**persistent workspace** `/data/dev/<slug>` → `/workspace`. A bind-mounted entrypoint seeds
the workspace **once** (clone for `github`/`git` via `installationCloneUrl` build.ts:300;
**extract the archive** for `upload`), installs deps, ensures `devuser` (UID 1000) owns
`/workspace`, then **drops to `devuser`** to run the dev command (not root-PID-1). Edits land
in the bind mount and **survive restart/redeploy**; the workspace is **never auto-pulled**.
The dev app is Traefik-routed (label-only, **not** a `Domain` row) to
`dev-<slug>.<ip>.sslip.io` — a **different host** from prod, so the two routers never share a
`Host()` rule.

```
host:2222 ─► deplo-ssh-gateway stack (restart:unless-stopped, lazy, /data/ssh-gateway)
               ├─ socket-proxy (holds the socket; exec+inspect only) ◄── docker.sock
               └─ gateway sshd (DOCKER_HOST=socket-proxy; no raw socket)
                    └─ ForceCommand /usr/local/bin/deplo-dev-shell (target user fixed = devuser)
                         └─ docker exec -it -u devuser deplo-dev-<slug> (login shell)
                                 └─ deplo-dev-<slug>  (dev cmd as devuser, /data/dev/<slug> ⇒ /workspace)
                                         └─ Traefik HTTP (label-only) ⇒ https://dev-<slug>.<ip>.sslip.io
host:80/443 ─► traefik ─► deplo-<slug>  (production, untouched)
```

---

## Data model (`lib/types.ts`)

Add a new top-level collection plus a `dev` block on `Project`. Encryption reuses
`encryptSecret`/`decryptSecret`.

```ts
export type DevStatus = "off" | "starting" | "running" | "stopped" | "error";

/** Coarse base-language image. Derived by default from `framework` (ADR-0004). */
export type DevImagePreset = "node" | "python" | "go" | "rust" | "php" | "java";

/** Port runtime axis — narrower than EnvTarget; preview reuses production (ADR-0001). */
export type PortTarget = "production" | "development";

export interface DevConfig {
  enabled: boolean;
  status: DevStatus; // push-only, like project.status — not reconciled
  /** "preset" → `image` is a DevImagePreset id; "custom" → `image` is a raw string. */
  imageKind: "preset" | "custom";
  /** preset id (resolved to an OFFICIAL base, e.g. node→node:22) or raw custom image. */
  image: string;
  /** Dev command; default from the framework's `dev` command (e.g. "next dev"). */
  devCommand: string;
  /** Development port (the development PortTarget). Defaults to build.port. */
  port: number;
  /** Preview route on by default → dev-<slug>.<ip>.sslip.io. A LABEL-only route, never
   *  a Domain row; the URL is computed from slug+IP, not stored/managed. */
  previewEnabled: boolean;
  latestStartAt: string | null;
}

export interface DevSshUser {
  id: ID; // newId("ssh")
  projectId: ID; // the ONE project this user may reach
  /** Gateway-global login. Namespaced as `<slug>-<name>` to keep it unique. */
  username: string;
  /** authorized_keys line(s); plaintext (public). Null when password-only. */
  publicKey: string | null;
  /** encryptSecret(password). REVERSIBLE (unlike User.passwordHash/scrypt) ONLY because
   *  chpasswd needs cleartext — same trust level as registry/db creds. Write-only: masked
   *  in the DTO with no reveal path. Null when key-only. */
  passwordEnc: string | null;
  // NOTE: no targetUser — the gateway always execs as `devuser` (UID 1000). Removed
  // deliberately; a configurable exec target is a privilege-escalation footgun.
  createdAt: string;
}
```

**Invariant — at least one credential.** A `DevSshUser` with `publicKey == null && passwordEnc
== null` is rejected at **both** the action layer (zod `.refine`) and the data layer. The
"neither" state is unrepresentable in practice. Key is the default; password is opt-in.

- `Project` gains `dev?: DevConfig | null` (absent ⇒ never enabled — back-compat). Dev mode
  is offered **only** when `project.source ∈ {github, git, upload}` (source-bearing).
- `DeploData` gains `devSshUsers: DevSshUser[]` (seed `[]` in `lib/seed.ts`; `normalize()`
  in `lib/store.ts` backfills it automatically by iterating `buildSeed()` keys).
- **Env injection filters on `"development"` ONLY** — per-project vars tagged `development`,
  **no** shared env groups (so `devEnv` is *not* a clone of `projectEnv`, which adds shared
  groups; it is a stricter, dev-specific selector). `PORT` is platform-injected (= `dev.port`).
- Do **not** create `Deployment` rows for dev; surface state via `project.dev.status` (push-
  only). A production redeploy never touches the dev container or workspace.
- **Username uniqueness is gateway-global** → namespace as `<slug>-<name>` in the data layer.
- **Ports:** keep `build.port` as the production port (untouched). `dev.port` is the
  development port. A `portFor(project, target: PortTarget)` accessor is the single read
  choke-point; no `Record<PortTarget, number>` field is introduced (ADR-0001).

---

## SSH gateway (`lib/infra/ssh-gateway.ts` + `lib/data/dev-ssh.ts`)

**Gateway compose** (`/data/ssh-gateway/docker-compose.yml`, project `deplo-ssh-gateway`) —
**two services** (ADR-0003):

- `socket-proxy` (`tecnativa/docker-socket-proxy`): the **only** service mounting
  `/var/run/docker.sock` (ro); env `CONTAINERS=1 EXEC=1` (and nothing else that would allow
  `POST /containers/create`/`run`). On an internal-only network; no published port.
- `gateway` (Alpine+openssh+docker-cli): `restart: unless-stopped`, `ports: ["2222:2222"]`,
  `DOCKER_HOST=tcp://socket-proxy:2375`, mounts host `…/ssh-gateway:/data/ssh-gateway`
  **only** (never the docker socket), labels `deplo.managed=true` + `deplo.role=ssh-gateway`.

Brought up with the standard `compose -p deplo-ssh-gateway -f … up -d`. **Persist host keys**
under `/data/ssh-gateway/` so recreation doesn't trigger client MITM warnings. Created
**lazily** by `ensureGateway()` on the first SSH user (ADR-0002) — never at install.

**Managed files under `/data/ssh-gateway/`:**

- `sshd_config` — global `Match Group devusers` block with `ForceCommand
/usr/local/bin/deplo-dev-shell`, `PermitTTY yes`, and `AllowTcpForwarding no` /
  `PermitTunnel no` / `AllowAgentForwarding no` / `PermitUserRC no`. Regenerated only on
  gateway version change (then `sshd -t && kill -HUP`), **never per user**.
- `keys/<username>/authorized_keys` — `restrict,pty <key>` (0600), only when a key is set.
- `map/<username>` — root-owned, holds `SLUG`/`DEV_CONTAINER` only, no `TARGET_USER` (the
  exec user is always `devuser`); written atomically (tmp+rename).
- `deplo-dev-shell` — the ForceCommand wrapper (root:root 0755): reads `$USER`, sources its
  map file, guards target matches `deplo-dev-*` (and is **not** the control-plane container),
  checks `docker inspect .State.Running` (graceful "your dev container is stopped" if not),
  then `exec docker exec -it -u devuser -w /workspace "$DEV_CONTAINER" /bin/sh -lc 'exec
${SHELL:-/bin/sh} -l'`. The exec user is the **hardcoded literal `devuser`**, never from the
  map or client. **Ignores `$SSH_ORIGINAL_COMMAND`** so `ssh host <cmd>` can't run arbitrary
  commands.

**Why this is safe (two independent layers, ADR-0003):**
- *Which-container axis (wrapper):* ForceCommand applies to BOTH key and password sessions
  (uniform); the exec target is server-owned (from the root-owned map, not client-supplied);
  the user lands inside their own container as `devuser` (UID 1000), where there is no docker
  CLI and no socket; forwarding is disabled.
- *Which-verb axis (socket-proxy):* even a total wrapper bypass yields a gateway shell whose
  `DOCKER_HOST` only permits `exec`+`inspect` — it **cannot** `docker run -v /:/host`, create
  privileged containers, or mount the host fs.

**Provisioning a user** (run from the app container via `docker exec deplo-ssh-gateway …`,
**no sshd reload, no session drop** — sshd reads accounts/keys/maps per-connection):
`adduser -D -G devusers -s /usr/local/bin/deplo-dev-shell <username>`; then either
`chpasswd` (decrypt `passwordEnc` just-in-time) or `passwd -l`; write `authorized_keys` if a
key was given; write the `map/<username>` file. **Removing**: `deluser` + `rm` the key/map
files (+ optional `pkill -u` for hard eviction). Removing the *last* user does **not** tear
down the gateway — it is a platform singleton kept up for other projects (ADR-0002).
`reconcileGateway()` rebuilds everything from the store (the **sole source of truth**) on
gateway first boot; accounts live inside the container as a disposable projection
(`/etc/passwd`/`shadow` are not bind-mounted).

**Hardening (mandatory — ADR-0003, shipped in the gateway compose from day one):** the
gateway never mounts the raw socket; `tecnativa/docker-socket-proxy` fronts it limited to
`exec`+`inspect`, so even a total ForceCommand escape can't `docker run -v /:/host`. sshd
sets `MaxAuthTries`/`LoginGraceTime` (and optionally fail2ban) since a user may opt into
password auth on a public port; **key auth is the default** and the UI steers toward keys.

---

## Dev container (`lib/deploy/dev.ts`)

`renderDevCompose(project)` → `/data/stacks/dev-<slug>.yml`, project `deplo-dev-<slug>`:

- `image:` an **official base image** used directly (ADR-0004) — preset→base, or the raw
  custom string. Presets map: node→`node:22`, python→`python:3.12`, go→`golang:1.23`,
  rust→`rust:1`, php→`php:8.3`, java→`eclipse-temurin:21`. Deplo builds **no** dev images.
- `container_name: deplo-dev-<slug>`; `restart: unless-stopped`; `working_dir: /workspace`;
  `tty: true` + `stdin_open: true` (so the dashboard browser terminal also attaches).
- `entrypoint:` overridden to the **bind-mounted** setup script (see below) — the official
  base has no Deplo-specific entrypoint.
- volumes: host `…/dev/<slug>:/workspace` (pre-`chown 1000:1000` the host dir on create) +
  a named `dev-<slug>-node-modules` volume for deps (avoids bind-layer slowness / arch poison)
  + the host setup script mounted read-only (e.g. `…/dev/_entry/deplo-dev-entry:/…:ro`).
- environment: source seed info (clone URL via `installationCloneUrl` — token injected, never
  logged — + branch, **or** an upload marker), dev command, `PORT=dev.port`, **plus** project
  env vars tagged `"development"` only. `devEnv()` is a **stricter** selector than `projectEnv`
  — per-project `development` vars, **no shared env groups** (so it is *not* a clone of
  `projectEnv`, which injects shared groups).
- labels: `deplo.managed=true`, `deplo.project=<id>`, `deplo.slug=<slug>`, `deplo.role=dev`,
  **plus Traefik HTTP labels** (label-only route — **not** a `Domain` row) for
  `dev-<slug>.<ip>.sslip.io` when `previewEnabled` (default on; reuse `traefikLabels`,
  distinct router key `deplo-dev-<slug>`, distinct host ⇒ no collision). The console picker
  must keep the **production** container as the default target, not this one.
- `ports:` are **NOT** published (Traefik fronts HTTP; SSH comes via the gateway).

**Entrypoint** (`deplo-dev-entry`, bind-mounted from `/data`, run as root then drops down):
seed-or-skip the workspace once — `[ -d /workspace/.git ] || git clone --branch <b> <url>
/workspace` for `github`/`git`; **extract the archive** for `upload` — **never auto-pull**
over user edits; `apk/apt add git` if missing + install deps if missing; ensure `devuser`
(UID 1000) owns `/workspace`; then **drop to `devuser`** (`su-exec devuser …`) to
`exec sh -lc "$DEPLO_DEV_CMD"` (e.g. `next dev -p $PORT -H 0.0.0.0`) so the dev server runs
as `devuser` and hot reload streams. (Not root-PID-1 — keeps bind-mount file ownership sane.)

**Lifecycle** (`startDev`/`stopDev`/`teardownDev`, mirroring build.ts:716-759, parameterized
by `deplo-dev-<slug>`): start ensures the gateway exists (`ensureGateway()`, idempotent like
`ensureNetwork`), creates+chowns `/data/dev/<slug>` to 1000, renders+writes the stack,
`compose up -d`, sets `dev.status` (push-only). No `Domain` row is created — the preview is a
label. First start seeds the workspace; later starts reuse it (edits intact). `stopDev`/
**disable** `compose down` but **keep** `/data/dev/<slug>` (disable is reversible).
`destroyStack`/project-delete (build.ts:740, projects.ts:319) must also tear down the dev
stack, remove `dev-<slug>.yml` + the node_modules volume, **delete** `/data/dev/<slug>` (the
project is gone), and remove the project's `DevSshUser`s from the gateway (which stays up).

---

## Files to add / modify (by layer)

**types** — `lib/types.ts`: `DevStatus`, `DevImagePreset`, `DevConfig`, `DevSshUser`;
`Project.dev?`; `DeploData.devSshUsers`. `lib/seed.ts` + `lib/store.ts` (`normalize` backfill).

**data** — new `lib/data/dev.ts` (`getDev`, `enableDev`, `updateDev`, `setDevStatus`,
`startDevWorkspace` orchestration) and `lib/data/dev-ssh.ts` (`listDevSshUsers`,
`createDevSshUser` [namespaces username, encrypts password, provisions on gateway],
`removeDevSshUser`, `ensureGateway`, `reconcileGateway`) — all `mutate()` + `assertUser()` +
`recordActivity`, mirroring `lib/data/projects.ts` / `lib/data/console.ts`.

**actions** — new `lib/actions/dev.ts`: `enableDevAction`, `updateDevAction`, `startDevAction`,
`stopDevAction`, `teardownDevAction`, `addDevSshUserAction`, `removeDevSshUserAction` — zod
+ `run()` + `revalidatePath`, template = `updateBuildAction` (projects.ts:224). The SSH-user
schema `.refine`s **at least one credential**. DTOs mask `passwordEnc` with **no reveal path**
(unlike `EnvVarDTO`, which can be revealed). `enableDevAction` rejects non-source-bearing
projects.

**deploy** — new `lib/deploy/dev.ts` (`renderDevCompose`, `startDev`, `stopDev`, `teardownDev`,
`devStackFile`, `devProjectName`, `devEnv` [stricter than `projectEnv`], `portFor`, preset→
official-base + preset→dev-command tables). Export/reuse the host-mountpoint resolver from
`builders.ts:532`. `lib/deploy/build.ts`: `destroyStack`/`teardownProject` also remove the dev
stack + node_modules volume + `/data/dev/<slug>` + the project's gateway users.
`lib/frameworks.ts`: add a `dev` command per preset.

**infra** — new `lib/infra/ssh-gateway.ts` (the **2-service** gateway compose [socket-proxy +
gateway] + `docker exec`-based provisioning primitives + the wrapper/sshd_config templates).
`lib/infra/docker.ts`: small `composeUp/Down(project, file)` helper if we want dev/gateway/prod
to share it.

**images / templates** — **no per-language images** (ADR-0004). Only **scripts shipped to
`/data`**: `deplo-dev-entry` (the dev-container entrypoint) and the gateway's `deplo-dev-shell`
+ `sshd_config` template. The gateway uses stock `alpine`+`openssh` and stock
`tecnativa/docker-socket-proxy` — nothing to build/tag.

**install** — `install.sh`: **do not** reserve `2222` at install (ADR-0002) — `ensureGateway()`
creates the gateway lazily on the first SSH user, so installs that never use dev mode never
open the port.

**UI** — `components/projects/build-settings-form.tsx`: new **Dev Mode** Card, **shown only for
source-bearing projects** (enable toggle; base-image picker = preset dropdown [pre-filled from
`framework`] + custom-image text; dev command; **dev port**; preview URL display; SSH users
table with add/remove, username, **key by default / password opt-in**, the shared host + port
`2222`, and copy-paste `ssh <slug>-<user>@<host> -p 2222`). Surface the **empty-by-default env
cliff**: a note that only `development`-tagged vars reach dev. Extract shared fields into
`components/projects/dev-mode-fields.tsx` if also offered in `new-project-wizard.tsx`
(per `[[settings-parity-shared-component]]`). The console page already lists the dev
container via the shared `deplo.project` label — add a small affordance to open its terminal
(without making it the default target).

---

## Verification (end-to-end)

1. **Unit-ish:** `renderDevCompose` emits the expected YAML (official base image, workspace
   bind, dev-entry mount, labels, Traefik `dev-<slug>` router, **no `ports:`**, **no `Domain`
   row**); username namespacing + password encryption + **at-least-one-credential** rejection
   in `createDevSshUser`; preset→official-base + preset→dev-command mapping; `devEnv` includes
   `development` vars and **excludes** shared env groups; `portFor` returns `dev.port` for
   development and `build.port` for production/preview.
2. **Eligibility:** dev mode is offered for `github`/`git`/`upload` projects and **hidden/
   refused** for `docker-image`/`compose`.
3. **Gateway up (lazy + proxied):** before any SSH user, `2222` is **not** listening and no
   gateway runs. Add the first user → `deplo-ssh-gateway` (both `gateway` and `socket-proxy`)
   and `deplo-dev-<slug>` running, `2222` listening, `/data/dev/<slug>` (chowned 1000) and
   `/data/ssh-gateway/{map,keys}` exist. The `gateway` container has **no** docker socket
   mount (`docker inspect` shows the socket only on `socket-proxy`).
4. **SSH isolation (the core guarantee):** add user A (key) to project X and user B (password)
   to project Y. `ssh x-userA@host -p 2222 -i key` lands in `deplo-dev-X` as `devuser` in
   `/workspace`; `ssh y-userB@host -p 2222` (password) lands in `deplo-dev-Y`. Confirm A
   **cannot** reach Y's container, cannot run `docker`, cannot get a gateway shell, and
   `ssh x-userA@host -p 2222 'cat /etc/shadow'` is refused (ForceCommand ignores the command).
   Files created by the dev server are **owned by `devuser`/1000** and editable over SSH.
5. **Persistence + disable:** edit a file over SSH (`vim`/`git commit`), `stopDev` then
   `startDev`, reconnect → edit intact. **Disable** dev mode → workspace **kept**; re-enable →
   tree resumes. Hot reload: edit a page, watch the dev server recompile.
6. **Preview URL:** `https://dev-<slug>.<ip>.sslip.io` serves the dev app, is distinct from the
   production domain, and **does not appear in the Domains tab**; prod is unaffected throughout.
7. **Teardown:** **delete** the project → `deplo-dev-<slug>` gone, `/data/dev/<slug>` **wiped**,
   its `DevSshUser`s removed from the gateway (their `ssh` now fails) — but the **gateway stays
   up** and other projects' dev users are unaffected.
8. **Security pass:** run `/security-review` over the gateway wrapper + sshd_config + the
   provisioning exec path (forced command un-bypassable, exec user hardcoded `devuser`, no
   command injection in `adduser`/`chpasswd`, password never in `docker inspect` env, gateway
   has no raw socket, socket-proxy scoped to `exec`+`inspect`). Verify a simulated wrapper
   bypass still **cannot** `docker run -v /:/host` through the proxy.

## Open follow-ups (safe defaults chosen; revisit later)

- SSH preview tunneling (`ssh -L`) stays **off** (`AllowTcpForwarding no`) until designed.
- node_modules as a **named volume** (chosen); dev starts create **no Deployment rows** (chosen).
- The empty-by-default dev env is surfaced in the UI; a one-click "copy production vars to
  development" affordance is a candidate follow-up (not day one).
- Prebuilt `deplo/dev-<lang>` images remain a possible *optimization* if first-boot setup is
  too slow — behind the same preset, not a prerequisite (ADR-0004).
