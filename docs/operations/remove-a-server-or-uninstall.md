# Remove a server, or uninstall

## What it is

Taking a machine out of the fleet, removing Deplo's agent from that machine,
and removing Deplo itself from the machine it runs on.

They are three different acts, on purpose.

## How it works

**Removing a server in Deplo is trust revocation.** The pinned certificate is
cleared, and the control plane will never talk to that machine again. It does
**not** reach in and uninstall anything, because at the moment you most need to
remove a server, it is usually not answering.

**Uninstalling is a command you run on the host.** Deplo prints it for you.

The one exception is a [migration source](../advanced/server-roles.md), which
Deplo does uninstall itself from, because that role exists precisely to be
temporary.

## Remove a server from Deplo

1. Move or delete anything still running there. Removal does not.
2. Open **Settings -> Servers**, choose the server, then **Advanced**.
3. Click **Remove server** in the danger zone.
4. Copy the uninstall command it prints, if you want the host cleaned.

The machine running the control plane cannot remove itself.

Any pending teardowns for that server are dropped with it, so Deplo stops
retrying instructions nobody can carry out.

## Uninstall the agent from a host

One script does both jobs: `uninstall.sh`. `--agent-only` is what keeps it to
the agent, and it is already in the command the dashboard prints for you.

The script is **a dry run by default**. Running it with no flags prints exactly
what it would do and changes nothing.

```bash
# See what would happen
curl -fsSL https://deplo.example.com/uninstall.sh | sudo bash -s -- --agent-only

# Do it
curl -fsSL https://deplo.example.com/uninstall.sh | sudo bash -s -- --yes --agent-only

# Do it, and delete the data too
curl -fsSL https://deplo.example.com/uninstall.sh | sudo bash -s -- --yes --agent-only --purge-data
```

| Without `--purge-data`               | With `--purge-data`          |
| ------------------------------------ | ---------------------------- |
| The systemd unit and the binary      | Everything on the left, plus |
| Containers labelled as Deplo-managed | app and database **volumes** |
| Deplo's Traefik on that host         | images Deplo built           |
| The `deplo` network                  | the stacks directory         |
| `/var/lib/deplo-agent`               |                              |

It never touches Docker Engine itself, and never touches a container Deplo did
not label. It is safe on a machine that was never a Deplo host, and safe to run
twice.

> **`/var/lib/deplo-agent` holds Traefik's `acme.json`.** Removing it takes your
> issued certificates with it. Let's Encrypt rate-limits reissuance, so if you
> plan to reinstall on the same host and the same domains, copy that file first.

## Uninstall Deplo itself

Same script, without `--agent-only`. It removes the control plane in
`/opt/deplo` as well: the panel, its Postgres, its Traefik, the agent on that
machine, and every container Deplo deployed there.

```bash
# See what would happen
curl -fsSL https://deplo.example.com/uninstall.sh | sudo bash

# Do it, keeping every volume and /opt/deplo
curl -fsSL https://deplo.example.com/uninstall.sh | sudo bash -s -- --yes

# Do it, and delete the data with it
curl -fsSL https://deplo.example.com/uninstall.sh | sudo bash -s -- --yes --purge-data

# And the backups stored on this machine
curl -fsSL https://deplo.example.com/uninstall.sh | sudo bash -s -- --yes --purge-data --purge-backups
```

Order matters and the script handles it: the panel and its Postgres stop
**before** Traefik and the `deplo` network go away under them.

> **`--purge-data` deletes `/opt/deplo/.env`, and that file holds
> `DEPLO_SECRET`.** Every backup artifact this instance ever wrote is encrypted
> with a key derived from it, and there is no other copy. If you might ever want
> to restore any of it, copy that file somewhere else first.

`--purge-backups` is separate for the same reason: everything else on the
machine can be rebuilt from a backup, and those **are** the backups.

If you are moving the instance rather than ending it, take
[disaster recovery](disaster-recovery.md) first and uninstall second.

## Decommission a machine properly

1. Move the apps to another server, or delete them.
2. Move or re-point any backup destination that lives on it.
3. Take a final backup if anything there is not backed up elsewhere.
4. Remove the server in Deplo.
5. Run the uninstall command on the host, with `--purge-data` if the machine is
   being handed on.
6. Delete the machine at your provider.

For the machine running the panel, steps 4 and 5 are one command: uninstall
without `--agent-only`.

## Limits and gotchas

- **Removing a server does not stop its containers.** They keep running,
  unmanaged, until somebody stops them. That is why the uninstall step exists.
- **Apps still assigned to a removed server cannot deploy.** Move them first.
- **Reinstalling an agent re-bootstraps from scratch.** The installer deletes
  the existing certificate files, so it genuinely re-enrolls against the new
  pin rather than half-trusting the old one.
- **A migration source is removed with `Remove from Deplo`**, and Deplo uninstalls
  its own agent from that machine as part of it.
- **The panel cannot uninstall itself.** Nothing in the dashboard removes the
  control plane; it is the thing doing the removing. That is what the host-side
  script is for.
- **Docker Engine and `/etc/docker/daemon.json` stay.** The installer widened
  Docker's address pools and kept your original as `daemon.json.deplo-bak`.
  Putting it back needs a Docker restart, which stops every container on the
  machine, so the uninstaller only tells you it is there.

## If it does not work

- **The uninstall script does nothing** - it is a dry run. Add `--yes`.
- **Containers survive the uninstall** - they were not labelled as Deplo-managed,
  which means something else created them. That is deliberate.
- **The server reappears** - the agent is still installed and calling home.
  Uninstall it on the host.
- **The panel is gone but :80 and :443 still answer** - you passed
  `--agent-only` on the machine running the panel. Traefik goes with the agent;
  re-run `install.sh` to bring it back, or uninstall properly without the flag.

## See also

- [Installers reference](../reference/installers.md) - every flag of all three scripts
- [Server settings](../guides/server-settings.md)
- [Server roles](../advanced/server-roles.md)
- [Disaster recovery](disaster-recovery.md)
- [`docs/adr/0011`](../adr/0011-server-removal-is-trust-revocation-not-a-host-uninstall.md)
