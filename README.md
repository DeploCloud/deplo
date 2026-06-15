# Deplo

Deplo is a self hosted deployment platform. It gives you the developer
experience of Vercel with the feature set of Coolify, Dokploy and Easypanel,
running entirely on your own infrastructure: a VPS, a remote server or a
dedicated machine. Push a repository or pick a template and Deplo builds it in
Docker, then exposes it through Traefik with automatic HTTPS.

## How it works

```
                +--------------------------------------------+
   Browser ---> |  Deplo control plane (this Next.js app)    |
                |  UI + API + auth + Postgres data store     |
                +-----------------------+--------------------+
                                        | talks to the Docker socket
                                        v
        +---------------------------------------------------+
        |  Your Linux server (master or a remote)           |
        |                                                   |
        |    +---------+   routes + TLS   +--------------+  |
        |    | Traefik | <==============> | app          |  |
        |    |  :80    |                  | db           |  |
        |    |  :443   |   Let's Encrypt  | services     |  |
        |    +---------+                  +--------------+  |
        |          all on the shared `deplo` docker network |
        +---------------------------------------------------+
```

The platform rests on a few pieces of infrastructure:

1. Docker. Every app, database and service is a container. Deplo generates a
   `docker-compose.yml` per workload (see `lib/deploy/compose.ts`).
2. Traefik. A single reverse proxy routes each domain to the right container and
   issues TLS certificates automatically through Let's Encrypt (HTTP-01).
   Routing is configured with container labels generated in
   `lib/deploy/traefik.ts`.
3. Postgres. When `DEPLO_DATABASE_URL` is set, Postgres is the system of record
   for all control plane data and backs Better Auth. Without it, Deplo falls
   back to a zero config local JSON store so it still runs with no database.

Everything joins one shared Docker network called `deplo`, so Traefik can reach
every service and services can reach each other by name.

## Features

Deplo aims for parity with the popular self hosted platforms:

* Projects and deployments with automatic framework detection
  (`lib/frameworks.ts`): Next.js, SvelteKit, Astro, Nuxt, Remix, Vite, Vue,
  Angular, Gatsby, static sites, Node, Python, Go, Rust, PHP, or a raw
  Dockerfile. Build commands are inferred and editable.
* Multiple deploy sources, chosen in the wizard and editable per project:
  GitHub, any Git URL, a prebuilt Docker image, a Dockerfile, or an upload.
* Servers. A master server (the host running Deplo) plus remote servers added
  over SSH. Every deploy targets a server you choose from a dropdown.
* Templates. One click deploys for a large catalog of apps and services
  (WordPress, Ghost, Plausible, n8n, Supabase, MinIO, Uptime Kuma, Postgres,
  Redis and many more). Templates ask which server to run on, not for a Git
  repository.
* Storage. Managed databases (Postgres, MySQL, MariaDB, MongoDB, Redis,
  ClickHouse), an S3 destinations tab for any S3 compatible bucket, and
  scheduled backups to those destinations.
* Domains. Custom domains with automatic TLS.
* Real-time monitoring of every server (master and remotes): live CPU, memory,
  disk and network with per-server charts.
* Logs, activity audit and team settings make up the rest of the dashboard.

## Install on a server

Run one command on a fresh Linux box. It installs Docker, brings up Traefik with
automatic HTTPS, provisions a private Postgres, and starts the Deplo control
plane. No manual configuration is required:

```bash
curl -fsSL https://raw.githubusercontent.com/IdraDev/deplo/main/install.sh | bash
```

The installer is the static `install.sh` at the repo root, served directly from
GitHub (the `/install` route on a running instance is a short alias that
redirects there). It is idempotent: secrets are generated once and stored in
`/opt/deplo/.env`, so re-running it never rotates them. Override defaults with
env vars, e.g. `DEPLO_DOMAIN=deplo.example.com ACME_EMAIL=you@example.com`. After
it finishes, point your domain at the server and finish setup in the browser.

## Run locally

```bash
bun install
bun run dev          # http://localhost:3000
```

On first run a local JSON store is seeded at `.deplo/data.json` (gitignored) with
a demo team, a master server, a remote server and a few projects. Development
login:

* Email: `admin@deluxhost.net`
* Password: `deplo-admin-2026` (development convenience only)

Override these with `DEPLO_ADMIN_EMAIL` and `DEPLO_ADMIN_PASSWORD`.

In production the fixed development password is never used. If
`DEPLO_ADMIN_PASSWORD` is unset, Deplo generates a random one time admin password
and prints it once to the server logs on first boot.

## Use Postgres and Better Auth

Set `DEPLO_DATABASE_URL` and Deplo switches to Postgres for all control plane
data, and enables Better Auth at `/api/auth/*`.

```bash
export DEPLO_DATABASE_URL=postgres://deplo:password@localhost:5432/deplo
export DEPLO_SECRET=$(openssl rand -base64 48)
bun run db:push      # create the Better Auth and state tables
bun run dev
```

The Docker Compose file ships a Postgres service, so `docker compose up -d`
wires everything together automatically.

### Environment variables

Copy `.env.example` to `.env` and fill it in. The important ones:

| Variable | Purpose |
| --- | --- |
| `DEPLO_SECRET` | Required in production. Root secret that derives all session signing and AES-256-GCM encryption keys, and is reused as the Better Auth secret. Use a long random string. |
| `DEPLO_PUBLIC_URL` | Public URL the dashboard is served from. Used for cookies, TLS detection and the install command. |
| `DEPLO_DATABASE_URL` | Postgres connection string. When set, enables Postgres and Better Auth. |
| `DEPLO_DATABASE_POOL_MAX` | Optional cap on the Postgres connection pool (default 10). |
| `DEPLO_DATA_DIR` | Where the local JSON store lives when Postgres is not configured (default `./.deplo`). |
| `DEPLO_ACME_EMAIL` | Email used for Let's Encrypt in the generated installer. |

## Security

* Sessions are HMAC signed stateless cookies (`HttpOnly`, `SameSite=Lax`,
  `Secure` over HTTPS, 7 day expiry). When Postgres is configured, Better Auth
  manages credential and session storage.
* Secrets at rest (env vars, database connection strings, S3 keys) are
  AES-256-GCM encrypted and only ever returned to the client masked.
* Passwords are hashed with scrypt using constant time comparisons.
* A per request CSP nonce plus hardening headers (HSTS, `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`) are set in `proxy.ts`.
* Every server action validates input with Zod and re-checks auth in the data
  layer (`assertUser`); page level auth is never trusted alone.
* Rate limiting protects the authentication endpoints.

## Tech stack

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, shadcn/ui in a
black and white theme, Lucide icons, Docker, Traefik, Postgres, Drizzle, Better
Auth and Bun.

## Project layout

```
app/(auth)        login and signup
app/(dashboard)   the product (overview, projects, storage, domains and more)
app/api/auth      Better Auth endpoints (active when Postgres is configured)
app/install       alias that redirects to install.sh on GitHub
install.sh        the installer (single source of truth, served from GitHub)
components/ui     shadcn primitives
components/*      feature components
lib/data          data access layer (server only, auth checked)
lib/actions       server actions (Zod validated)
lib/db            Postgres pool, Drizzle schema and document store
lib/auth          session helpers and Better Auth configuration
lib/deploy        docker-compose and Traefik generation
lib/frameworks.ts framework detection engine
lib/templates.ts  one click template catalog
lib/crypto.ts     hashing, encryption and session signing
proxy.ts          CSP, security headers and the optimistic auth gate
```
