# Installers reference

The three shell scripts, what each one does, and every flag.

## `install.sh` - the platform

```bash
curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | bash
```

Configured entirely by environment variables in front of the command. See
[Environment variables](environment-variables.md#the-installer) for the table.

**Requires**: root, `curl`, `openssl`, and Docker Compose v2. Docker itself is
installed if missing.

**What it does, in order**

1. Preflight checks.
2. Installs Docker if absent, and enables the service.
3. Writes Docker's `default-address-pools`, never clobbering an existing one,
   backing up the old file and validating the new one.
4. Creates `/opt/deplo/{traefik,data,acme}`, the `deplo` network, and
   `acme.json` at `0600`.
5. Generates secrets into `/opt/deplo/.env` at `0600`, **once**.
6. Writes and starts the Traefik stack, with a read-only socket proxy sidecar.
7. Symlinks `/var/lib/deplo-agent/traefik` to it, so the local agent manages the
   panel's own proxy.
8. Writes and starts the Deplo stack: Postgres on an internal network, and the
   control plane publishing `3000`.
9. Waits up to two minutes for `/api/health`, then enrolls this machine as a
   server.

**Re-running it is the update path.** It detects `/opt/deplo/.env`, switches to
update mode, and never rotates a secret. Step 9 failing is a warning, not a
fatal error: the panel stays up and a re-run retries it.

## `install-agent.sh` - a server

```bash
curl -fsSL https://<deplo>/install-agent.sh | sudo bash -s -- <TOKEN> <URL> [FINGERPRINT]
```

**Always take this command from the dashboard.** The copy in the repository has
placeholders that the running instance substitutes with the release's per-
architecture URL and its checksum, and it refuses to run unsubstituted.

| Positional | Meaning                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `$1`       | The one-time bootstrap token. Single-use, hashed at rest, about an hour                                                              |
| `$2`       | The control plane's URL, `http(s)://host[:port]`                                                                                     |
| `$3`       | Optional certificate fingerprint, pinning the control plane over HTTPS. Over plain HTTP the token authenticates the response instead |

| Variable               | Effect                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DEPLO_AGENT_PORT`     | Listen port, default `9443`                                                                                   |
| `DEPLO_STORAGE_ONLY=1` | Backups only: no Docker, no Traefik, no shared network, and the unit is installed without the docker group    |
| `DEPLO_BUILD_ONLY=1`   | Build only: Docker and address pools, no Traefik                                                              |
| `DEPLO_IMPORT_ONLY=1`  | Migration source: Docker must already exist, address pools untouched, no Traefik, no network, no backup store |

**What it does**

1. Refuses to run if the placeholders were not substituted.
2. Installs Docker if absent, and applies the address pools.
3. Picks the binary by architecture, `linux/amd64` or `linux/arm64` only.
4. **Verifies the SHA-256 and refuses to run an unverified binary.**
5. Installs to `/usr/local/bin/deplo-agent` and creates
   `/var/lib/deplo-agent` at `0700`, **deleting any existing certificate files**
   so a reinstall genuinely re-enrolls.
6. Creates the `deplo` network and installs Traefik, unless one is running or
   80 and 443 are taken.
7. Writes `bootstrap.env` at `0600`, never on the command line.
8. Writes the systemd unit at `0600` and starts it.

The agent then calls home, sends a certificate signing request, and receives a
signed certificate. **The control plane never connects to your machine to set
this up.**

Logs: `journalctl -u deplo-agent -f`.

## `uninstall.sh` - remove Deplo

```bash
curl -fsSL https://<deplo>/uninstall.sh | sudo bash                  # dry run
curl -fsSL https://<deplo>/uninstall.sh | sudo bash -s -- --yes
curl -fsSL https://<deplo>/uninstall.sh | sudo bash -s -- --yes --agent-only
curl -fsSL https://<deplo>/uninstall.sh | sudo bash -s -- --yes --purge-data
```

| Flag              | Effect                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| none              | **Dry run.** Prints every command it would run, changes nothing                                                                |
| `--yes`           | Actually do it                                                                                                                 |
| `--agent-only`    | Leave the control plane in `/opt/deplo` alone. This is the flag in the command the dashboard prints for a server               |
| `--purge-data`    | Also delete Deplo volumes, images Deplo built, the stacks directory and `/opt/deplo` itself, `.env` included. **Irreversible** |
| `--purge-backups` | Also delete `/data/backups`. Separate from `--purge-data` because everything else can be rebuilt from these. **Irreversible**  |

One script, three jobs. By default it removes the control plane in `/opt/deplo`
(the panel, its Postgres, its Traefik), the agent, Deplo's named containers,
every container labelled as Deplo-managed, the `deplo` network and
`/var/lib/deplo-agent`. `--agent-only` stops at the agent. It never touches
Docker Engine, never rewrites `/etc/docker/daemon.json` (the installer's backup
stays as `daemon.json.deplo-bak`), and never touches a container it did not
label. Safe on a machine that was never a Deplo host, and safe to run twice.

> **`--purge-data` deletes `/opt/deplo/.env`, and that holds `DEPLO_SECRET`.**
> Every backup artifact this instance wrote is encrypted with a key derived from
> it. Copy the file first if you may ever want to restore one.

The older `/uninstall-agent.sh` URL still works and always will: it serves this
same script with `--agent-only` already applied, so a command copied into a
runbook before `uninstall.sh` existed still means what it meant then.

## Verifying before you pipe to a shell

Every one of these is a `curl | bash`. If that makes you uneasy, and it
reasonably might, download and read first:

```bash
curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

The agent installer is worth reading for a different reason: it is where the
checksum verification lives, and seeing it refuse an unverified binary is more
convincing than being told it does.

## See also

- [Install Deplo](../getting-started/install.md)
- [Add a server](../guides/add-a-server.md)
- [Server roles](../advanced/server-roles.md)
- [Remove a server or uninstall](../operations/remove-a-server-or-uninstall.md)
