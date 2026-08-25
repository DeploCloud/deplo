# Install Deplo

## What it is

One command on a fresh Linux server. It installs Docker if it is missing,
Traefik with automatic HTTPS, a private Postgres, the Deplo control plane, and
the server agent on that same machine, so you have somewhere to deploy the
moment it finishes.

## How it works

The installer is a shell script served from the repository. It is
**idempotent**: secrets are generated once into `/opt/deplo/.env`, so running it
again updates the containers in place and never rotates anything. If that file
already exists, the script switches itself to update mode.

Everything it writes lands in `/opt/deplo`:

```
/opt/deplo/.env                     the generated secrets, chmod 600
/opt/deplo/docker-compose.yml       Postgres + the control plane
/opt/deplo/traefik/                 the reverse proxy stack
/opt/deplo/data/                    build and upload staging
/opt/deplo/acme/acme.json           Let's Encrypt certificates, chmod 600
```

Three containers come up: `postgres:16-alpine` on an `internal` network that is
**not published to the host**, `ghcr.io/deplocloud/deplo` publishing port
`3000`, and `traefik:v3.7` holding `80` and `443`. Traefik does not get the
Docker socket: it reads container events through a `docker-socket-proxy`
sidecar on its own internal network, restricted to reads.

The control plane never gets a Docker socket either, and you should never give
it one. It is the container reachable from the internet, and that mount is root
on the box for whoever reaches it.

## Install it

Run this as root on the server:

```bash
curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | bash
```

The dashboard then answers on `http://<server-ip>:3000`.

To serve the dashboard on your own domain over HTTPS, point an A record at the
server first, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | \
  DEPLO_DOMAIN=deplo.example.com ACME_EMAIL=you@example.com bash
```

> **Port 3000 stays published either way, and that is deliberate.**
> `http://<server-ip>:3000` is the way back in when a domain, a certificate or
> the proxy itself is what broke. Closing it later means recreating the
> container by hand.

## Create your account

Open the dashboard. A fresh install starts completely empty, and the first
visit opens the setup screen, **Welcome to Deplo**. It runs once.

1. **Workspace name** - the name of your first team, for example `Acme`.
2. **Username** - your handle. Lowercase letters, numbers, `-` and `_`.
3. **Display name** - how you appear to teammates.
4. **Admin email**.
5. A password. It is checked for length and character mix, and against the Have
   I Been Pwned breach list, so a password that has leaked anywhere is refused.
6. Click **Create workspace**.

That account is the **instance owner**: the tier above instance admin, and the
only one that can hand the instance to somebody else later.

## What the installer changes on the host

| Change                                                        | Why                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installs Docker if absent                                     | Via `get.docker.com`, then enables the service                                                                                                                                                                                                                                                    |
| Rewrites `default-address-pools` in `/etc/docker/daemon.json` | Docker's defaults allow about 31 networks and Deplo uses one per app, so an untouched host fails on its 32nd deploy. An existing pool configuration is never clobbered, the old file is kept as `daemon.json.deplo-bak`, and the new one is validated with `dockerd --validate` before it is used |
| Creates the `deplo` Docker network                            | Every app joins it, which is how apps reach each other by name                                                                                                                                                                                                                                    |
| Enrolls this machine as a server                              | It waits for `/api/health`, then runs the agent installer against `http://<ip>:3000`                                                                                                                                                                                                              |

If containers are already running when the address pools change, the installer
**skips the Docker restart** and tells you to do it in a maintenance window.
Nothing is broken until then, but the new pool does not apply.

## Update it later

Re-run the same command. It pulls the newer image and restarts the stack, and
your secrets stay exactly as they were. Pin a version with
`DEPLO_VERSION=0.4.1` in front of the command, or leave it to take `latest`.

The dashboard also checks for releases on its own and shows an update banner.
See [Upgrade](../operations/upgrade.md) for the full procedure, including the
server agents, which version on their own clock.

## Run it with Compose instead

[`docker-compose.yml`](../../docker-compose.yml) in the repository runs the
control plane and its Postgres behind Traefik. It is a readable, hand-editable
starting point, not a copy of what the installer writes: the installer routes
the panel through Traefik's **file provider** rather than container labels,
precisely so the panel's own route can be changed from the panel later.

```bash
docker network create deplo
export DEPLO_DOMAIN=deplo.example.com
export DEPLO_SECRET=$(openssl rand -base64 48)
export DEPLO_DB_PASSWORD=$(openssl rand -base64 24)
docker compose up -d
```

Going this way, you enroll the host as a server yourself from
**Settings -> Servers**, exactly like any other machine.

## Limits and gotchas

- **`DEPLO_SECRET` is not rotatable.** It derives every encryption key, every
  session signature and the agent certificate authority. Change it and every
  stored secret becomes unreadable, every session ends and every agent
  certificate is re-minted. Back it up with the rest of `/opt/deplo/.env`.
- **The domain must resolve before the certificate can issue.** Let's Encrypt
  validates over HTTP on port 80. Point the A record first, install second, or
  re-run the installer once DNS is live.
- **The agent enrollment step is not fatal.** If it fails, the dashboard still
  comes up and the script says so. Re-running the installer retries it.
- **`localhost` and `*.local` are refused as `DEPLO_DOMAIN`.** The panel needs a
  hostname a certificate can be issued for.

## If it does not work

- **`docker compose` not found** - the script requires Compose v2. Install
  Docker's own packages rather than a distribution's `docker.io`.
- **The dashboard does not answer on :3000** - check `docker ps` shows the
  `deplo` container, then read `docker logs deplo`. A failure to reach Postgres
  is the usual cause.
- **The domain shows a certificate warning** - the A record is not resolving to
  this server yet, or port 80 is closed. See
  [Domains and TLS](../troubleshooting/domains-and-tls.md).
- Anything else: [Servers and agents](../troubleshooting/servers-and-agents.md).

## See also

- [Deploy your first app](first-app.md)
- [Environment variables reference](../reference/environment-variables.md) - every variable the installer and the container read
- [Ports, networks and files](../reference/ports-networks-and-files.md)
- [Installers reference](../reference/installers.md) - every flag of all three scripts
