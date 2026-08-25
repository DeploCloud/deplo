# Environment variables reference

Every variable Deplo itself reads. These configure the **platform**. For the
variables your apps read, see
[Environment variables](../guides/environment-variables.md).

## The control plane

Read by the Deplo container. The canonical list is
[`.env.example`](../../.env.example).

| Variable                         | Required                      | Default                                       | What it does                                                                                                                                                                                              |
| -------------------------------- | ----------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLO_DATABASE_URL`             | **yes**                       | none                                          | Postgres connection string, and the only control-plane store. Also backs the auth tables. **The app fails at startup without it.** `DATABASE_URL` is accepted as a fallback                               |
| `DEPLO_SECRET`                   | **yes in production**         | none                                          | Root secret, at least 16 characters. Derives every session signature, every AES-256-GCM encryption key and the agent certificate authority. **Rotating it is destructive and there is no key versioning** |
| `DEPLO_PUBLIC_URL`               | effectively yes in production | none                                          | The public URL the dashboard is served from. Sets the cookie `secure` flag, the auth layer's https mode, and the install command printed for new servers                                                  |
| `DEPLO_SERVER_IP`                | no                            | first non-internal NIC IPv4, then `127.0.0.1` | The literal public IPv4 baked into generated `nip.io` hostnames and their Traefik rules. Must be a dotted quad, never a hostname                                                                          |
| `DEPLO_HOST_BOOTSTRAP_TOKEN`     | no                            | unset, meaning do not enroll                  | One-time token that lets the machine running Deplo enroll itself as a server. The installer generates it. A development run wants it unset                                                                |
| `DEPLO_HOST_NAME`                | no                            | falls back to `DEPLO_SERVER_IP`               | The name shown on that server's card. Deplo runs in a container and would otherwise read a random container id as its hostname                                                                            |
| `DEPLO_TEMPLATES_API_URL`        | no                            | the public catalogue                          | Where the template catalogue is fetched from. Point it at your own mirror to self-host it                                                                                                                 |
| `DEPLO_ACME_EMAIL`               | no                            | none                                          | The Let's Encrypt email baked into the agent installer this instance generates                                                                                                                            |
| `DEPLO_CERT_RESOLVER`            | no                            | `letsencrypt`                                 | The name of the Traefik ACME resolver put on every router. A `nip.io` host needs an **HTTP-01** resolver; point this at one if your default uses DNS-01                                                   |
| `DEPLO_CLOUDFLARE_CERT_RESOLVER` | no                            | `cloudflare`                                  | The resolver name used by domains whose certificate provider is Cloudflare, which validates over DNS-01                                                                                                   |
| `DEPLO_DATABASE_POOL_MAX`        | no                            | `10`                                          | Cap on the Postgres connection pool                                                                                                                                                                       |
| `DEPLO_DATA_DIR`                 | no                            | `/data` in the container, `./.deplo` locally  | Host-visible staging directory for builds and uploads. **Not a data store**                                                                                                                               |

## The installer

Written into `/opt/deplo/.env` and read by `docker compose --env-file`. Set them
in front of the install command.

| Variable            | Default                              | What it does                                                                                                                                                             |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEPLO_DOMAIN`      | empty, meaning IP mode               | The domain the panel is served on. Must contain a dot and cannot be `localhost` or a `.local` name. Set means HTTPS through Traefik; unset means `http://<ip>:3000` only |
| `ACME_EMAIL`        | `admin@example.com`                  | The Let's Encrypt registration email for that host's Traefik. Note the name: the container's own variable is `DEPLO_ACME_EMAIL`                                          |
| `DEPLO_DB_PASSWORD` | generated, `openssl rand -base64 24` | The Postgres password. Feeds both the database and the connection string                                                                                                 |
| `DEPLO_VERSION`     | `latest`                             | The image tag pulled: `ghcr.io/deplocloud/deplo:<version>`                                                                                                               |
| `DEPLO_SECRET`      | generated, `openssl rand -base64 48` | As above. Generated once and never rotated by a re-run                                                                                                                   |

## The agent installer

Set in front of `install-agent.sh`.

| Variable                                                                      | Default                  | What it does                                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DEPLO_AGENT_PORT`                                                            | `9443`                   | The gRPC and mutual TLS listen port                                                                                                  |
| `DEPLO_STORAGE_ONLY`                                                          | `0`                      | Backups-only role: no Docker, no Traefik, no shared network                                                                          |
| `DEPLO_BUILD_ONLY`                                                            | `0`                      | Build-only role: Docker and address pools, no Traefik, never a deploy target                                                         |
| `DEPLO_IMPORT_ONLY`                                                           | `0`                      | Migration source: Docker must already exist, nothing else is set up. Created by the migration wizard, not by hand                    |
| `DEPLO_BOOTSTRAP_URL`, `DEPLO_BOOTSTRAP_TOKEN`, `DEPLO_BOOTSTRAP_FINGERPRINT` | written by the installer | First-run enrollment, kept in a `0600` environment file rather than on the command line, where any user could read them from `/proc` |

## Notes worth reading before you change anything

- **`DEPLO_SECRET` is permanent.** There is no rotation and no key versioning.
  Back up `/opt/deplo/.env`. See [Disaster recovery](../operations/disaster-recovery.md).
- **`DEPLO_SERVER_IP` must be a real, internet-reachable IPv4.** Generated
  hostnames encode it in hexadecimal, so a private or loopback address produces
  URLs that only work from that machine.
- **A hostname in `DEPLO_PUBLIC_URL` cannot seed a `nip.io` name**, so Deplo
  falls through to interface detection for the IP. Set `DEPLO_SERVER_IP`
  explicitly on a multi-homed box.
- **`DEPLO_DATA_DIR` is staging, not storage.** Nothing durable lives there.
- **Build-time placeholders exist in the Dockerfile** for the database URL and
  the secret. They never reach the runtime image and are not usable values.

## See also

- [Install Deplo](../getting-started/install.md)
- [Installers reference](installers.md)
- [Ports, networks and files](ports-networks-and-files.md)
