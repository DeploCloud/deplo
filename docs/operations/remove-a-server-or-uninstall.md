# Remove a server, or uninstall

## What it is

Taking a machine out of the fleet, and separately, removing Deplo's agent from
that machine.

They are two different acts, on purpose.

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

The script is **a dry run by default**. Running it with no flags prints exactly
what it would do and changes nothing.

```bash
# See what would happen
curl -fsSL https://deplo.example.com/uninstall-agent.sh | sudo bash

# Do it
curl -fsSL https://deplo.example.com/uninstall-agent.sh | sudo bash -s -- --yes

# Do it, and delete the data too
curl -fsSL https://deplo.example.com/uninstall-agent.sh | sudo bash -s -- --yes --purge-data
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

## Decommission a machine properly

1. Move the apps to another server, or delete them.
2. Move or re-point any backup destination that lives on it.
3. Take a final backup if anything there is not backed up elsewhere.
4. Remove the server in Deplo.
5. Run the uninstall command on the host, with `--purge-data` if the machine is
   being handed on.
6. Delete the machine at your provider.

## Limits and gotchas

- **Removing a server does not stop its containers.** They keep running,
  unmanaged, until somebody stops them. That is why the uninstall step exists.
- **Apps still assigned to a removed server cannot deploy.** Move them first.
- **Reinstalling an agent re-bootstraps from scratch.** The installer deletes
  the existing certificate files, so it genuinely re-enrolls against the new
  pin rather than half-trusting the old one.
- **A migration source is removed with `Remove from Deplo`**, and Deplo uninstalls
  its own agent from that machine as part of it.

## If it does not work

- **The uninstall script does nothing** - it is a dry run. Add `--yes`.
- **Containers survive the uninstall** - they were not labelled as Deplo-managed,
  which means something else created them. That is deliberate.
- **The server reappears** - the agent is still installed and calling home.
  Uninstall it on the host.

## See also

- [Server settings](../guides/server-settings.md)
- [Server roles](../advanced/server-roles.md)
- [Disaster recovery](disaster-recovery.md)
- [`docs/adr/0011`](../adr/0011-server-removal-is-trust-revocation-not-a-host-uninstall.md)
