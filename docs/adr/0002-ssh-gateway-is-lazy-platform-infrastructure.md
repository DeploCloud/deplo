# The SSH gateway is lazy platform infrastructure, not reserved at install

## Context

Dev mode lets users join their dev container over real SSH. A single platform-wide
`deplo-ssh-gateway` container publishes one port (`2222`) and `ForceCommand`s each user
into their own project's dev container. The gateway holds mutable per-user OS state
(`/etc/passwd`, `/etc/shadow`, `authorized_keys`, per-user map files) and mounts the
docker socket — the most privileged surface in the system. It is the first
platform-level singleton runtime alongside Traefik and the `deplo` network; every other
long-lived container is per-project or per-database.

## Decision

The gateway is **platform infrastructure** (modeled like Traefik / the `deplo` network),
not a `Project`/`Database`/store collection. It is created **lazily** by an idempotent
`ensureGateway()` on the first dev SSH user — **not** reserved at install. The store's
`DevSshUser[]` is the **sole source of truth**; the gateway container is a disposable
**projection** that `reconcileGateway()` rebuilds from the store on first boot or after
drift. Its internal `/etc/passwd` is cache, never the record.

## Consequences

- A password-capable SSH port opens only when a project actually adds its first SSH
  user — installs that never touch dev mode never expose `2222`. (Install-time reserve
  is rejected: it opts every install into SSH attack surface for a feature most won't
  use. If ever wanted, it's an opt-in install flag, not the default.)
- The gateway can be destroyed/recreated freely (image upgrade, reboot) and rebuilds
  itself from the store — no per-user state is lost when the container is replaced.
- All SSH-user mutations are store writes first, gateway exec second; a reconcile after
  drift is always correct because the store leads.
