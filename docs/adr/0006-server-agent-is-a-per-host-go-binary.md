# The unit of remote execution is a per-host Go agent; the control plane stays TS

## Context

Deplo **models** multiple servers — a project carries a `serverId`, the dashboard has a server
picker, `addServer()` ([`lib/data/servers.ts`](../../lib/data/servers.ts)) registers a remote
in a `provisioning` state — but it does **not deploy to them**. `serverId` only resolves an IP
for the domain/Traefik labels (`resolveServerIp`, [`lib/deploy/domains.ts`](../../lib/deploy/domains.ts));
every `docker build` / `docker compose up` runs against the **local** daemon
([`lib/infra/docker.ts`](../../lib/infra/docker.ts) — no `DOCKER_HOST`/`tcp://`/`ssh://`
anywhere). A project assigned to a remote server still builds and runs on the Deplo host.

The goal is real multi-server: each project picks a server, and the build **and** runtime land
on that server — without installing the Deplo app (let alone a second frontend) on every box.
The host-coupled half of the platform (Docker exec, the build pipeline, log/console streaming,
host metrics) must move to the target; the data/policy/API half (GraphQL, Drizzle, auth,
multi-tenancy) must not. This ADR records *what the remote unit of execution is* and *where the
seam falls*. The full design and phasing live in
[`docs/research/server-agent/PLAN.md`](../research/server-agent/PLAN.md); the eight decisions
below are referenced there as D1–D8.

## Implementation status

**Parts A, B, C and D are implemented — the full A–D arc is complete.** Part A routed the
localhost deploy through the agent; Part B makes a remote agent real: call-home provisioning,
remote `agent-client` routing with cert fingerprint pinning, the GIT source (the agent clones
itself, D3), and reconnection/replay (D5). Part C moves the per-server **observability +
lifecycle + files** surface onto the owning agent. Part D moves the last per-host singletons —
**dev containers + the SSH gateway + the VS Code tunnel** — agent-side (below). *(Jul 2026:
dev mode was later removed from the product; Part D's dev/gateway/tunnel surface is no longer
called by the control plane, its RPCs staying dormant in the additive-only V1 contract.)*
Two refinements
emerged while building Part B and are recorded here:

- **The trust direction inverts for a remote agent.** Part A's control plane minted the agent's
  cert *and key* and wrote both to the agent's disk — possible only because the agent was local.
  A remote agent's private key must never leave the remote, so the agent **generates its own key
  and sends a CSR** during call-home; the control plane CA **signs the CSR** (`signAgentCsr`,
  [`lib/agent/pki.ts`](../../lib/agent/pki.ts)) and pins the resulting cert's fingerprint. The
  agent's key is never on the wire. Cross-language verified (Node mints, Go serves) by the Part B
  e2e (`scripts/agent-part-b-e2e.mts`).
- **Bootstrap trust degrades safely without TLS.** P2/P3 want the agent to verify the control
  plane by cert fingerprint before sending the token, but the control plane is plain HTTP on
  :3000 unless a domain is configured (Traefik adds TLS only then). So: over **HTTPS** the agent
  pins the fingerprint (P3, unchanged); over **plain HTTP** (the bare-IP case) the one-time token
  doubles as a shared secret — the control plane **HMAC-signs the bootstrap response with the
  token**, and the agent refuses a response whose HMAC it cannot reproduce, so a network attacker
  who never had the token cannot forge the CA it hands back. The `Server` row stores only the
  token's sha256 (+ expiry), never the raw token.

**Part C — per-server observability, lifecycle, and files.** Every project surface that was
direct-Docker / local-`fs` now resolves the project's owning server and branches: localhost keeps
the in-process path unchanged; a **remote** routes through `connectAgent(serverId)` to the owning
agent. New agent RPCs (additive, contract still V1): `FollowLogs` (live `docker logs -f` as raw
byte chunks), `Attach` (bidi console; the **pty moved from Node node-pty to Go creack/pty**),
`Exec`/`ListInstances`/`ShellLabel` (the console introspection), and the file RPCs
(`ListFiles`/`ReadFile`/`WriteFile`/`UploadFile`/`CreateDir`/`DeleteFile`/`RenameFile`/`FilesExist`).
The streaming RPCs are adapted to the existing `AttachHandle` so the SSE session registries
(`lib/logs/session.ts`, `lib/attach/session.ts`) and the browser SSE contract are unchanged. Two
adjacent gaps from B are closed here too: the **lifecycle verbs** (`stopContainer`/`startContainer`/
`destroyStack`) now drive the owning agent's `Stop`/`Start`/`DestroyStack` for a remote project
(they shelled the local socket before), and the **console exec** path joins the same agent route.

Three rules hold across Part C: (1) every container RPC carries `project_id` and the agent
**label-checks `deplo.project=<id>`** (`assertOwned`) before acting — defence in depth on a
container name off the wire; (2) the files sandbox is **re-enforced agent-side** (`internal/safepath`,
re-ported `resolveWithinRoot`) since the path arrives off the wire (D9); (3) a remote whose agent is
**unreachable fails clearly with no local fallback** — never a synthetic container entry, never the
master's metrics, never an rm against the wrong disk (a remote `destroyStack` skips the local
file cleanup; those files live on the agent and its `DestroyStack` owns them). The Files tab,
gated to localhost until now (D9), is **re-enabled for remote** (its only gate, `projectFilesExist`,
now asks the owning agent). Verified by `scripts/agent-part-c-e2e.mts` (17 checks over real Docker +
mTLS: instances/exec/label-deny/shell/logs/attach/metrics/files-CRUD/traversal-reject) plus Go unit
tests for the sandbox + shell classification.

**Part D — dev containers + SSH gateway + VS Code tunnel per server.** The last per-host
singletons (ADR-0002) move agent-side, so a project that lives on a remote server gets its dev
container, its SSH gateway, and its tunnel **there**. The seam holds: the control plane keeps ALL
the rendering as the single source of truth and ships it opaque (D2/D4); the agent owns the
host-coupled half. New agent RPCs (additive, contract still V1):

- **Dev lifecycle** — `StartDev`/`ResetDevWorkspace` (server-streaming like `Deploy`, so the
  materialise/up logs flow into the same SSE plumbing) + `StopDev`/`TeardownDev`. The control
  plane renders the dev compose (`renderDevCompose`), the entrypoint script (`devEntryScript`),
  the **tokenized clone URL** (it mints the GitHub App token; the agent writes the 0600
  `/run/deplo/clone-url` file and never holds the key — D4), and the **upload archive** (tarred
  and shipped; the agent extracts it into its own workspace, clone-once). `lib/deploy/dev.ts` is
  now pure renderers + the build-context helpers; the lifecycle lives in `lib/deploy/agent-dev.ts`
  (the dev-mode twin of `agent-deploy.ts`), routed through `connectAgent(serverId)` for localhost
  and remote alike (Decision 4, uniform path).
- **"Deploy from dev workspace"** gains a new `SOURCE_KIND_DEV_WORKSPACE`: for a remote project
  the workspace lives on the agent, so the agent builds from its **own** `<dev-dir>/<slug>` —
  applying the same exclude-set (`node_modules`/`.deplo`/`.deplo-home`/`.git`) + symlink-reject
  guard `copyWorkspaceForBuild` does on localhost, plus a re-validated `rootDirectory` subdir. No
  workspace bytes cross the wire; localhost keeps the local-copy path.
- **SSH gateway** — `EnsureGateway`/`ProvisionSshUser`/`DeprovisionSshUser`. The store's
  `DevSshUser[]` stays the SOLE source of truth (ADR-0002); the running gateway is a disposable
  projection of it that now lives on the **owning server's** host. The control plane keeps
  `gateway-config.ts`/`gateway-projection.ts` as the single (snapshot-tested) renderer and ships
  the rendered config files + the per-user provision/deprovision **exec-step plan** (the password
  rides in a step's stdin, never argv/env); the agent writes the files, brings the 2-service
  socket-filtered stack up, and runs the steps. The compose's host-specific bind path is rendered
  with a `__DEPLO_GW_HOST_DIR__` sentinel the agent substitutes for its own gw dir (the control
  plane cannot know a remote agent's real path). A user RPC sends the **full** user set so a
  freshly-created gateway rebuilds its whole projection. The security-critical wrapper /
  sshd_config / socket-filter are NEVER re-implemented in Go.
- **VS Code tunnel** — `StartTunnel`/`GetTunnel`/`StopTunnel`, thin `docker exec` wrappers (the
  tunnel dials OUT to Microsoft's relay, so no inbound port / gateway change). The control plane
  renders the launch script and **parses the raw log** (`parseTunnelLog` — device-login link /
  connected URL stays pure TS, not duplicated in Go).

A race was found and fixed building Part D: the gateway's `waitGatewayReady` must gate on the
`devusers` **group** existing, not just the sshd binary — the entrypoint creates the group AFTER
the binary lands but BEFORE `exec sshd`, so an `adduser -G devusers` fired on a `command -v sshd`
signal raced the `addgroup` and silently failed ("unknown group devusers"). Verified by
`scripts/agent-part-d-e2e.mts` (16 checks over real Docker + mTLS: StartDev/StopDev/TeardownDev,
a DEV_WORKSPACE deploy, GetTunnel, EnsureGateway + ProvisionSshUser + account/map verification +
DeprovisionSshUser) plus Go unit tests for the workspace exclude/symlink-reject/subdir guards and
the gateway-config sentinel substitution.

## Decision

1. **The unit of remote execution is a single-purpose Go agent, one per server** — not
   agentless remote-Docker. Each target server runs a `deplo-agent` process that owns the
   Docker socket and host filesystem on its own machine and exposes them over a typed RPC. The
   control plane never reaches a remote Docker socket directly. The agent is **platform
   infrastructure**, the moral sibling of today's local Docker socket — not a project and not a
   frontend. (Rejected: `DOCKER_HOST=ssh://…` — see Considered options.)

2. **The agent is a single static Go binary.** No Node, no npm, no Deplo app on the remote —
   one `scp`-able artifact runnable on a bare Linux host with Docker installed. The work is
   process/stream orchestration, which maps cleanly onto Go's `os/exec` + goroutines +
   `creack/pty` (the pty replaces the one Node-native piece, `attachContainerPty`).

3. **The control plane stays TypeScript.** GraphQL, the `lib/data/` layer, auth, tokens, and
   multi-tenancy are untouched in language. The ~47k-line TS codebase and the GraphQL schema
   (already the UI's contract) are reused, not rewritten. The agent absorbs the *host-coupled*
   code, not the API. Authoritative state — `Deployment` rows, project state, env vars — stays
   in the control-plane store.

4. **The agent RPC is the second system boundary, over gRPC + mTLS (D7 for layout).** Alongside
   GraphQL (UI ↔ control plane), a versioned `proto/agent.proto` (control plane ↔ server) is a
   first-class contract: typed messages + server-streaming for live build/run logs in one
   connection. Each agent gets a per-server keypair at install; the control plane pins it; the
   agent listens only for the control plane, never the public internet — treated like the
   docker-socket-proxy trust boundary of [ADR-0003](0003-gateway-socket-access-is-proxied-and-key-auth-is-default.md).
   `proto/` and the Go `agent/` live **in this monorepo**, so the contract and both
   implementations (TS client, Go server) change in one commit and cannot drift.

5. **Localhost is agent 0, reached incrementally (D1).** "localhost" and "remote" become one
   execution path parameterised by which agent, collapsing the `type: "localhost" | "remote"`
   special-casing to a transport detail. This is reached in stages, not at once: the **deploy**
   path goes through the agent first (proving the contract on localhost with zero remote risk);
   the **log/console/metrics and project config-file** paths are repointed later (D9 — the
   `fs.*` editor of the bind-mounted files under `/data/stacks/files/<slug>/` is host-coupled and
   rides the same seam; its Files tab is gated to localhost projects until then). Until then the
   two coexist on the host — deploys flow agent → control plane → pubsub, while log-tailing/
   console/file-editing still hit the local Docker socket / local `fs`. The plan does **not**
   claim the first phase unifies localhost and remote; it unifies only *deploy*.

6. **The control plane renders the compose; the agent receives opaque YAML (D2).**
   `renderCompose` ([`lib/deploy/build.ts`](../../lib/deploy/build.ts)) stays the single source
   of truth in TS, including the byte-identical-reroute contract. The deploy request carries the
   **rendered YAML**, not the inputs to render it; the agent never re-implements routing/label
   logic in Go.

7. **Decrypted env crosses the wire; the agent never holds the encryption key (D4).** The
   control plane decrypts via `revealEnv` ([`lib/data/env.ts`](../../lib/data/env.ts)) and sends
   the resolved plaintext map inside the deploy request over mTLS. The master key lives in
   exactly one place. The container needs plaintext to run regardless, so the only real variable
   is *where the master key lives* — one place beats every-server, on both simplicity and blast
   radius. The agent writes secrets to `0600` files and does not persist them beyond the stack's
   lifetime.

8. **Each agent builds its own image — no registry (D6); source transfer is one-directional
   (D3).** The agent materializes the source on its own box — `git` clone with a short-lived
   token, `upload` archive **streamed inside the deploy RPC** (no second control-plane
   endpoint), or `image` pull — and builds locally. Traffic stays control plane → agent, one
   port to guard (the agent's). The source descriptor stays abstract so "image from registry" is
   a future enum case, not a redesign.

9. **The control plane stays a single process (D8).** The in-process pubsub singleton
   ([`lib/graphql/pubsub.ts`](../../lib/graphql/pubsub.ts)) and the log/attach session registries
   ([`lib/logs/session.ts`](../../lib/logs/session.ts), [`lib/attach/session.ts`](../../lib/attach/session.ts))
   are kept as-is for the whole rollout. The agent moves *execution* off-box without making the
   control plane horizontally scalable. **Horizontal scaling of the control plane is out of
   scope**; if ever needed, pubsub + sessions must be externalized (e.g. Redis) or pinned with
   sticky routing — a separate workstream the agent does not address.

10. **Provisioning is call-home bootstrap, not SSH-in; the control plane is the agents' CA
    (P1–P6).** An agent is born by the operator running a paste-on-the-server bootstrap script
    that installs Docker + the binary and **calls home** with a **one-time, short-lived,
    sha256-at-rest token** (the existing registration-link pattern + expiry). The control plane
    **never holds an SSH/root credential for a remote server** and never opens an outbound SSH
    connection — rejected for the same reason ADR-0003 refuses raw socket access on the gateway:
    it would pile the whole fleet's root keys into the root, socket-mounted control-plane
    container (one bug = every server). Trust is **mutual and self-contained**: the agent pins
    the control plane by **cert fingerprint** carried in the bootstrap command (primary path,
    because reaching the control plane by bare IP with no public domain is common), and the
    control plane signs the agent's mTLS cert with a **private CA derived from `DEPLO_SECRET`**
    (`deriveKey("agent-mtls-ca")`) — one cryptographic source of truth, no external CA for
    internal trust, Let's Encrypt reserved for users' public domains. Agent health is **read
    live** (a fast `Hello`, like apps' status — never a stored value that can go stale), with a
    **mandatory pre-flight `Hello`** before every remote deploy. Server removal **always revokes
    the agent's cert first** (even if the host is dead), **blocks while projects are still
    assigned**, and tears down the remote **best-effort**. **Known debt:** `DEPLO_SECRET` has no
    rotation, so rotating it re-provisions every agent.

## Considered options

- **Agentless remote-Docker (`DOCKER_HOST=ssh://…`)**: rejected — faster to a first deploy, but
  it leaves `/data` paths, build context, and the host-mountpoint `docker inspect` dance
  ([`lib/deploy/builders.ts`](../../lib/deploy/builders.ts)) on the wrong machine, and gives no
  clean place for streaming, metrics, or health. The agent owns the host-coupled half outright
  instead of remoting one verb at a time.
- **Rewrite the control plane (or the whole platform) in Go**: rejected — discards a ~47k-line
  TS codebase and the GraphQL schema that is already the UI's contract, for a language change
  the API layer does not need. Only the host-coupled execution layer becomes Go, and only
  because it ships per-server.
- **A second frontend / full Deplo app on each remote**: rejected — the remote needs to *execute*,
  not to be administered. One headless binary, one unchanged Next.js UI.
- **Agent renders the compose from inputs**: rejected — would port fragile render logic
  (routing labels, the byte-identical-reroute contract) to Go and require keeping two renderers
  in sync forever. One renderer in TS, opaque YAML on the wire.
- **Per-agent data-key + ciphertext on the wire**: rejected — spreads the master key across
  every remote host (larger attack surface) for no real gain, since the container needs
  plaintext to run regardless. The key stays in one place.
- **Build once, push to a registry, agents pull**: rejected *for now* — solves a problem (same
  project on many servers; bit-identical images) that does not exist today, at the cost of
  standing up and securing registry infrastructure. The source descriptor leaves the door open
  for it later.
- **Separate `../deplo-agent` repo**: rejected — splits the contract from one of its two
  implementations, inviting silent drift between the wire definition and the side that consumes
  it. Justified only if the agent were an independently-shipped product, which it is not.
- **SSH-in provisioning (control plane holds the server's root credential and installs over
  SSH)**: rejected — smoother UX (one click, no paste-on-the-server step), but it concentrates
  the whole fleet's root keys inside the root, socket-mounted control-plane container, and
  inverts the system's one-directional trust (every other flow is server → control plane). The
  call-home bootstrap keeps root credentials off the control plane entirely.
- **Separate / HSM-backed agent CA (key not derived from `DEPLO_SECRET`)**: rejected — adds a
  second critical secret to back up and protect, for an illusory gain: a compromised control
  plane already owns the Docker socket and decrypts every secret, so the CA introduces no target
  that isn't already inside that blast radius. Reconsider only under an explicit compliance
  mandate.
- **Public-CA (Let's Encrypt) trust for the first agent↔control-plane contact**: rejected as the
  *primary* path — operators commonly reach the control plane by bare IP with no public domain,
  where no public cert exists; fingerprint pinning works identically with or without a domain and
  matches the cert-pinning the agent uses for mTLS anyway.
- **Stored, push-only server `status`**: rejected as the source of truth — it is the documented
  staleness bug the glossary already calls out for `dev.status`/`project.status`; health is read
  live like apps' status, with the stored field demoted to a cache.

## Consequences

- A new in-repo `agent/` Go module and `proto/agent.proto` join the build; CI becomes
  bilingual (Node + Go). Accepted — it is what keeps the contract and both sides in one commit.
- The deploy path gains a choke point (`lib/infra/agent-client.ts`) that replaces direct
  `lib/infra/docker.ts` calls; `runDeployment` streams `DeployEvent`s into the existing
  log/status writes and `publishProjectChanged`, so the UI's subscriptions light up unchanged.
- A stable deploy id ships from the first phase. Early on the deploy is fire-and-forget and a
  hung `building` deployment is reconciled to `error` on control-plane restart; reconnection/
  replay (the agent keeps building and re-streams missed events) lands with real remote deploys.
- mTLS provisioning becomes a new privileged surface, but a **call-home** one (decision 10):
  `addServer()` mints a one-time bootstrap token and returns a paste-on-the-server command; the
  operator runs it, the agent installs itself and calls home, and `Hello` flips
  `provisioning → ready`. The `Server` row grows provisioning/trust fields it lacks today — the
  pinned agent cert (for auth + revoke-on-removal), the bootstrap token's sha256 + expiry, and a
  `lastSeenAt` heartbeat cache — all encrypted at rest via the existing
  `encryptSecret`/`decryptSecret`. This is the riskiest piece and was grilled separately; the
  blow-by-blow lives in the plan's Part B (P1–P6).
- Localhost special-casing (`resolveServerIp`, `measureLocal` in
  [`lib/data/monitoring.ts`](../../lib/data/monitoring.ts), the dev gateway) generalizes to
  "the control plane's own agent" as the log/console/metrics path is repointed.
- The project config-file editor ([`lib/data/project-files.ts`](../../lib/data/project-files.ts),
  capability `manage_files`) is host-coupled `fs.*` on the project's box, so it joins the seam
  (D9): file RPCs in the contract, the anti-traversal sandbox re-ported to Go in the agent, and
  the Files tab gated to localhost projects until Part C repoints it. New host-coupled features
  added later should be checked against this seam by default.
- Dev containers + the SSH gateway ([ADR-0002](0002-ssh-gateway-is-lazy-platform-infrastructure.md))
  are per-host singletons and now run agent-side too (Part D, above): `lib/deploy/agent-dev.ts`
  drives the dev lifecycle + tunnel; `lib/infra/ssh-gateway.ts` renders the gateway config + the
  per-user step plan and ships them to the owning agent. ADR-0002 is unchanged in spirit — the
  store leads, the container is a disposable projection — only its host moved.
- A **server agent** glossary entry is added to `CONTEXT.md` (Runtimes section).
