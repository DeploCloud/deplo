# Server roles

## What it is

What a machine is allowed to be. The role is chosen when the agent is installed
and decides what gets set up on the host and where the server appears in the
interface.

## The four roles

| Role                 | Docker             | Traefik | Deploy target | Backup destination | In monitoring |
| -------------------- | ------------------ | ------- | ------------- | ------------------ | ------------- |
| **Everything**       | yes                | yes     | yes           | yes                | yes           |
| **Build only**       | yes                | no      | no            | no                 | yes           |
| **Backups only**     | no                 | no      | no            | yes                | yes           |
| **Migration source** | must exist already | no      | no            | no                 | no            |

### Everything

The default, and what a single-machine install uses. Docker, Traefik on ports 80
and 443, the shared `deplo` network, and the address-pool configuration that
stops the host running out of networks at about 31 apps.

### Build only

For [build servers](build-servers.md). It runs the full build pipeline, so it
gets Docker and the address pools, but no Traefik, because nothing is ever
routed to it. It never appears as a deploy target.

Install with `DEPLO_BUILD_ONLY=1` in front of the agent installer, or pick
**Build only** in **Connect a remote server**.

### Backups only

A storage box. **No Docker at all**, no Traefik, no shared network. It holds
backup artifacts and nothing else, which is exactly what you want for the copy
that has to survive losing the machine your apps run on.

Because it never encrypts anything itself and only receives the public half of
each destination's key, **it produces artifacts it cannot read**.

Install with `DEPLO_STORAGE_ONLY=1`, or pick **Backups only**.

### Migration source

The narrowest install, and the only one you never choose from the servers page:
it is created by the [migration wizard](../guides/move-from-dokploy.md).

Docker must already exist on the machine, the address pools are left alone,
there is no Traefik and not even the `deplo` network. It is out of every deploy
and build picker, never a backup destination, never swept by cleanup, absent
from monitoring and from the fleet count, and granted to one team only.

It is also **the only server Deplo uninstalls itself from**. On the servers page
it is listed apart, with a single action to take it back out again.

## Change a role later

There is no in-place role change. Remove the server and install it again with
the role you want. Removal is [trust revocation](../operations/remove-a-server-or-uninstall.md),
so nothing on the host is destroyed by that step alone.

## Limits and gotchas

- **A backups-only host has no Docker.** The agent's systemd unit is installed
  without the docker group, because systemd would refuse to start a unit whose
  group does not exist.
- **A build-only host still needs the address pools**, because it creates
  networks while building.
- **A migration source is a live agent on a machine you are decommissioning.**
  Uninstall it when the migration is done.
- **Roles do not change who may use the server.** That is
  [team access](../guides/server-settings.md), a separate setting.

## See also

- [Add a server](../guides/add-a-server.md)
- [Build servers](build-servers.md)
- [Backups and restore](../guides/backups-and-restore.md)
- [Installers reference](../reference/installers.md)
