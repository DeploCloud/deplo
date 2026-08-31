<div align="center">

<img src="https://em-content.zobj.net/source/twitter/376/rocket_1f680.png" width="110" alt="Deplo" />

# Deplo

**push a repo, pick a server, get a deployment - on your own infrastructure**

[![Release](https://img.shields.io/github/v/release/DeploCloud/deplo?color=0a0a0a)](https://github.com/DeploCloud/deplo/releases)
[![Stars](https://img.shields.io/github/stars/DeploCloud/deplo?style=flat)](https://github.com/DeploCloud/deplo/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/DeploCloud/deplo)](https://github.com/DeploCloud/deplo/commits)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

[Features](#-features) · [Quick start](#-quick-start) · [Documentation](https://deplo.build/docs) · [How it works](#-how-it-works) · [Configuration](#%EF%B8%8F-configuration) · [Security](#-security) · [Contributing](CONTRIBUTING.md)

</div>

---

## 💡 Why

**You should not have to learn Docker or SSH to deploy your own app.**

That is the whole point. The big clouds figured out the experience years ago: push, and it
is live, with someone else doing the operations. Self-hosting has never matched it. Every
platform you can run yourself still assumes you live in a shell, and hands you a compose
file the moment anything gets interesting.

Deplo is that experience on hardware you own and a bill you control. A VPS and a domain,
and the platform does the operator's job: builds, routing, TLS, databases, backups,
monitoring, rollbacks. No per-seat pricing, no build minutes, no black box, no vendor
lock-in. **The shell stays available for experts and is never required to get full value.**

## ✨ Features

|     | Feature                   | What you get                                                                                                                                                                                            |
| :-: | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🚀  | **Deploys**               | Git (GitHub, GitLab, Bitbucket, Gitea or any Git URL), a registry image, a Dockerfile, a Compose file, or a plain upload. Framework detection picks the build for you and every command stays editable. |
| 🧩  | **Templates**             | One-click deploys from a live catalog (WordPress, Ghost, Plausible, n8n, Supabase, MinIO, Uptime Kuma, Postgres, Redis and many more), each with its own variants.                                      |
| 👥  | **Teams**                 | Several people, one instance, least privilege. **44 fine-grained Capabilities**, per-team editable Roles, per-folder grants, an Activity trail that answers "who did this and when" in the UI.          |
| 🖥️  | **Any number of servers** | One host or a fleet. Each one runs the server agent and every deploy targets a server you pick. Adding a host is one command, printed for you in the dashboard.                                         |
| 🔀  | **Preview deployments**   | Every pull request gets its own URL and tears itself down on merge. A preview of a fork never receives your secrets.                                                                                    |
| ⏪  | **Rollbacks**             | Re-run any past build's exact image. No rebuild, no waiting, no hoping the dependency tree resolves the same way twice.                                                                                 |
| 🗄️  | **Storage**               | Managed databases (Postgres, MySQL, MariaDB, MongoDB, Redis, ClickHouse), volumes, and file mounts edited in the browser.                                                                               |
| 💾  | **Backups**               | Scheduled, encrypted at rest with age, to any S3 bucket **or to another server's disk** - so disaster recovery uses hardware you already have instead of a cloud account you do not want.               |
| ⏰  | **Cron**                  | Scheduled jobs that run in the agent, so restarting the panel never kills a run.                                                                                                                        |
| 📊  | **Live monitoring**       | Streaming CPU, memory, disk and network per server and per app, with history and anomaly alerts over browser push, email, Discord or a webhook.                                                         |
| 🌐  | **Domains**               | Custom domains with automatic Let's Encrypt TLS, path-based routing, basic auth, and a working URL out of the box before you own a domain at all.                                                       |
| 🔑  | **Variables**             | Per-app, per-environment and shared groups, encrypted at rest, available at build time and run time.                                                                                                    |
| 🔐  | **Account security**      | Passwords checked against known breaches, passkeys, TOTP two-factor that a team or a role can **require**, scoped API tokens that expire.                                                               |
| 🤖  | **MCP server**            | Point an AI agent at your infrastructure through the same authorization gates a human gets. Off by default for a new team.                                                                              |

## 🚀 Quick start

### Install on a server

One command on a fresh Linux box. It installs Docker, Traefik with automatic HTTPS, a
private Postgres, the Deplo control plane, and the server agent on that same host, so you
have somewhere to deploy the moment it finishes:

```bash
curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | bash
```

The dashboard always answers on `http://<server-ip>:3000`. That address is the way back in
when a domain, a certificate or the proxy is what broke. Pass a domain to route it through
Traefik with HTTPS as well:

```bash
curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | \
  DEPLO_DOMAIN=deplo.example.com ACME_EMAIL=you@example.com bash
```

The installer is idempotent: secrets are generated once into `/opt/deplo/.env`, so
re-running updates in place and never rotates them.

> [!TIP]
> You do not need a domain to start. Every deployment gets a working
> `<app>-<two-words>-<hex-ip>.nip.io` URL, over plain HTTP, until you point one
> at it. A shared wildcard domain cannot hold a certificate, so HTTPS is one A
> record away, not zero.

### Run it with Compose

[`docker-compose.yml`](docker-compose.yml) in this repository runs the control plane and
its Postgres behind Traefik. It is a readable starting point, not a copy of what the
installer writes: `install.sh` routes the panel through Traefik's **file provider** rather
than container labels, precisely so the panel's own route stays changeable from the panel.

```bash
docker network create deplo
export DEPLO_DOMAIN=deplo.example.com
export DEPLO_SECRET=$(openssl rand -base64 48)
export DEPLO_DB_PASSWORD=$(openssl rand -base64 24)
docker compose up -d
```

> [!IMPORTANT]
> **The control plane never mounts the Docker socket, and you should never give it one.**
> It is the container here reachable from the internet, and that mount is root on the box
> for whoever reaches it. Everything host-coupled goes over mTLS to the server agent.

### Uninstall

One command, and it is a **dry run** until you add `--yes`: it prints every command it
would run and changes nothing.

```bash
curl -fsSL https://<your-deplo>/uninstall.sh | sudo bash            # see what would happen
curl -fsSL https://<your-deplo>/uninstall.sh | sudo bash -s -- --yes
```

That takes the control plane, the agent, Traefik and every container deplo deployed off
the machine, and leaves your data alone: volumes, built images and `/opt/deplo` survive
unless you add `--purge-data`, and backups need `--purge-backups` on top of that. Docker
Engine is never touched. Use `--agent-only` on a server you are taking out of the fleet -
that is the command the dashboard prints for you.

See [Remove a server or uninstall](https://deplo.build/docs/operations/remove-a-server-or-uninstall).

### Run it locally

```bash
bun install
export DEPLO_DATABASE_URL=postgres://deplo:password@localhost:5432/deplo
export DEPLO_SECRET=$(openssl rand -base64 48)
bun run db:push     # create the tables
bun run dev         # http://localhost:3000
```

Postgres is the only control-plane data store, so `DEPLO_DATABASE_URL` is required and the
app fails fast at startup without it. A real install starts **empty**: the first visit
opens a setup wizard that creates your team and admin account.

## 🧱 How it works

Two planes, and one boundary that is never crossed.

```
                   +--------------------------------------------------+
   Browser  <--->  |  Deplo control plane  (this repository)          |
                   |  UI · GraphQL API · auth · Postgres · rendering  |
                   +----------------------+---------------------------+
                                          |
                                gRPC over mTLS, cert pinned
                                          |
              +---------------------------+---------------------------+
              |                           |                           |
     +--------v--------+         +--------v--------+         +--------v--------+
     |  deplo-agent    |         |  deplo-agent    |         |  deplo-agent    |
     |  your server 1  |         |  your server 2  |         |  a friend's box |
     |  +-----------+  |         |                 |         |                 |
     |  | Traefik   |  |         |   containers    |         |   containers    |
     |  | :80 :443  |  |         |   volumes       |         |   volumes       |
     |  +-----------+  |         |   builds        |         |   builds        |
     |   containers    |         |                 |         |                 |
     +-----------------+         +-----------------+         +-----------------+
```

1. **The control plane decides.** It renders the Compose YAML, the Traefik routing labels
   and the ports, resolves and decrypts the environment, and hands the result over. It
   never runs `docker`, never opens a shell, never touches a host.
2. **[The server agent](https://github.com/DeploCloud/deplo-agent) executes.** One Go
   binary per host, the only thing that runs Docker anywhere. Reached over gRPC with
   mutual TLS, the certificate fingerprint pinned at enrollment.
3. **Traefik routes.** One reverse proxy per host maps every domain to the right container
   and issues certificates through Let's Encrypt.
4. **Postgres remembers.** The single system of record for the control plane. No file
   store, no fallback.

The machine Deplo itself runs on is just another server in the fleet, agent and all. There
is no privileged local shortcut, which means the path you use every day is the same one a
remote host uses, and it is tested by everything.

**The manual is [deplo.build/docs](https://deplo.build/docs)**: install it, ship your first
app, then one page per feature, plus reference tables and troubleshooting by symptom. It is
written in the [DeploCloud/docs](https://github.com/DeploCloud/docs) repository, not this one.

Decisions behind this live in [`docs/adr/`](docs/adr/), the vocabulary in
[`CONTEXT.md`](CONTEXT.md), and the architecture rules in [`AGENTS.md`](AGENTS.md).

## ⚙️ Configuration

Copy [`.env.example`](.env.example) to `.env`. Only two are required:

| Variable                     | Purpose                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLO_DATABASE_URL`         | **Required.** Postgres connection string. The only control-plane data store; also backs Better Auth. The app fails fast without it.                         |
| `DEPLO_SECRET`               | **Required in production.** Root secret, at least 16 characters, deriving every session-signing and AES-256-GCM encryption key. Rotating it is destructive. |
| `DEPLO_PUBLIC_URL`           | Public URL the dashboard is served from. Sets the cookie `secure` flag and the install command it prints.                                                   |
| `DEPLO_SERVER_IP`            | Public IPv4 of this server, used for the zero-config `sslip.io` hostnames. Detected automatically; set it by hand for a manual run.                         |
| `DEPLO_HOST_BOOTSTRAP_TOKEN` | One-time token that enrolls the machine Deplo runs on as a server. `install.sh` generates it. Unset means "do not enroll", which is what a dev run wants.   |
| `DEPLO_HOST_NAME`            | Name shown on that server's card. Deplo runs in a container and cannot read the host's own hostname.                                                        |
| `DEPLO_TEMPLATES_API_URL`    | Template catalog. Defaults to the public one; set it to mirror the catalog yourself.                                                                        |
| `DEPLO_ACME_EMAIL`           | Email used for Let's Encrypt in the generated installer.                                                                                                    |
| `DEPLO_CERT_RESOLVER`        | Name of the Traefik ACME resolver baked into every router. Defaults to `letsencrypt`.                                                                       |
| `DEPLO_DATABASE_POOL_MAX`    | Cap on the Postgres connection pool. Defaults to 10.                                                                                                        |
| `DEPLO_DATA_DIR`             | Host-visible directory for build and upload staging. Not a data store.                                                                                      |

The installer takes four more, passed in front of the command and written once into
`/opt/deplo/.env`:

| Variable            | Purpose                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DEPLO_DOMAIN`      | Domain the panel is served on. Unset means `http://<ip>:3000` only.                                           |
| `ACME_EMAIL`        | Let's Encrypt registration email for that host's Traefik. The container's own variable is `DEPLO_ACME_EMAIL`. |
| `DEPLO_DB_PASSWORD` | Postgres password. Generated if unset.                                                                        |
| `DEPLO_VERSION`     | Image tag to pull. Defaults to `latest`.                                                                      |

Full tables, including the agent installer, in
[the environment variable reference](https://deplo.build/docs/reference/environment-variables).

## 🔐 Security

- **The control plane cannot touch a host.** Deploys, builds, logs, consoles, metrics,
  files and backups all leave over gRPC with mutual TLS to the server agent, whose
  certificate is pinned at enrollment. There is no local shortcut to abuse.
- **Every mutating action is Capability-gated server-side**, inside the data layer, not in
  the UI. Interface checks only hide buttons. Cross-team ids resolve to nothing rather
  than to an error that confirms they exist.
- **Secrets are write-only.** Environment values, database URLs, S3 keys, registry and Git
  credentials are AES-256-GCM encrypted, never projected into an API response, and masked
  in any rendered stack shown back to you. The agent never holds the encryption key.
- **Authored Compose is treated as hostile.** Everything that reaches out of a container -
  bind mounts, `privileged`, capabilities, devices, host namespaces, foreign networks and
  volumes - is gated behind an explicit grant, and hardening is never gated.
- **Passwords** use scrypt with the cost stored per hash, and every password a person
  chooses is checked against Have I Been Pwned, k-anonymously and failing open so an
  instance with no outbound access still works.
- **Two-factor is a policy, not a setting.** A team or a role can require it, and a member
  who has not enrolled resolves nothing in that team, in the UI and over the API alike.
- **Hardened by default**: per-request CSP nonce, HSTS, `X-Frame-Options: DENY`, `nosniff`,
  a referrer policy, a Postgres-backed rate limiter that survives restarts, and API tokens
  that carry a scope and an expiry.

Found a hole? **[SECURITY.md](SECURITY.md)** - report it privately, never in an issue.

## 🤝 Contributing

Pull requests are welcome. **[CONTRIBUTING.md](CONTRIBUTING.md)** covers running it
locally, the three commands CI runs, and how contributions are licensed.

- Questions and ideas: [Discussions](https://github.com/DeploCloud/deplo/discussions)
- Bugs and feature requests: [Issues](https://github.com/DeploCloud/deplo/issues)
- Vulnerabilities: [privately](https://github.com/DeploCloud/deplo/security/advisories/new)

## 🛠️ Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui · Pothos
GraphQL · Drizzle · Postgres · Better Auth · Bun · Go (the agent) · Docker · Traefik

## 🗂️ Project layout

```
app/(auth)          login and first-run setup
app/(dashboard)     the product (overview, apps, storage, monitoring, members, activity)
app/api/graphql     the single API endpoint
app/api/*           the REST exceptions (uploads, log and console streams, webhooks, MCP)
lib/data            the data layer, and the authorization boundary
lib/graphql         Pothos builder, context and the domain types
lib/deploy          Compose, Traefik label and port rendering
lib/infra           the agent client (mTLS, one entry point)
lib/agent           mTLS PKI and the generated gRPC stubs
lib/db              Postgres pool, Drizzle schema and migrations
lib/mcp             the MCP server, one row per tool
components          UI, with shadcn primitives under components/ui
install.sh          the installer, served from this repository
docs/adr            numbered architecture decisions
docs/agents         maintainer runbooks (issues, releases, fleet rollout)
```

## 📄 License

**[AGPL-3.0-only](LICENSE)** © 2026 DeploCloud

Run it, modify it, redistribute it. If you offer a modified version to other people over a
network, publish your changes. Commercial licensing is available for anyone who needs
different terms.

**The core stays AGPL and keeps getting the main features.** The only proprietary parts will
be the ones that only make sense on DeploCloud's own infrastructure, and nothing that works
on a machine you own will move behind a paywall. Contributions arrive under a
[CLA](CLA.md), and what we promise in return is in
[CONTRIBUTING.md](CONTRIBUTING.md#what-we-will-not-do).

The **code** is AGPL. The **name "deplo" and the logo are not** - the license covers
copyright, not trademarks. Fork it freely and please rename your fork. Details in
[CONTRIBUTING.md](CONTRIBUTING.md#the-name-is-not-part-of-the-license).

<div align="center"><sub>Built for people who'd rather own their deploys.</sub></div>
