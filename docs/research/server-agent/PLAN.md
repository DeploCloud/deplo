# Plan: Server Agent — deploy projects to remote servers via a per-server Go agent

## Context

Deplo already **models** multiple servers — a project carries a `serverId`, the dashboard
has a server picker, and `addServer()` registers a remote in a `provisioning` state — but
it does **not deploy to them**. Two facts from the current tree pin this down:

- **The remote half is unbuilt.** `addServer()` ([`lib/data/servers.ts:39-43`](../../../lib/data/servers.ts#L39))
  says so in its own comment: *"In a real deployment this triggers an SSH connection that
  installs Docker + the Deplo agent; here it records the server in a 'provisioning' state
  until the agent reports back."* There is no agent, no SSH install, no remote exec path.
- **`serverId` only affects routing today, never execution.** The deploy engine reads the
  project's server solely to resolve an IP for the domain/Traefik labels —
  `resolveServerIp(server)` at [`lib/deploy/build.ts:275`](../../../lib/deploy/build.ts#L275)
  and [`:387`](../../../lib/deploy/build.ts#L387). Every `docker build` / `docker compose up`
  runs against the **local** daemon: `lib/infra/docker.ts` shells out to the `docker` CLI
  ([`docker()` :41](../../../lib/infra/docker.ts#L41), [`compose()` :46](../../../lib/infra/docker.ts#L46))
  with **no** `DOCKER_HOST` / `tcp://` / `ssh://` anywhere. So a project assigned to a remote
  server still builds and runs on the Deplo host.

The user wants real multi-server: **each project picks a server, and the build + runtime
land on that server** — without installing the full Deplo app (let alone a second frontend)
on every box.

### The decision this plan implements

The remote server runs a **small, single-purpose Go binary — the _server agent_** — not the
Deplo app. The agent owns the host-coupled half of the platform (Docker, the build pipeline,
log/console streaming, host metrics) on its own machine and exposes it over a typed RPC. The
**control plane stays in TypeScript** (graphql-yoga + Pothos + Drizzle, the existing
`lib/graphql/` + `lib/data/`) and orchestrates agents; the **frontend is unchanged** (one
Next.js app, talking GraphQL to the control plane). This was settled with the user:

- The control plane is **not** rewritten — it reuses the ~47k-line TS codebase and the
  GraphQL schema that is already the UI's contract.
- The remote deliverable is a **dedicated agent**, shipped as a **single static Go binary**
  (no Node runtime on the target), because that is the right artifact for "install on an
  arbitrary server" and the work is process/stream-orchestration that maps cleanly onto Go's
  `os/exec` + goroutines + `creack/pty`.
- The agent is **not a project and not a frontend** — it is platform infrastructure on the
  remote, the moral sibling of today's local Docker socket.

> **Terminology:** uses the glossary in [`/CONTEXT.md`](../../../CONTEXT.md) — **server**
> (the one shared resource: a host any team's projects can target), **production stack**,
> **deployment** (a build-and-release event), **dev container**, **preview route**. New term
> introduced here: **server agent** (defined below; candidate for a CONTEXT.md entry + ADR
> once this design is settled).

---

## Decisions locked with the user

1. **Per-server execution via a dedicated agent, not agentless remote-Docker.** Each target
   server runs a `deplo-agent` process. The control plane never reaches a remote Docker
   socket directly. (Rejected: pointing the `docker` CLI at `DOCKER_HOST=ssh://…` — faster to
   a first deploy, but it leaves `/data` paths, build context, and the host-mountpoint
   `docker inspect` dance ([`lib/deploy/builders.ts`](../../../lib/deploy/builders.ts)) on the
   wrong machine and gives no clean place for streaming/metrics/health.)

2. **The agent is a single static Go binary.** No Node, no npm, no Deplo app on the remote.
   One artifact, `scp`-able and runnable on a bare Linux host with Docker installed.

3. **Control plane stays TypeScript.** GraphQL/data/auth/multi-tenancy are untouched in
   language. The agent absorbs the *host-coupled* code, not the API.

4. **Localhost is an agent too (agent 0).** The Deplo host runs an agent (or the control
   plane speaks the same RPC to its own local socket). "localhost" and "remote" servers
   become **uniform** — one execution path, parameterised by which agent — collapsing the
   `type: "localhost" | "remote"` special-casing in `lib/data/servers.ts` to a transport
   detail. **Reached incrementally (decided D1):** Part A unifies only the *deploy* path; the
   log/console/metrics path is unified in Part C. Until then the two coexist on the host.

5. **One frontend, unchanged.** The UI keeps talking GraphQL to the control plane. Live logs
   and status keep flowing over the existing SSE subscriptions
   ([`lib/graphql/pubsub.ts`](../../../lib/graphql/pubsub.ts),
   [`lib/graphql/types/project.ts`](../../../lib/graphql/types/project.ts)); the control plane
   fans agent streams into them.

6. **The agent contract is the second system boundary.** Alongside GraphQL (UI ↔ control
   plane), the **agent RPC** (control plane ↔ server) is a first-class, versioned contract.
   gRPC, because it gives typed messages + **server-streaming** for live build/run logs in
   one connection.

7. **The agent lives in this monorepo (decided D7).** `agent/` (Go) and `proto/` sit in-repo,
   so the contract and both sides (TS client, Go server) move in one commit and cannot drift.

8. **The control plane stays a single process (decided D8).** The in-process pubsub and the
   log/attach session registries are kept as-is for the whole A–D arc; the agent moves
   *execution* off-box without making the control plane horizontally scalable. Horizontal
   scaling is explicitly **out of scope** (see Resolved decisions → D8).

---

## The seam: what moves to the agent vs. what stays

The split follows the existing `server-only` boundary, cut one layer deeper: anything that
**touches a Docker socket or the host filesystem** moves to the agent; anything that is
**data, policy, or API** stays in the control plane.

### Moves into the Go agent (host-coupled)

| Today (TS) | Responsibility |
|---|---|
| [`lib/infra/docker.ts`](../../../lib/infra/docker.ts) | `docker`/`compose` CLI exec, `ensureNetwork`, container stats/list/logs, attach, **pty console** (`attachContainerPty` :552 — the one genuinely Node-native piece → Go `creack/pty`) |
| [`lib/deploy/builders.ts`](../../../lib/deploy/builders.ts) | Dockerfile / Nixpacks / Buildpacks / Railpack / static builds, the `/data` host-mountpoint resolution |
| [`lib/deploy/build.ts`](../../../lib/deploy/build.ts) (exec half) | `runDeployment` body: clone/extract/pull → build → render stack → `compose up`; `startContainer`/`stopContainer`/`destroyStack` |
| [`lib/deploy/upload.ts`](../../../lib/deploy/upload.ts), [`lib/infra/git.ts`](../../../lib/infra/git.ts) | source materialization (archive extract, git clone) — runs where the build runs |
| [`lib/infra/host.ts`](../../../lib/infra/host.ts) | host CPU/mem/disk/net metrics (`hostMetrics`, `hostFacts`) — per-server, so per-agent |
| [`lib/logs/`](../../../lib/logs/), [`lib/attach/`](../../../lib/attach/) session registries | live log/console fan-out for *that server's* containers |
| [`lib/data/project-files.ts`](../../../lib/data/project-files.ts) (I/O half) | read/write/list/delete of the bind-mounted config files under `/data/stacks/files/<slug>/` — these live on the **project's** host (the agent bind-mounts them into the container), so the `fs.*` half is host-coupled and goes agent-side (decided D9). The anti-traversal sandbox (`resolveWithinRoot` + `realpath`) is **re-ported to Go** in the agent — path validation must run where the I/O runs, never trusting a path off the wire. |
| [`lib/infra/ssh-gateway.ts`](../../../lib/infra/ssh-gateway.ts), [`lib/deploy/dev.ts`](../../../lib/deploy/dev.ts) (exec half) | dev containers + SSH gateway are per-host → agent-local (later phase) |

### Stays in the TS control plane (data / policy / API)

- All of [`lib/graphql/`](../../../lib/graphql/) (24 type modules, the UI contract) and the
  155 functions in [`lib/data/`](../../../lib/data/).
- Auth, tokens, multi-tenancy: `lib/auth*`, `lib/membership.ts`, `lib/data/tokens.ts`.
- The store / DB: `lib/store.ts`, `lib/db/`. **`Deployment` rows, project state, and env
  vars stay authoritative here.**
- **Env decryption stays here, values cross the wire per-deploy.** `revealEnv`
  ([`lib/data/env.ts:68`](../../../lib/data/env.ts#L68)) decrypts; the resolved env map is
  sent to the agent inside the deploy request — the agent never holds the encryption key.
- The **pure** rendering logic (no I/O) stays shared as the contract's source of truth and is
  *ported* (not moved) where the agent must render locally: `renderCompose`
  ([`build.ts:100`](../../../lib/deploy/build.ts#L100)), Traefik labels
  ([`lib/deploy/routing.ts`](../../../lib/deploy/routing.ts)), compose-stack transform,
  database compose. See Open Question Q3 on **who renders the compose**.

---

## The agent contract (gRPC)

A new `proto/agent.proto` is the versioned boundary. Sketch of the service:

```proto
service Agent {
  // health + identity
  rpc Hello(HelloRequest) returns (HelloResponse);          // version handshake, capabilities
  rpc Metrics(MetricsRequest) returns (HostMetrics);        // replaces lib/infra/host.ts per server

  // deploy lifecycle — server-streaming so build logs flow live
  rpc Deploy(DeployRequest) returns (stream DeployEvent);   // log lines + phase + terminal status
  rpc StopStack(StackRef) returns (StackResult);
  rpc StartStack(StackRef) returns (StackResult);
  rpc DestroyStack(StackRef) returns (StackResult);
  rpc Reroute(RerouteRequest) returns (stream DeployEvent); // domain-only change, re-renders labels

  // observability — replaces lib/logs + lib/attach
  rpc FollowLogs(LogRef) returns (stream Chunk);            // docker logs -f
  rpc Attach(stream Chunk) returns (stream Chunk);          // bidi: console/pty (tty + non-tty)

  // container introspection (status, stats) for the live-status subscriptions
  rpc Inspect(InspectRequest) returns (InspectResponse);
}
```

`DeployRequest` carries everything the agent needs to be **stateless about Deplo's store**:
project slug, source descriptor (git URL + token, or an uploaded archive stream, or an image
ref), build method + config, the **rendered compose** (or the inputs to render it — Q3), the
**resolved+decrypted env map**, volume specs, and the routing/domain set. The agent reports
back `DeployEvent`s (log line / phase transition / final `ready|error`), which the control
plane writes to the `Deployment` row and republishes via `publishProjectChanged` so the UI's
existing subscription lights up unchanged.

**Transport & trust:** gRPC over mTLS. Each agent gets a per-server keypair at install; the
control plane pins it. The agent listens only for the control plane (not public). This is the
new privileged surface — treated like the docker-socket-proxy decision in
[ADR-0003](../../adr/0003-gateway-socket-access-is-proxied-and-key-auth-is-default.md).

---

## Implementation parts

### Part A — Agent skeleton + local agent (no remote yet)

Goal: introduce the agent and the RPC **without changing user-visible behavior** by routing
the **local** server's *deploy execution* through it.

> **Scope of Part A — deploy only, not "uniform localhost/remote" (decided D1).** Part A
> routes **only the deploy path** (`Deploy` streaming) through the agent. The live log viewer,
> console/attach, metrics, and the project config-file editor keep using today's direct-Docker /
> direct-`fs.*`, in-process session registries
> ([`lib/logs/session.ts`](../../../lib/logs/session.ts), [`lib/attach/session.ts`](../../../lib/attach/session.ts),
> [`lib/infra/host.ts`](../../../lib/infra/host.ts), [`lib/data/project-files.ts`](../../../lib/data/project-files.ts))
> until **Part C** (the Files tab is gated to localhost projects meanwhile — D9). So during A there are
> deliberately *two* execution models coexisting on the host: deploys flow agent → control
> plane → pubsub, while log-tailing and console still shell out to the local Docker socket
> directly. The "uniform execution path parameterised by agent" (Decision 4) is a **Part-C
> deliverable**, not a Part-A one — A makes only *deploy* uniform.

1. **New in-repo `agent/` Go module (decided D7 — monorepo).** Builds a static `deplo-agent`
   binary. Implements `Hello`, `Metrics`, and `Deploy` for the **Dockerfile + compose** path
   first (the most common), driving the local `docker` CLI exactly as `lib/infra/docker.ts`
   does today.
2. **`proto/agent.proto`** (lives in-repo alongside the agent, so the contract and both sides
   change in one commit) + generated stubs for Go (agent) and TS (control plane, via
   `@grpc/grpc-js` + `ts-proto`).
3. **Agent client in the control plane** — `lib/infra/agent-client.ts`: given a `serverId`,
   dial that server's agent. For now every server resolves to the **local** agent at a fixed
   socket/port. This is the choke point that replaces direct `lib/infra/docker.ts` calls in
   the deploy path.
4. **Route `startDeployment`'s execution through the agent.** `startDeployment`
   ([`build.ts:261`](../../../lib/deploy/build.ts#L261)) keeps creating the `Deployment` row
   and doing policy; the `runDeployment` body now calls `agentClient(serverId).Deploy(...)`
   and streams `DeployEvent`s into the existing log/status writes instead of spawning docker
   locally. **`localhost`'s deploy now flows through the agent path** — proving the contract
   with zero remote risk.
5. **Control plane renders the compose; agent gets opaque YAML (decided D2).** `renderCompose`
   ([`build.ts:100`](../../../lib/deploy/build.ts#L100)) stays the single source of truth in
   TS. `DeployRequest` carries the **rendered YAML**, not the inputs to render it — the agent
   never re-implements routing/label logic in Go.
6. **Decrypted env crosses the wire; the agent never holds the key (decided D4).** The control
   plane decrypts via `revealEnv` ([`env.ts:68`](../../../lib/data/env.ts#L68)) and sends the
   resolved plaintext map inside `DeployRequest` over mTLS. The agent writes it to a `0600`
   env-file (mirroring today's [`build.ts`](../../../lib/deploy/build.ts) compose-stack path)
   and does not persist it beyond the stack's lifetime.
7. **Stable deploy id from day one; no reconnection yet (decided D5, Part-A half).**
   `DeployRequest` carries a stable deploy id. The agent is *fire-and-forget* in Part A (same
   as today), but on control-plane restart any deployment still in `building` is reconciled to
   `error` cleanly instead of being left hung. Real reconnection/replay is Part B.

**Exit criteria for Part A:** deploying a Dockerfile/compose project on the master host works
end-to-end through the agent, with live logs in the UI, and `git status`-clean behavioral
parity with today. (Live logs still come from the direct-Docker session registry — see scope
note above.)

### Part B — Make a remote agent real

> **Provisioning & trust were grilled separately; the six decisions below (P1–P6) supersede the
> original one-line "SSH in, install, hand it a cert" sketch.** The unifying thread matches the
> rest of the plan: **one source of truth, one direction of traffic (server → control plane,
> even at birth), no external CA for internal trust, and no stored status that lies.**

1. **Provisioning — call-home bootstrap, never SSH-in (decided P1).** The control plane does
   **not** open an outbound SSH connection and never holds a server's SSH/root credential
   (rejected: concentrating the fleet's root keys inside the root, socket-mounted control-plane
   container — the ADR-0003 "one bug = catastrophe" anti-pattern). Instead, `addServer()`
   ([`lib/data/servers.ts`](../../../lib/data/servers.ts)) mints a **one-time bootstrap token**
   and returns a paste-on-the-server command (`curl https://<deplo>/install-agent.sh | bash -s
   -- <token>`). The operator runs it with the privileges they already have; the script installs
   Docker (if absent) + the `deplo-agent` binary + a systemd unit; the agent then **calls home**,
   presents the token, and the control plane flips `provisioning → ready`. The `sshUser`/`sshPort`
   fields `addServer()` accepts today become vestigial (kept or dropped — they are unused).

2. **Bootstrap security — three holes plugged (decided P2).**
   - **Script + binary integrity:** served over **HTTPS from the control plane's own domain**
     (reusing its existing Let's Encrypt cert / `acme.json`); the script **verifies the binary's
     checksum** before executing it.
   - **Control-plane authentication before token hand-off:** the agent validates the control
     plane's identity (see P3) **before** sending the token — the token is never handed to an
     unverified peer.
   - **Token hygiene:** the bootstrap token is **single-use, short-lived (~1h), long+random, and
     stored only as its sha256** — reusing the existing **registration-link** pattern
     ([`CONTEXT.md`](../../../CONTEXT.md)) with an **added expiry** (registration links don't
     expire today; a provisioning token is more dangerous, so it must).

3. **Trust on IP-only deployments — fingerprint pinning is primary (decided P3).** Because
   reaching the control plane **by bare IP (no public domain) is the common case** for Deplo
   operators, fingerprint pinning is the *primary* trust mechanism, not a fallback. The bootstrap
   command always carries the **expected fingerprint** of the control plane's cert; the agent
   trusts the control plane **iff** the presented cert matches that fingerprint — Let's-Encrypt-
   signed or self-signed-on-IP alike. One trust model for both worlds. (`instanceHost()` at
   [`lib/deploy/domains.ts:74`](../../../lib/deploy/domains.ts#L74) already resolves the
   control-plane address, IP or domain.) **Let's Encrypt stays the trust anchor only for users'
   public domains — never for internal control-plane ↔ agent trust.**

4. **The control plane is the CA, derived from `DEPLO_SECRET` (decided P4).** mTLS certs for
   agents are signed by a private CA whose key is derived from `DEPLO_SECRET` via a new
   `deriveKey("agent-mtls-ca")` purpose ([`lib/crypto.ts`](../../../lib/crypto.ts)) — **one
   cryptographic source of truth** for both secret encryption and the agent PKI (rejected: a
   separate/HSM CA — adds a second critical secret for a benefit that's illusory here, since a
   compromised control plane already owns the socket and every secret; the CA adds no new target
   inside that blast radius). **Known debt:** `DEPLO_SECRET` has no rotation today, so the CA
   inherits it — *rotating `DEPLO_SECRET` means re-provisioning every agent.*

5. **Agent health — live-read is the truth (decided P5).** Server health shown in the UI is
   **read live** at query time via a fast `Hello` — the same "read live, never stored" model the
   **apps** already use ([`CONTEXT.md`](../../../CONTEXT.md), App entry; ADR-0005), explicitly
   *not* the push-only-stored pattern the glossary flags as a known staleness bug
   (`dev.status`/`project.status`). A lightweight periodic heartbeat (`Hello`/`Metrics`) is a
   **support signal only** — historical metrics + marking a server degraded after N missed beats
   — never the authority; the stored `status` field is a cache, not the source of truth.
   **A pre-flight `Hello` is mandatory before every remote deploy:** if the agent doesn't answer,
   the deploy fails *immediately* with a clear "server unreachable" error rather than hanging
   (consistent with D5 — no hung deploys that lie).

6. **Server removal — ordered three-move teardown (decided P6).** `removeServer()` stops being
   a row-delete and becomes: **(a) always revoke trust in the agent's cert first** —
   unconditional, even if the server is dead (never leave a removed server holding a valid
   badge); **(b) block removal while projects are still assigned** to the server — the operator
   reassigns or deletes them first, consciously (no silent re-home to localhost; same spirit as
   ADR-0005's structural protection); **(c) best-effort remote teardown** — pre-flight `Hello`,
   and if the agent answers, tell it to tear down its containers and stop; if it's unreachable,
   **proceed with removal anyway** and warn that leftover containers must be cleaned by hand.

7. **Agent registry / routing.** `lib/infra/agent-client.ts` resolves `serverId → {host,
   port, cert}` from the `Server` row. `type: "localhost"` → the local agent; `remote` → its
   address (validated by the pinned cert from P3/P4).
8. **Deploy lands on the chosen server.** With A's seam in place, assigning a project to a
   remote server now actually builds + runs there. `resolveServerIp`
   ([`lib/deploy/domains.ts:172`](../../../lib/deploy/domains.ts#L172)) already feeds the right
   IP into the routes, so the Traefik labels on the remote point at the right host.
9. **Each agent builds its own image — no registry (decided D6).** The agent materializes the
   source (git clone with a short-lived token / streamed upload / image pull — decided D3) and
   builds locally. The `DeployRequest` source descriptor stays abstract enough that a future
   "image from registry" source is just one more case of the same enum, not a redesign.
10. **Source transfer per decided D3.** `git` → the agent clones directly (control plane passes
    a short-lived token). `image` → the agent pulls. `upload` → the archive is streamed to the
    agent *inside* the `Deploy` RPC over the same mTLS channel (no second control-plane endpoint;
    traffic stays one-directional, control plane → agent).
11. **Real reconnection/replay (decided D5, Part-B half).** Remote builds are long and costly to
    lose, so the agent keeps a local record of the in-flight deploy keyed by its stable id and
    keeps building if the control plane drops. A re-attach RPC lets the control plane reconnect
    to deploy `<id>`, get its current phase, and replay missed `DeployEvent`s.

**Server row gains provisioning/trust fields (today it has none — see
[`lib/types.ts`](../../../lib/types.ts) `Server`).** The current row stores only
`host`/`ip`/`status`/metrics; provisioning needs, at minimum: the **pinned agent cert** (or its
fingerprint) so the control plane can authenticate the agent and revoke it on removal (P6); the
**bootstrap token's sha256 + expiry** (P2, mirroring registration links — never the raw token);
and a **`lastSeenAt`** timestamp fed by the heartbeat (P5, a cache behind the live-read, not the
authority). Cert/token material is stored encrypted at rest via the existing
`encryptSecret`/`decryptSecret` ([`lib/crypto.ts`](../../../lib/crypto.ts)), like every other
secret in the store.

**Exit criteria for Part B:** create a project, pick a remote server, deploy — the container
runs on the remote, is reachable on its domain, logs stream to the UI; a control-plane restart
mid-build does not lose the deploy.

### Part C — Observability + console + metrics per server

1. **Logs/console.** Repoint the SSE-backed log viewer and console/attach
   ([`app/api/projects/[id]/logs`](../../../app/api/projects/%5Bid%5D/logs),
   [`app/api/projects/[id]/attach`](../../../app/api/projects/%5Bid%5D/attach)) at the owning
   server's agent (`FollowLogs` / `Attach` streams), proxied through the control plane so the
   browser contract is unchanged. The **pty** lives in Go now (`creack/pty`).
2. **Per-server metrics.** `getServerMetrics` ([`lib/data/monitoring.ts:93`](../../../lib/data/monitoring.ts#L93))
   calls each server's agent `Metrics` instead of local `hostMetrics`. The monitoring
   dashboard becomes genuinely multi-server.
3. **Project config-file editing (decided D9).** Repoint `lib/data/project-files.ts` from direct
   `fs.*` to the owning server's agent via new file RPCs (`ListFiles`/`ReadFile`/`WriteFile`/
   `DeleteFile`/`RenameFile`/`MakeDir`/`UploadFile`), proxied through the control plane so the
   GraphQL contract (`manage_files`, relative paths only) is unchanged. The anti-traversal
   sandbox is enforced **inside the agent** (re-ported `resolveWithinRoot`+`realpath`), since the
   files live on the project's host and the path arrives off the wire. **Until this lands, the
   Files tab is disabled for projects on remote servers** — the local control plane's
   `/data/stacks/files/<slug>/` is the wrong disk for a remote project (it would show an empty or
   foreign directory and silently fail to reach the container). The tab stays fully functional
   for localhost projects throughout A–C; the same staleness/split-brain caveat as logs/console
   (scope note in Part A) applies until repointed.

### Part D — Dev mode + SSH gateway per server (later)

Dev containers and the SSH gateway are per-host singletons
([ADR-0002](../../adr/0002-ssh-gateway-is-lazy-platform-infrastructure.md)). Once a project
can live on a remote server, its dev container + gateway must run there too. Deferred —
production deploy (A–C) is the user's priority and dev mode is a larger, self-contained
follow-on (`lib/deploy/dev.ts`, `lib/infra/ssh-gateway.ts` move agent-side).

---

## Phasing

| Phase | Delivers | Risk |
|---|---|---|
| **A** | Local server's **deploy** runs through the agent (contract proven, no behavior change); logs/console/metrics stay direct-Docker until C | Low — reversible, localhost-only |
| **B** | Real deploys to remote servers | Medium — provisioning, image distribution |
| **C** | Multi-server logs/console/metrics | Medium — stream proxying |
| **D** | Dev mode + SSH gateway on remotes | High — defer |

A is the keystone: it converts "the deploy engine calls Docker directly" into "the deploy
engine calls an agent," which is the entire architectural move. B onward is "point the agent
client at a different host."

---

## Resolved decisions (was: open questions)

All six original open questions are now settled, plus two assumptions surfaced from the
current code during design review. The unifying principle across them: **one source of truth,
in one place, changed in one commit** — applied to the compose renderer, the encryption key,
and the contract alike.

- **Q1 → D6 — Image distribution: build on each agent, no registry.** Each agent builds its
  own image locally. A registry (build-once-push-pull) is the right move *only* when real pain
  shows up — the same project served from many servers, very slow builds, or a hard
  bit-identical-across-servers requirement — none of which exist today. The `DeployRequest`
  source descriptor stays abstract so "image from registry" remains a future enum case.
- **Q2 → D3 — Source transfer.** `git` → agent clones directly with a short-lived token.
  `image` → agent pulls. `upload` → archive is **streamed inside the `Deploy` RPC** over the
  existing mTLS channel. One direction of traffic (control plane → agent), one port to guard
  (the agent's); no second public endpoint on the control plane.
- **Q3 → D2 — Compose rendering: control plane renders.** `renderCompose` stays the single TS
  source of truth; the agent receives **opaque YAML** and stays dumb. Avoids porting fragile
  render logic to Go (incl. the byte-identical-reroute contract) and keeping two copies in
  sync forever. The only thing that would force a move is the agent needing to *re-render
  without the control plane* (e.g. self-recovery) — not a requirement today.
- **Q4 → D5 — Statelessness vs. reconnection: graduated.** Part A — a stable deploy id ships
  from day one and hung `building` deployments are reconciled to `error` on restart, but the
  deploy itself is fire-and-forget (no recovery). Part B — the agent keeps a local record of
  the in-flight deploy and exposes a re-attach RPC that replays missed events; remote builds
  survive a control-plane restart.
- **Q5 → D7 — Repo layout: monorepo.** `agent/` and `proto/` live in this repo, so the
  contract and its two implementations (TS client, Go server) change in the **same commit** —
  it is structurally impossible to drift the two sides apart by forgetting one. Justified
  because the agent is platform infrastructure, not an independently-shipped product.
- **Q6 → D4 — Env secret exposure: control plane decrypts, agent never holds the key.** The
  control plane decrypts and sends the plaintext env map over mTLS; the master encryption key
  lives in exactly one place. This is both *simpler* and *lower blast-radius* than per-agent
  data-keys: the container needs plaintext to run regardless, so secrets exist in clear on the
  agent host either way — the only real variable is where the master key lives, and one place
  beats every-server. The agent treats secret-bearing files with tight perms (`0600`) and
  cleans them up.

### Assumptions surfaced from the code (decided during review)

- **D1 — Part A is deploy-only, not "uniform localhost/remote."** See the Part A scope note.
  Log/console/metrics stay on the direct-Docker, in-process registries until Part C; the plan
  no longer claims Part A unifies localhost and remote (it unifies only *deploy*).
- **D8 — The control plane stays a single process for the entire A–D arc.** The live machinery
  is built around one Node process / one Docker socket today, and **deliberately stays that
  way**: the pubsub singleton ([`lib/graphql/pubsub.ts`](../../../lib/graphql/pubsub.ts)) and
  the in-process log/attach session registries
  ([`lib/logs/session.ts:44`](../../../lib/logs/session.ts#L44),
  [`lib/attach/session.ts:41`](../../../lib/attach/session.ts#L41)) keep working unchanged. The
  agent moves *execution* (build/run/log-source) off-box; it does **not** ask the control plane
  to scale horizontally. **Horizontal scaling of the control plane is out of scope.** If it is
  ever needed, the pubsub and session registries must be externalized (e.g. Redis) or pinned
  with sticky routing — a separate workstream the agent does not address on its own.

---

## What this plan deliberately does NOT do

- **No backend language rewrite.** The control plane (GraphQL, data, auth) stays TypeScript;
  only the host-coupled execution layer becomes Go, and only because it ships per-server.
- **No second frontend.** The remote runs a headless binary. One Next.js UI, unchanged.
- **No change to the GraphQL contract for the UI.** Multi-server is transparent to the
  browser; it sees the same schema, the same subscriptions.

---

## Suggested companion ADR

Once settled, record the decision as **`docs/adr/0006-server-agent-is-a-per-host-go-binary.md`**:
*the unit of remote execution is a single-purpose Go agent per server, the control plane stays
TS, and the agent RPC is the second system boundary* — mirroring how
[ADR-0005](../../adr/0005-apps-are-host-managed-containers-not-projects.md) recorded the apps
decision. Add a **server agent** entry to `CONTEXT.md` (Runtimes section).
