# Removing a server is trust revocation, not a host uninstall

## Context

`removeServer()` ([`lib/data/servers.ts`](../../lib/data/servers.ts)) told the operator, in the
confirm dialog, that removal "revokes the agent's trust **and tells it to tear down its
containers**". It did not. The function it called — `teardownServerAgent()` in
[`lib/infra/agent-client.ts`](../../lib/infra/agent-client.ts) — dialed the agent, sent a single
`Hello`, and closed the connection. Nothing was ever torn down. The only real signal it produced
was reachability, which it converted into a warning about cleaning up "leftover `deplo-*`
containers by hand" — advice with no command attached.

The gap is not an oversight that a bigger RPC would close. It is structural:

- **Removal blocks while a workload is assigned**, so by the time the teardown ran, the control
  plane provably owned **no stack it could even name** on that host. There was nothing to destroy.
  (There is no `ListStacks` RPC — a stack the control plane cannot name from Postgres is invisible
  to it forever.)
- **Everything that actually survives a removal has no RPC behind it at all**: the `deplo-agent`
  binary, its systemd unit, `/var/lib/deplo-agent` (the mTLS materials *and* Traefik's
  `acme.json`), the `deplo-traefik` container holding `:80`/`:443`, the `deplo` Docker network,
  the SSH gateway, images built as `deplo/<slug>`, `/data/stacks`, and Docker itself — all of
  which `install-agent.sh` put there, host-side, **before any RPC existed**.
- **Revoking trust is precisely the act that ends our right to command that agent.** A teardown
  RPC issued after the pin is cleared is a call we are no longer entitled to make; issued before,
  it would leave a window where a failed removal has already destroyed the host's containers.

Two further defects sat in the same function. `databases.server_id` is `RESTRICT`
([`lib/db/schema/control-plane.ts`](../../lib/db/schema/control-plane.ts)), but only *apps* were
checked — so removing a server that hosted a database surfaced a raw Postgres foreign-key
violation to the operator. And the trust revoke ran **before** the block, so a removal that was
then refused had already, permanently, de-trusted the server it declined to remove.

## Decision

**Removing a server is trust revocation plus forgetting. It never touches the host, and it says
so.**

1. **Block first, with zero side effects.** Apps *and* databases still on the server block the
   removal, each with a message that names them. Nothing is written until the guards pass.
2. **Revoke trust, then delete — and restore the pin if the delete fails.** A server that is
   still in the table yet can never be dialed again is the worst of both states.
3. **No teardown RPC. No sweep.** Not "not yet" — not ever, under this shape. A function that
   sweeps a provably-empty set is the same lie in a subtler form.
4. **Ship the cleanup the operator actually needs.** [`uninstall-agent.sh`](../../uninstall-agent.sh)
   is served from the control plane exactly like `install-agent.sh` is, and `removeServer` returns
   its one-liner in the mutation payload — so the UI hands it over the moment the server is gone.
   The script is a **dry run** unless given `--yes`, and it never deletes a volume, an image or
   `/data` without a second explicit `--purge-data`. It never uninstalls Docker.
5. **An App mid-move OFF the server warns, it does not block.** `apps.migrate_from_server_id` is
   `SET NULL` on delete, so removing the source host silently drops the marker naming it as the
   copy-from source, and the next deploy would start from empty volumes. Blocking would deadlock
   the operator whose source host is the very thing that died — so the removal proceeds and the
   payload carries a named, loud warning instead of a silent data loss.

## Consequences

- The UI can no longer imply a host cleanup that does not happen. `AGENTS.md`'s "favor
  derived-and-live over stored-and-stale" has a sibling here: **never let copy promise a
  capability the contract does not have.**
- An operator decommissioning a host — e.g. to hand the box to another panel — has a supported
  path that leaves the machine clean, instead of a running, permanently-untrusted agent and a
  Traefik squatting on `:80`/`:443`.
- If the agent ever grows a genuine host-teardown RPC, it must be **additive** (the contract stays
  `V1`) and gated on a `Hello` capability, the way `self-update` and `backup` are. Even then the
  uninstall script stays: an unreachable or already-revoked host will always need a host-side path.

## Alternatives rejected

- **Make `teardownServerAgent` destroy the DB-named stacks.** The set is empty after the guards.
  It would be dead code whose name restates the original promise.
- **Cascade `databases.server_id` instead of guarding it.** It would silently cascade `backups`
  and orphan `backup_runs` history — trading a confusing error for real data loss.
- **A `force` removal that destroys assigned workloads.** Contradicts the conscious-teardown rule
  that the existing block encodes, and is the shortest path to an irreversible mistake.
