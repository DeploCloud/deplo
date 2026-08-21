# ADR-0025: A migration source is a server that hosts nothing, and Deplo takes itself back off it

**Status**: accepted

## Context

Importing from another platform needs an agent **on that platform's host**. A volume is copied
by the agent standing on the disk that holds it, and agents are a star: they cannot dial each
other ([ADR-0006](0006-server-agent-is-a-per-host-go-binary.md)). So the import wizard's
`MachineGate` registers each Dokploy machine and hands over an install command - and it has to,
because the alternative is telling somebody to move their data by hand over SSH, which is the
one thing the product exists not to require.

It registered them with the ordinary `addServer`. From that moment the machine somebody was
migrating AWAY from was a full member of the fleet:

- offered as a deploy target, and - worse - as a **build** target. Every "can this machine
  build?" check read `storage_only`, which a Dokploy host passes: it obviously has Docker. A
  pinned build server ships an App's source and its **decrypted env** to the builder.
- swept by Docker cleanup, on a schedule nobody on that machine set;
- eligible as a backup destination, including as the auto-seeded default for a fresh team,
  which then made the server un-removable (`backup_destination.server_id` is ON DELETE RESTRICT);
- visible to every team, since `servers.all_teams` defaults to true;
- counted in the fleet, polled for telemetry, and dialed inside the render of Settings → Servers.

And when the migration ended there was no way to undo the install from the product. Removing the
server revoked trust and printed a `curl | bash` one-liner for the operator to run on a host they
may not even have shell on.

## Decision

**A migration source is a fourth server role, and the only one Deplo uninstalls itself from.**

### The role is `import_only`, and it is not a shape of machine - it is an ownership statement

`servers.import_only` (migration 0111) joins `storage_only` and `build_only` under a CHECK that
now counts three. `canHostWorkloads` - the one predicate behind every deploy picker - excludes
it, and so does every build-side check, which had to be widened one by one precisely because
they all keyed on "has Docker".

The role answers a different question from the other two. Those describe how an operator shaped
a machine they own. This one says the machine is **not ours**: borrowed for one import, given
back. Every exclusion follows from that sentence rather than from a capability the host lacks.

### It is born only from the wizard, granted to one team, and refused in both directions

`addServer({ importOnly: true })` forces `all_teams: false` and grants the calling team alone -
another team seeing the row would be a leak of who is migrating what from where. `setServerRole`
refuses to enter the role (a demoted real server would arm an agent uninstall against a box that
runs apps) and to leave it (the installer put no Traefik, no shared `deplo` network and no
`daemon.json` change there, and no database write can undo that). **Re-running the install
command is the way in and the way out.**

`addServer` also refuses a migration source at an address Deplo already stands on - its own host,
or an existing row. The failure it prevents is quiet: same box, two rows, an installer that
clears the existing mTLS materials and re-bootstraps, and a "Migration complete" that then
uninstalls the fleet's own agent.

### The install touches the host as little as an install can

`DEPLO_IMPORT_ONLY=1` skips Traefik, the shared `deplo` network, the backup store, and - the one
that matters most - `configure_docker_address_pools`, which rewrites `/etc/docker/daemon.json`
and can restart the daemon under a live production workload. Docker is never installed either: a
migration source without Docker has no volumes to import, so that is a refusal, not a thing to
fix on someone else's machine.

What is left on the host is the systemd unit, the binary and `/var/lib/deplo-agent` - which is
exactly the set `SelfUninstall` removes. The footprint and the uninstall are defined against each
other on purpose: an uninstall that cannot honestly claim to have removed everything is the kind
of promise this codebase already refused once.

### `SelfUninstall` is the host-teardown RPC ADR-0011 anticipated

[ADR-0011](0011-server-removal-is-trust-revocation-not-a-host-uninstall.md) said removal is trust
revocation and never a host uninstall, and it was right for the case it was about: after the
guards, the control plane provably owns no stack it could name, everything that survives was put
there by `install-agent.sh`, and revoking trust is precisely what ends the right to command the
agent. It also said, explicitly, that **if** a genuine host-teardown RPC ever arrived it must be
additive, gated on a Hello capability, and must not replace the script. This ADR **extends** it;
it does not supersede it.

- Additive `SelfUninstall`, contract stays V1, capability `self-uninstall` (agent v1.29.0). No
  fleet rollout is needed for the feature to work: a migration source always installs the latest
  agent. It is deliberately NOT in `PLATFORM_FEATURES` - that would mark every existing server in
  every fleet degraded until it was upgraded.
- The removals are **synchronous** and only the exit is deferred. The control plane deletes the
  row only on success, so a failure has to be returnable - the inverse of `SelfUpdate`, which can
  safely answer "restarting" and finish afterwards.
- The unit is `disable`d, never `stop`ped and never `disable --now`: it has no `KillMode`, so the
  default is control-group and stopping it would kill the process (or any child it forked) before
  a single file was removed. It ends by exiting 0, which `Restart=on-failure` ignores.
- **Docker is out of scope.** On a migration source the containers, images and networks belong to
  the platform being migrated from; on an ordinary server that cleanup is the script's job.

`uninstallServerAgent` orders it: guards (a destination on the host would fail the delete after
the agent is gone) → **uninstall** → **then** revoke trust and delete the row, because revoking
first would make the call one we are no longer entitled to make. Any failure keeps the row and
returns the host-side command - a deleted row plus a live agent is a machine nobody can see and
nobody can clean.

### The UI says it is not one of your servers

Settings → Servers lists migration sources in their own section, out of the fleet count, with no
Manage page (every tab there operates a host) and one action in a `⋯` menu: **Uninstall agent**,
which degrades to "forget the row" when the install command was never run - the only way out for
a failed registration now that the page is gone. The import report, in both its homes, offers
**Migration complete - remove the agent**. It is a step and not an automatic sweep because an
import is usually several passes, and uninstalling after the first would lock the operator out of
the rest.

## Consequences

- A fourth role means every `!storageOnly` filter is now a question. The build axis was the
  dangerous one and is closed; the same reading found three older holes where any non-workload
  server could already be targeted (`updateAppSource`, `setAppPreviewSettings`, `getPrimaryServer`),
  which are closed with it.
- `planMachines` and `resolveSourceServer` must keep matching a migration source by address - they
  are the volume copy's own lookup. A filter added there would break every second-pass import
  silently, which is why it is pinned by a test.
- The agent can now end its own life. It is the only RPC that can, it is capability-gated, and the
  control plane only ever aims it at a host whose row says `import`.
- Existing installs are not backfilled: a Dokploy host someone registered before this stays an
  ordinary server. There is no reliable signal to detect one after the fact, and demoting a server
  that has since grown apps would be worse than the confusion.
