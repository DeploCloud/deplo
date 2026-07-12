# Apps are host-managed containers, not projects

> **Terminology update (Jul 2026):** the installable feature this ADR calls an **App** is now
> called a **Plugin**, and the deployable unit formerly called a **Service** is now called an
> **App**. Read "App/app repository/app path" → "Plugin/plugin repository/plugin path" and
> "Service" → "App" throughout. The decision itself is unchanged; only the words moved. The
> runtime identity (`deplo-app-<slug>` container, `deplo.role=app`, `app_` id prefix) is kept
> for compatibility; the public path moved to `/plugins/<slug>`.

## Context

Deplo lets a team install **apps** from a remote **app repository** to extend the platform
(the first being the **MCP app**, a server exposing Deplo's GraphQL API to an LLM client).
The obvious design — and the original plan — was *App = a team-owned project* deployed
through the normal pipeline, to inherit start/stop/logs/route/TLS "for free." We rejected
that. An app is **not a project**: it never appears in the Projects tab, the project count,
or the `projects` API. Instead an app reuses the **SSH-gateway pattern** — a container Deplo
runs directly via the Docker socket (`deplo.managed=true`, `deplo.role=app`), rendered from a
small compose, lifecycled with `docker compose up -d` / start / stop. This keeps the
project surface honest (only user-deployed apps are "projects") and structurally prevents an
app's container from being deleted out from under it from the Projects screen.

## Decision

1. **An app is a host-managed container, never a Project.** (The MCP app holds no credential
   of its own — see decision 3.) Lifecycle (install / uninstall / start / stop) sits behind
   `manage_infra`; uninstall tears the container down directly and revokes the key — it does
   **not** call the `deploy`-gated `deleteProject`.

2. **A reachable app is served on a path under Deplo's own public URL** (the **app path**,
   e.g. `https://<deplo>/apps/mcp-<slug>/mcp`), via a Traefik `PathPrefix` router +
   `stripprefix` on the existing dashboard host. **No per-app domain, sslip.io name, TLS
   cert, or `Domain` row.** The path router is strictly more specific than the bare
   `Host(DEPLO_DOMAIN)` dashboard router, so they never collide.

3. **The MCP app holds no credential; it is a stateless relay.** The only credential is the
   **caller token** — a `deplo_` API token a user mints from Settings → API Tokens and pastes
   into their own MCP client. The client sends it to the app path; the app forwards it
   verbatim to `/api/graphql`; Deplo authenticates it per call. There is **no app-held secret
   and no `MCP_BEARER`** — reaching the app and acting through it are one capability check on
   the caller's own token, per user. Install mints nothing; uninstall revokes nothing.

4. **App status is read live, never stored.** The `InstalledApp` row holds no `status`,
   `projectId`, `url`, or token reference — only `{ id, teamId, catalogId, version, createdAt }`.
   Status is derived at query time from `docker inspect` in the data layer and exposed through
   GraphQL; the UI reads it via the API (**UI → GraphQL → data layer → socket**, never UI →
   socket). One install per app per team.

## Considered options

- **App = project** (the plan's reuse bet): rejected — pollutes the Projects tab/count/API,
  lets the app's backing project and token be deleted/revoked from unrelated screens (orphan
  + drift), and drags in per-app domains/TLS the MCP app doesn't need.
- **A wholly separate app runtime** (no reuse): rejected — would reimplement container
  create/start/stop/status that the SSH-gateway machinery already provides.
- **Per-app domain + sslip.io + TLS**: rejected — an app only needs to be *reachable*, and a
  path on Deplo's own host reuses its cert with zero new infrastructure.
- **Next.js reverse-proxy for the app path**: rejected in favor of Traefik path labels — keeps
  long-lived MCP streaming traffic out of the control-plane process.
- **Push-only stored status** (as `project.status` / `dev.status`): rejected — it carries a
  documented staleness bug; the app set is tiny, so a live read is cheap and always truthful.
- **App-held secret key + separate `MCP_BEARER` door key** (the original two-layer guard):
  rejected — bakes a standing credential into the container (a secret at rest), and splits
  auth into a weaker outer ring. The stateless-relay model has no secret at rest, gives
  per-user/per-client tokens, and fuses both layers into one capability check.

## Consequences

- Apps reuse `lib/infra/` (gateway-style compose render + `startContainer`/`stopContainer` +
  `docker inspect`), **not** `lib/data/projects.ts`.
- Three read paths must exclude app containers from "projects": the Projects list, the project
  count, and the GraphQL `projects` query (the last also keeps the MCP app from seeing itself).
- The app path adds one Traefik `PathPrefix` router on the dashboard host per installed app.
- Event-driven apps (observe-only subscriptions) are a later phase; **blocking gates** (a true
  pre-deploy veto) are explicitly out of scope, reserved for a future ADR.
