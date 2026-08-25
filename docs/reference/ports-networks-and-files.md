# Ports, networks and files

Everything Deplo listens on, connects over and writes to disk.

## Ports

| Port   | Who                                 | Published on the host            | Must be reachable from                             |
| ------ | ----------------------------------- | -------------------------------- | -------------------------------------------------- |
| `3000` | The control plane                   | **always**, domain or not        | you, and every server during enrollment            |
| `80`   | Traefik, entry point `web`          | yes, on every server that routes | the internet, including for certificate challenges |
| `443`  | Traefik, entry point `websecure`    | yes, on every server that routes | the internet                                       |
| `9443` | `deplo-agent`, gRPC over mutual TLS | yes, on every server             | **the control plane**                              |
| `5432` | Postgres                            | **no**, deliberately             | nothing. It is on an internal network              |
| `2375` | The Docker socket proxy             | **no**                           | nothing. Traefik only, on an internal network      |

Two things people get wrong here:

- **Port 3000 stays open on purpose.** It is the way back in when a domain, a
  certificate or the proxy is what broke. Closing it later means recreating the
  container by hand.
- **A green server card does not prove port 9443 is open.** The agent calls home
  outbound over 443, and that is what turns it green. If 9443 is firewalled
  inbound, the server looks online and every deploy fails. **No installer opens
  a firewall.**

## Networks

| Network          | Internal | Who is on it                                                                                   |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `deplo`          | no       | Every deployed app and database, plus Traefik. This is how containers reach each other by name |
| `deplo-internal` | **yes**  | The control plane and its Postgres, and nothing else                                           |
| `deplo-socket`   | **yes**  | Traefik and its read-only Docker socket proxy                                                  |

The split is not decoration. Every container on the shared network registers its
service name as a DNS alias, and Docker round-robins a name two containers both
claim. A tenant service called `postgres` on the shared network would collect
the control plane's own database connections, password included, which is why
Postgres sits on its own internal leg and why four service names are refused
outright on the shared one.

### Docker address pools

Deplo uses one network per app, and Docker's default pools allow about **31**.
Both installers therefore write a `/13` into `default-address-pools` in
`/etc/docker/daemon.json`, with `size: 24`.

- An existing pool configuration is **never clobbered**.
- The previous file is kept as `daemon.json.deplo-bak`.
- The new one is validated with `dockerd --validate` before it is used.
- If containers are already running, the **Docker restart is skipped** and the
  installer tells you to do it in a maintenance window.

## Files on the panel's host

```
/opt/deplo/.env                     generated secrets, chmod 600
/opt/deplo/docker-compose.yml       Postgres + the control plane
/opt/deplo/traefik/                 the proxy stack
/opt/deplo/data/                    build and upload staging
/opt/deplo/acme/acme.json           issued certificates, chmod 600
```

## Files on every server

```
/usr/local/bin/deplo-agent          the agent binary
/var/lib/deplo-agent/               chmod 700
  agent.crt, agent.key, ca.crt      its mutual TLS identity
  bootstrap.env                     first-run enrollment, chmod 600
  traefik/                          that host's proxy stack
/etc/systemd/system/deplo-agent.service
/data/backups/                      the agent's managed backup store, chmod 700
/etc/docker/daemon.json             plus daemon.json.deplo-bak
```

On the machine that runs the control plane, `/var/lib/deplo-agent/traefik` is a
**symlink** to `/opt/deplo/traefik`, so the agent manages the panel's own proxy
rather than installing a second one.

> `/var/lib/deplo-agent` holds Traefik's `acme.json`. Deleting it takes your
> issued certificates with it, and Let's Encrypt rate-limits reissuance.

## Container names worth knowing

| Name                    | What it is                                  |
| ----------------------- | ------------------------------------------- |
| `deplo-traefik`         | The proxy. Deplo identifies it by this name |
| `deplo-<slug>`          | An app's stack                              |
| `deplo-<slug>__<env>`   | An app's stack in a non-default environment |
| `deplo-<slug>__pr-<n>`  | A pull request preview                      |
| `db-<name>`             | A managed database                          |
| `deplo-<slug>-<volume>` | An app's named volume                       |

## See also

- [Environment variables reference](environment-variables.md)
- [Installers reference](installers.md)
- [Add a server](../guides/add-a-server.md)
- [How Deplo works](../concepts/how-deplo-works.md)
