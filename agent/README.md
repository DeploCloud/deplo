# deplo-agent

The per-server **server agent** — a single static Go binary that owns the
host-coupled half of the Deplo platform (Docker exec, the build pipeline, host
metrics) on the machine it runs on, and exposes it to the control plane over a
typed, mTLS-secured gRPC contract.

This is **platform infrastructure**, not a project and not a frontend — the
moral sibling of the local Docker socket. See
[`docs/adr/0006-server-agent-is-a-per-host-go-binary.md`](../docs/adr/0006-server-agent-is-a-per-host-go-binary.md)
and the full design in
[`docs/research/server-agent/PLAN.md`](../docs/research/server-agent/PLAN.md).

## Status: Parts A–D complete

Part A routed the **localhost** server's *deploy execution* through the agent;
**Part B makes a remote agent real** (provisioning, remote routing, the GIT
source, reconnection); **Part C** moves the per-server observability + files
surface; **Part D** moves the last per-host singletons (dev containers + SSH
gateway + VS Code tunnel). The agent implements:

- `Hello` — health + identity handshake; the mandatory deploy pre-flight (P5).
  Advertises capabilities incl. `dev` / `ssh-gateway` / `tunnel` (Part D).
- `Metrics` — host CPU/mem/disk/net snapshot (replaces `lib/infra/host.ts`).
- `Deploy` — server-streaming build + run for the **Dockerfile build + single-
  image compose-up** path, from an UPLOAD context, an IMAGE ref, **(Part B) a
  GIT source the agent clones itself**, a **(Part C) multi-service COMPOSE stack**,
  or a **(Part D) DEV_WORKSPACE** source (the agent builds from its own
  `<dev-dir>/<slug>`). Heavy builders (Nixpacks/Buildpacks/Railpack/static) stay
  on the control plane's local path and migrate later.
- `ReattachDeploy` — **(Part B, D5)** reconnect to an in-flight deploy and replay
  missed events; the deploy runs on a background context so a control-plane drop
  never aborts the build.
- `StopStack` / `StartStack` / `DestroyStack` / `Inspect` — stack lifecycle.
- `FollowLogs` / `Attach` / `Exec` / `ListInstances` / `ShellLabel` + the file
  RPCs — **(Part C)** the observability + Files surface.
- `StartDev` / `StopDev` / `ResetDevWorkspace` / `TeardownDev`,
  `EnsureGateway` / `ProvisionSshUser` / `DeprovisionSshUser`,
  `StartTunnel` / `GetTunnel` / `StopTunnel` — **(Part D)** dev containers, the
  per-host SSH gateway projection, and the VS Code tunnel. The control plane
  renders the dev compose / entrypoint / gateway config / per-user exec steps and
  ships them opaque; the agent writes files + drives Docker.

## Trust (mTLS, and the Part-B inversion)

The control plane is the certificate authority; its CA key is **derived from
`DEPLO_SECRET`** (no stored CA key, no external CA). The agent presents a
CA-signed server cert and requires a CA-signed client cert from the control
plane — mutual TLS.

In Part A the control plane minted the agent's cert AND key locally (it was the
same host). **A remote agent's key must never leave the remote**, so Part B
**inverts the trust direction**: the agent generates its own key, sends a CSR
during call-home, and the control plane signs it (`signAgentCsr` in
[`lib/agent/pki.ts`](../lib/agent/pki.ts)), pinning the agent's cert fingerprint
in the `Server` row. The agent authenticates the control plane first — by cert
fingerprint over HTTPS, or by an HMAC over the bootstrap response (keyed by the
one-time token) over plain HTTP. Provisioning is **call-home, never SSH-in** (P1).
The agent half of the bootstrap is [`internal/bootstrap`](internal/bootstrap); the
control-plane half is [`lib/agent/bootstrap.ts`](../lib/agent/bootstrap.ts) +
`app/api/agent/bootstrap`. The local agent is still supervised by
[`lib/agent/local-agent.ts`](../lib/agent/local-agent.ts) (explicit cert flags,
unchanged).

## Build & test

```bash
make build          # -> bin/deplo-agent (static)
make test           # go test ./...
make proto          # regenerate Go + TS stubs from ../proto/agent.proto
```

The production image builds the binary in a `golang:1.23-alpine` stage and copies
it to `/usr/local/bin/deplo-agent` (`DEPLO_AGENT_BIN`); the control plane launches
it as the local agent, and also serves it (checksum-verified) to remote servers
via `/install-agent.sh`. End-to-end against real Docker:

```bash
# Each needs the server-only shim: node --require ./lib/test/server-only-shim.cjs
#   --import tsx scripts/<name>.mts
npx tsx scripts/agent-e2e.mts            # Part A: local supervised agent
npx tsx scripts/agent-part-b-e2e.mts     # Part B: simulated remote — call-home
                                         # bootstrap (CSR-signed) + pinned mTLS +
                                         # git-source deploy + reattach/replay
npx tsx scripts/agent-part-c-e2e.mts     # Part C: instances/exec/logs/attach/
                                         # metrics/files-CRUD + sandbox rejection
npx tsx scripts/agent-part-d-e2e.mts     # Part D: StartDev/StopDev/Teardown +
                                         # DEV_WORKSPACE deploy + tunnel + the SSH
                                         # gateway (ensure/provision/deprovision)
```

## Layout

| Path | Responsibility |
|---|---|
| `main.go` | flags, mTLS config (or call-home bootstrap on first run), gRPC server wiring |
| `internal/server/` | the Agent service impl (`server.go`, `deploy.go`, `git.go`, `inflight.go`) |
| `internal/bootstrap/` | **(Part B)** call-home: generate key+CSR, fingerprint-pin the control plane, persist the signed materials |
| `internal/dockercli/` | `docker`/`compose` CLI exec (port of `lib/infra/docker.ts`) |
| `internal/hostmetrics/` | host metrics from `/proc` + statfs (port of `lib/infra/host.ts`) |
| `internal/safepath/` | anti-traversal sandbox (port of `lib/deploy/path-safety.ts`) |
| `gen/` | generated protobuf/gRPC (do not edit; `make proto`) |
