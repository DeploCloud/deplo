# The gateway never holds the raw docker socket; key auth is the default

## Context

The SSH gateway is exposed to the public internet on port `2222`. The only thing between
an authenticated user and the gateway's own shell is the `ForceCommand` wrapper, and the
gateway needs docker access to `exec` users into their dev containers. If the gateway
mounted the raw `/var/run/docker.sock`, **one bug in the wrapper = full host root**
(`docker run -v /:/host`). A ForceCommand is a probabilistic defense (careful wrapper)
guarding a deterministic catastrophe (host compromise).

Two independent risk axes exist: **which docker verb** a bypassed gateway could call,
and **which container** it could target (including `docker exec` into the root
control-plane container — a re-escalation path).

## Decision

1. **The gateway never mounts the raw docker socket.** A socket-filtering sidecar holds
   the socket and exposes only `exec`+`inspect`; the gateway talks to it over an internal
   network. This is a **hard requirement** shipped in the gateway compose from day one —
   not a recommended follow-up. A total ForceCommand bypass then yields a shell that
   cannot `docker run`, mount the host fs, or create privileged containers.

   **Implementation note (revised):** the stock `tecnativa/docker-socket-proxy` does
   **not** suffice — its `/containers` ACL is a single all-or-nothing prefix, and
   `docker exec` requires `CONTAINERS=1`+`POST=1`, which simultaneously permits
   `POST /containers/create`, `/start`, and `PUT /containers/{id}/archive` (`docker cp` →
   host-fs write). So the sidecar ships our **own HAProxy default-deny allowlist**
   (`socket-filter.cfg`) that permits *only* `GET /_ping`, `GET /version`,
   `GET /containers/{id}/json`, `POST /containers/{id}/exec`, and the `/exec/{id}/*`
   endpoints — nothing that can create, start, copy into, or run a container. This is
   what actually makes the which-verb layer real.
2. **Key auth is the default; password auth is an explicit per-user opt-in.** Password
   on a public port is a brute-force target; `MaxAuthTries`/`LoginGraceTime` still apply
   when a user opts into a password.
3. The wrapper (which-container axis) and the proxy (which-verb axis) are treated as two
   independent layers. Neither alone is trusted; both must hold.

## Consequences

- Adds one small container per install that uses dev mode. Accepted — the asymmetry
  (one extra container vs. one-bug-to-host-root) is decisive.
- We ship a hand-written HAProxy allowlist rather than a generic socket proxy, because no
  off-the-shelf env-flag proxy can separate `docker exec` from `docker create`/`cp`/`run`
  (they share the `/containers` path family). The allowlist is a small, auditable config.
- The proxy gates verbs, not target containers, so the wrapper still must guarantee the
  exec target is the user's own dev container (and never the control-plane container) —
  e.g. the allowlist permits `exec` into *any* container id; only the wrapper restricts
  *which* id.
- Password-only users are possible but never the default path the UI steers toward.
