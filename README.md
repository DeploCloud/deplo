<div align="center">

<img src="https://em-content.zobj.net/source/twitter/376/rocket_1f680.png" width="110" alt="Deplo" />

# Deplo

**push a repo, pick a server, get a deployment — on your own infrastructure**

[![Release](https://img.shields.io/github/v/release/IdraDev/deplo?color=0a0a0a)](https://github.com/IdraDev/deplo/releases)
[![Stars](https://img.shields.io/github/stars/IdraDev/deplo?style=flat)](https://github.com/IdraDev/deplo/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/IdraDev/deplo)](https://github.com/IdraDev/deplo/commits)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#-license)

[Features](#-features) · [Quick start](#-quick-start) · [Configuration](#%EF%B8%8F-configuration) · [Security](#-security) · [Stack](#-tech-stack)

</div>

---

## 💡 Why

I wanted the **developer experience of Vercel** with the **feature set of Coolify / Dokploy / Easypanel** — but running entirely on **my own infrastructure**, with **zero vendor lock-in**. No per-seat pricing, no build minutes, no black box. Just a VPS, a Docker socket and a domain.

Deplo is that: a self-hostable control plane. Push a repository or pick a template, and Deplo builds it in Docker and exposes it through Traefik with automatic HTTPS — on your master host or any remote server you connect.

## ✨ Features

| | Feature | What you get |
| :-: | --- | --- |
| 🚀 | **Deploys** | Git, any Git URL, a registry image, a Dockerfile, or an upload — with automatic framework detection and editable build commands. |
| 🧩 | **Templates** | One-click deploys for a large catalog (WordPress, Ghost, Plausible, n8n, Supabase, MinIO, Uptime Kuma, Postgres, Redis…). |
| 🖥️ | **Multi-server** | A master host plus remote servers connected over SSH. Every deploy targets a server you pick. |
| 📊 | **Live monitoring** | Real-time CPU, memory, disk and network per server (master + remotes) with rolling charts. |
| 🔔 | **Alerts** | Anomaly notifications via browser push, email, Discord webhook and a generic webhook. |
| 🔑 | **Variables** | Per-project env vars plus **shared groups** reused across projects from one source of truth. |
| 🗄️ | **Storage** | Managed databases (Postgres, MySQL, MariaDB, MongoDB, Redis, ClickHouse), S3 destinations and scheduled backups. |
| 🌐 | **Domains** | Custom domains with automatic TLS via Let's Encrypt. |
| 📦 | **Registries** | Connect GHCR / Docker Hub / GitLab / generic registries for private images. |
| 🔄 | **Self-update aware** | Checks this repo for newer releases and notifies you in-app. |

## 🚀 Quick start

### Install on a server

Run one command on a fresh Linux box — it installs Docker, Traefik (automatic HTTPS), a private Postgres and the Deplo control plane:

```bash
curl -fsSL https://raw.githubusercontent.com/IdraDev/deplo/main/install.sh | bash
```

The installer is idempotent: secrets are generated once and stored in `/opt/deplo/.env`, so re-running never rotates them. Override defaults with env vars:

```bash
curl -fsSL https://raw.githubusercontent.com/IdraDev/deplo/main/install.sh | \
  DEPLO_DOMAIN=deplo.example.com ACME_EMAIL=you@example.com bash
```

> [!TIP]
> Point your domain at the server's IP, then open the dashboard and finish setup in the browser.

### Run the prebuilt image

Each tagged release publishes a multi-arch image to GitHub Container Registry:

```bash
docker run -d --name deplo \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v deplo-data:/data \
  ghcr.io/idradev/deplo:latest
```

### Run locally

```bash
bun install
export DEPLO_DATABASE_URL=postgres://deplo:password@localhost:5432/deplo
bun run db:push      # create the Better Auth and state tables
bun run dev          # http://localhost:3000
```

PostgreSQL is the only control-plane data store, so `DEPLO_DATABASE_URL` (or `DATABASE_URL`) is required — the app fails fast at startup without it. On first run the database is seeded with a demo team, servers and projects.

| | Development login |
| --- | --- |
| **Email** | `admin@deluxhost.net` |
| **Password** | `deplo-admin-2026` *(development convenience only)* |

> [!IMPORTANT]
> A real install starts **empty** — no demo data. The first visit opens a **setup wizard** that creates your workspace and admin account; the demo login above is development-only (`DEPLO_SEED_DEMO=true|false` overrides seeding). Set `DEPLO_SECRET` in production to derive all encryption and signing keys.

## 🧱 How it works

```
                +--------------------------------------------+
   Browser ---> |  Deplo control plane (this Next.js app)    |
                |  UI + API + auth + Postgres data store     |
                +-----------------------+--------------------+
                                        | talks to the Docker socket
                                        v
        +---------------------------------------------------+
        |  Your Linux server (master or a remote)           |
        |    +---------+   routes + TLS   +--------------+   |
        |    | Traefik | <==============> | app          |   |
        |    |  :80    |                  | db           |   |
        |    |  :443   |   Let's Encrypt  | services     |   |
        |    +---------+                  +--------------+   |
        |        all on the shared `deplo` docker network   |
        +---------------------------------------------------+
```

1. **Docker** — every app, database and service is a container; Deplo generates a `docker-compose.yml` per workload (`lib/deploy/compose.ts`).
2. **Traefik** — one reverse proxy routes each domain to the right container and issues TLS via Let's Encrypt (`lib/deploy/traefik.ts`).
3. **Postgres** — the one system of record for all control-plane data and Better Auth. `DEPLO_DATABASE_URL` is required; there is no file-based fallback.

## ⚙️ Configuration

`DEPLO_DATABASE_URL` is **required** — Deplo stores all control-plane data in PostgreSQL and enables Better Auth at `/api/auth/*`. Set it (and `DEPLO_SECRET`) before running:

```bash
export DEPLO_DATABASE_URL=postgres://deplo:password@localhost:5432/deplo
export DEPLO_SECRET=$(openssl rand -base64 48)
bun run db:push      # create the Better Auth and state tables
bun run dev
```

Copy `.env.example` to `.env` and fill in the important variables:

| Variable | Purpose |
| --- | --- |
| `DEPLO_SECRET` | **Required in production.** Root secret deriving all session-signing and AES-256-GCM encryption keys; reused as the Better Auth secret. |
| `DEPLO_PUBLIC_URL` | Public URL the dashboard is served from (cookies, TLS detection, install command). |
| `DEPLO_DATABASE_URL` | **Required.** Postgres connection string. Deplo's only control-plane data store; also backs Better Auth. |
| `DEPLO_DATABASE_POOL_MAX` | Optional cap on the Postgres connection pool (default 10). |
| `DEPLO_DATA_DIR` | Host-visible directory for build/upload staging the Docker daemon must see (default `/data`, `./.deplo` in dev). Not a data store. |
| `DEPLO_ACME_EMAIL` | Email used for Let's Encrypt in the generated installer. |

## 🔄 Releases & CI

Pushing a `v*.*` tag triggers [`.github/workflows/docker-image.yml`](.github/workflows/docker-image.yml): it creates a GitHub Release and builds + pushes the image to `ghcr.io/idradev/deplo:<version>` and `:latest`.

```bash
git tag v1.2.0 && git push origin v1.2.0
```

## 🔐 Security

- **Stateless sessions** — HMAC-signed cookies (`HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, 7-day expiry). Better Auth manages credentials when Postgres is configured.
- **Secrets at rest** — env vars, DB connection strings, S3 keys and registry credentials are AES-256-GCM encrypted and only ever returned to the client masked.
- **Passwords** — hashed with scrypt using constant-time comparisons.
- **Hardened headers** — per-request CSP nonce plus HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` and `Permissions-Policy` (`proxy.ts`).
- **Defense in depth** — every server action validates input with Zod and re-checks auth in the data layer (`assertUser`); page-level auth is never trusted alone. Rate limiting protects the auth endpoints.

## 🛠️ Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui · Lucide · Docker · Traefik · Postgres · Drizzle · Better Auth · Bun

## 🗂️ Project layout

```
app/(auth)        login and signup
app/(dashboard)   the product (overview, projects, variables, monitoring…)
app/api/auth      Better Auth endpoints (active when Postgres is configured)
app/install       alias that redirects to install.sh on GitHub
install.sh        the installer (single source of truth, served from GitHub)
components/ui     shadcn primitives
components/*      feature components
lib/data          data access layer (server only, auth checked)
lib/actions       server actions (Zod validated)
lib/db            Postgres pool, Drizzle schema and document store
lib/deploy        docker-compose and Traefik generation
lib/frameworks.ts framework detection engine
lib/templates.ts  one-click template catalog
lib/crypto.ts     hashing, encryption and session signing
proxy.ts          CSP, security headers and the optimistic auth gate
```

## 📄 License

MIT © [IdraDev](https://github.com/IdraDev)

<div align="center"><sub>Built for people who'd rather own their deploys.</sub></div>
