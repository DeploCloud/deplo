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

## Status: Part A

Part A routes the **localhost** server's *deploy execution* through the agent,
with **no user-visible behaviour change**. The agent implements:

- `Hello` — health + identity handshake; the mandatory deploy pre-flight (P5).
- `Metrics` — host CPU/mem/disk/net snapshot (replaces `lib/infra/host.ts`).
- `Deploy` — server-streaming build + run for the **Dockerfile build + single-
  image compose-up** path (the most common). Other build methods
  (Nixpacks/Buildpacks/Railpack/static) and multi-service compose stacks stay on
  the control plane's local path in Part A and migrate later.
- `StopStack` / `StartStack` / `DestroyStack` / `Inspect` — stack lifecycle.

`FollowLogs` / `Attach` / file RPCs (Part C) and the remote call-home bootstrap
(Part B) are defined in the proto but not yet wired.

## Trust (mTLS from day one)

The control plane is the certificate authority; its CA key is **derived from
`DEPLO_SECRET`** (no stored CA key, no external CA). The agent presents a
CA-signed server cert and requires a CA-signed client cert from the control
plane — mutual TLS, one trust model for the local agent today and remote agents
later. Cert minting lives in [`lib/agent/pki.ts`](../lib/agent/pki.ts); the local
agent is supervised by [`lib/agent/local-agent.ts`](../lib/agent/local-agent.ts).

## Build & test

```bash
make build          # -> bin/deplo-agent (static)
make test           # go test ./...
make proto          # regenerate Go + TS stubs from ../proto/agent.proto
```

The production image builds the binary in a `golang:1.23-alpine` stage and copies
it to `/usr/local/bin/deplo-agent` (`DEPLO_AGENT_BIN`); the control plane launches
it as the local agent. End-to-end against real Docker:
`npx tsx scripts/agent-e2e.mts` from the repo root.

## Layout

| Path | Responsibility |
|---|---|
| `main.go` | flags, mTLS config, gRPC server wiring |
| `internal/server/` | the Agent service impl (`server.go`, `deploy.go`) |
| `internal/dockercli/` | `docker`/`compose` CLI exec (port of `lib/infra/docker.ts`) |
| `internal/hostmetrics/` | host metrics from `/proc` + statfs (port of `lib/infra/host.ts`) |
| `internal/safepath/` | anti-traversal sandbox (port of `lib/deploy/path-safety.ts`) |
| `gen/` | generated protobuf/gRPC (do not edit; `make proto`) |
