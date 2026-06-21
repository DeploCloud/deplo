# App System + AI MCP App

> **Design status:** settled in a `/grill-with-docs` session. The decisions below are
> recorded in **CONTEXT.md** (Apps section) and **ADR-0005** (apps are host-managed
> containers, not projects). Read those first — they are the source of truth; this file is
> the implementation spec derived from them.

## Context

Deplo lets a team **install apps** — optional, self-contained features fetched from a remote
**app repository** — to extend the platform. The repository lives at the sibling dir
`../deplo-app-repository`, served at **`devrepo.pixelfederico.com`**. The **first app is the
MCP app**: a **stateless relay** exposing Deplo's whole GraphQL API to an LLM client (Claude,
Cursor, …). The user mints a `deplo_` token from Settings → API Tokens and pastes it into
their client; the app forwards that **caller token** verbatim to Deplo's API — it holds no
credential of its own.

This is tractable because the API problem is already solved. The working tree replaced the
cookie-only server-action layer with a **GraphQL API** at `POST /api/graphql` (graphql-yoga +
Pothos) exposing the entire surface (~80 queries + ~52 mutations) and authenticating external
callers with a team-scoped `deplo_…` bearer token (all verified in the current tree):

- `lib/graphql/context.ts` — `buildContext()` reads `Authorization: Bearer deplo_…`, calls
  `authenticateToken()`, and runs the whole operation inside `runWithIdentity()`.
- `lib/auth/request-context.ts:44` — `runWithIdentity()` is the single seam; the data layer's
  `getCurrentUser()`/`getActiveTeamId()`/`requireCapability()` resolve the token's principal
  instead of cookies. **No new auth work is needed.**
- `lib/data/tokens.ts:35,59` — `createToken(name)` → `{raw: "deplo_…", token}` (gated on
  `manage_infra`); `authenticateToken(raw)` → `{userId, teamId}` via sha256 lookup, bumps
  `lastUsedAt`.
- `schema.graphql` (~1248 lines) is the machine-readable contract the MCP server uses.

## What an App IS (the settled model — see ADR-0005)

An installed app is a **host-managed container** (the MCP app holds no credential of its own),
and it is **NOT a project**:

- **Host-managed container.** Deplo runs the app's container directly via the Docker socket —
  the **SSH-gateway pattern** (`lib/infra/ssh-gateway.ts`), *not* the project pipeline. The
  container is labeled `deplo.managed=true` + `deplo.role=app`, joins the `deplo` network, and
  is lifecycled with `docker compose up -d` / `startContainer` / `stopContainer`. Real
  start/stop/restart and **honest live status** follow for free from the socket.
- **Not a project.** It never appears in the Projects tab, the project count, or the
  `projects` API. No `createProject`, no `Domain` row, no per-app sslip.io/TLS.
- **Reached on the app path** under Deplo's own public URL — e.g.
  `https://<deplo>/apps/mcp-<slug>/mcp` — via a Traefik `PathPrefix` router + `stripprefix` on
  the existing dashboard host. This reuses Deplo's TLS; the path router is strictly more
  specific than the bare `Host(DEPLO_DOMAIN)` dashboard router, so they never collide
  (verified, and `lib/deploy/routing.ts` already supports `pathPrefix` + `stripprefix`).
- **Stateless relay, one credential.** The MCP app holds **no credential of its own** and
  there is **no `MCP_BEARER`**. The only credential is the **caller token** — a `deplo_` token
  the user mints from Settings → API Tokens and pastes into their MCP client. The client sends
  it to the app path; the app forwards it **verbatim** to `/api/graphql`; Deplo authenticates
  it per call. *Reaching* the app and *acting* through it are one capability check on the
  caller's own token. Per-user/per-client: revoking one user's token cuts off only that user.
- **Live status, never stored.** `InstalledApp` stores no `status`/`url`/`projectId`/token.
  Status is read at query time via `docker inspect` in the data layer and exposed through
  GraphQL. The UI never touches Docker: **UI → GraphQL → data layer → socket**.
- **One install per app per team.** Container name is deterministic per team. Install mints no
  secret and uninstall revokes none — there is no app-held token to rotate.

### Key decisions (locked)

- API access: existing **GraphQL API + team-scoped `deplo_` token** (no new API layer).
- Coverage: the MCP exposes **everything** the GraphQL schema offers (3 generic tools).
- An app is a **host container, not a project**; reuses `lib/infra/` (gateway pattern), not
  `lib/data/projects.ts`.
- Served on a **path under Deplo's own URL** (app path) — no per-app domain/sslip.io/TLS.
- The MCP app is a **stateless relay**: no app-held secret, no `MCP_BEARER`; the user's
  **caller token** is the only credential, forwarded verbatim to the API.
- Whole lifecycle gated on **`manage_infra`**; uninstall tears down directly (NOT via the
  `deploy`-gated `deleteProject`).
- **Events** (observe-only subscriptions so apps can react to lifecycle events) are **Phase
  2**; **blocking gates** are out of scope (future ADR).

---

## Part A — `../deplo-app-repository` (new repo, served at devrepo.pixelfederico.com)

A static catalog server + the source of the first app's image.

```
deplo-app-repository/
  catalog.json                      # list of apps (AppListing[])
  apps/
    mcp/
      manifest.json                 # AppManifest (install spec)
      README.md
      logo.svg
  server/                           # tiny static file server (nginx)
    Dockerfile
  mcp-server/                       # SOURCE of the MCP app's container image
    package.json                    # @modelcontextprotocol/sdk, graphql-request, zod
    src/index.ts                    # Streamable-HTTP MCP server (served on the app path)
    src/deplo-client.ts             # GraphQL client; relays the caller's Bearer token
    src/tools.ts                    # the 3 generic GraphQL tools
    Dockerfile
```

### Catalog / manifest schema (the contract Deplo fetches)

`catalog.json` → array of `AppListing`:

```jsonc
{
  "id": "mcp",
  "name": "AI MCP Server",
  "description": "Expose Deplo's full API to an AI assistant over MCP.",
  "version": "1.0.0",
  "logo": "/apps/mcp/logo.svg",
  "tags": ["ai", "mcp"],
  "manifestUrl": "/apps/mcp/manifest.json"
}
```

`manifest.json` → `AppManifest`. Note `expose` is the **container port the app path forwards
to** — it is NOT a domain/Traefik `Host`. The MCP app holds **no secret**, so its only injected
env is the API URL (it relays the caller's token, never its own):

```jsonc
{
  "id": "mcp",
  "name": "AI MCP Server",
  "version": "1.0.0",
  "image": "devrepo.pixelfederico.com/mcp-server:1.0.0", // the runnable image
  "expose": { "port": 8080 },                            // app path forwards here
  "env": [
    { "key": "DEPLO_GRAPHQL_URL", "value": "${deplo_graphql_url}" } // injected by Deplo
  ]
}
```

Deplo resolves the one `${deplo_graphql_url}` placeholder at install time (Part B step 3). The
`${secret:N}` substitution engine still exists in `lib/templates-blueprint.ts` for future apps
that genuinely need a generated secret — the MCP app simply doesn't.

### The MCP server image (`mcp-server/`)

- Node 22, `@modelcontextprotocol/sdk` (latest), `graphql-request`, `zod`.
- On boot reads only `DEPLO_GRAPHQL_URL`. **No token, no `MCP_BEARER`** — the app is stateless.
- **Streamable-HTTP transport only** at `/mcp` (the container runs on Deplo's host, reached via
  the app path; **stdio is dropped for v1** — there is no local-run story now). Each request
  must carry the caller's own `Authorization: Bearer deplo_…` header.
- **Tools = 3 generic GraphQL tools** (covers the whole API, never drifts):
  - `deplo_introspect` → returns `schema.graphql` so the model self-discovers the surface.
  - `deplo_query` → `{ query, variables? }` → forwards to `/api/graphql`.
  - `deplo_mutation` → same for mutations.
  - The app **forwards the caller's `Authorization` header verbatim** to `/api/graphql` → the
    caller's own team principal, so a caller can only ever do what *their* token allows. If no
    bearer is presented, the app rejects the request (nothing to relay).

---

## Part B — Deplo side: the app system

### 1. Data model — `lib/types.ts` + `lib/seed.ts` + `lib/store.ts`

Add a minimal `InstalledApp` collection (JSONB document, auto-backfilled by `normalize()` in
`lib/store.ts:40`; add the empty array to `buildSeed()` in `lib/seed.ts`). **No `status`,
`projectId`, or `url`** — status is live, the container is named deterministically:

```ts
interface InstalledApp {
  id: ID;          // newId("app")
  teamId: ID;      // team-scoped, like everything else
  catalogId: string; // "mcp"
  version: string;
  createdAt: string;
  // No apiTokenId: the MCP app holds no token (it relays the caller's).
  // No status/url/projectId: status is live, url is computed from the slug.
}
```

Add `installedApps: InstalledApp[]` to `DeploData` and `buildSeed()`.

### 2. Repository client — `lib/apps/repository.ts` (new)

Mirror the outbound-fetch pattern in `lib/data/updates.ts` (plain `fetch`, User-Agent,
`next: { revalidate }`, graceful degradation):

- `REPO_BASE = process.env.DEPLO_APP_REPO_URL ?? "https://devrepo.pixelfederico.com"`.
- `fetchCatalog(): Promise<AppListing[]>` — GET `${REPO_BASE}/catalog.json`.
- `fetchManifest(listing): Promise<AppManifest>` — GET `${REPO_BASE}${listing.manifestUrl}`.
- Validate both with **zod**. Reject manifests whose env/expose fail validation. Treat
  `image`/env as **opaque** (never `eval`); cap response sizes.

### 3. App runtime — `lib/apps/runtime.ts` (new, models on `lib/infra/ssh-gateway.ts`)

This is the SSH-gateway precedent applied to apps — **not** the project pipeline:

- `renderAppCompose(app, resolvedEnv): string` — pure render (like `renderGatewayCompose`):
  `image`, `container_name: deplo-app-<catalogId>-<teamSlug>`, `restart: unless-stopped`,
  `networks: [deplo]`, labels `deplo.managed=true` + `deplo.role=app`, **Traefik path labels**
  for `Host(DEPLO_DOMAIN) && PathPrefix(/apps/<slug>)` + `stripprefix` (build via the existing
  `lib/deploy/routing.ts` `traefikRouterLabels({ pathPrefix })` helper), forwarding to
  `expose.port`.
- `startAppContainer(slug)` / `stopAppContainer(slug)` — delegate to
  `startContainer`/`stopContainer` in `lib/deploy/build.ts`.
- `appStatus(slug): "running" | "stopped" | "error"` — `docker inspect -f {{.State.Running}}`
  (the gateway's `gatewayRunning()` pattern). **Live, never stored.**
- `destroyAppContainer(slug)` — `docker compose down` + remove the env/stack file (so uninstall
  leaves no orphaned Traefik router).

### 4. App data layer — `lib/data/apps.ts` (new, team-scoped like `lib/data/registries.ts`)

- `listInstalledApps()` — `requireActiveTeamId()` filter (read).
- `appRuntimeStatus(id)` — read; resolves live status via `appStatus(slug)`.
- `installApp(catalogId)` — `requireCapability("manage_infra")`; see step 5. **One per team**:
  if a row already exists, recreate the container instead of duplicating (no key to rotate).
- `uninstallApp(id)` — `requireCapability("manage_infra")`; `destroyAppContainer` + drop the
  row. **No token to revoke** (the app held none) and it **does NOT call `deleteProject`**
  (that is `deploy`-gated and would assume a project record we never made).
- `startApp(id)` / `stopApp(id)` — `requireCapability("manage_infra")` → start/stop the
  container.

### 5. Install flow — `installApp("mcp")`

1. `fetchCatalog()` → find listing → `fetchManifest()`.
2. **Resolve placeholders** in the manifest env (the MCP app has just one):
   - `${deplo_graphql_url}` → `${DEPLO_PUBLIC_URL}/api/graphql` (`lib/public-url.ts`).
   - (`${secret:N}` → `randomToken(N)` from `lib/crypto.ts` remains available for future apps
     that need a generated secret — the MCP app injects none.)
3. **Run the container**: `renderAppCompose(...)` → `docker compose up -d` on the `deplo`
   network with the Traefik path labels. Slug like `mcp-<short>`; container name deterministic
   per team. App path = `https://<deplo>/apps/<slug>/mcp`.
4. Persist the `InstalledApp` row. (Status is read live; URL is computed from the slug.)

No token is minted — the user supplies their own caller token from Settings → API Tokens.
Uninstall is the inverse: destroy container → drop row (nothing to revoke).

### 6. GraphQL exposure — `lib/graphql/types/apps.ts` (new, mirror `registry.ts`)

- Object type `InstalledApp` (its `status` field is a **resolver** → `appStatus(slug)`, live)
  + `AppListing` (catalog entry).
- Query `appCatalog: [AppListing!]!` (loggedIn) → `fetchCatalog()`.
- Query `installedApps: [InstalledApp!]!` (loggedIn) → `listInstalledApps()`.
- Mutation `installApp(catalogId): InstalledApp` / `uninstallApp(id): Boolean` /
  `startApp(id): Boolean` / `stopApp(id): Boolean` — all `authScopes: { capability: "manage_infra" }`.
- Register the module in `lib/graphql/schema.ts` (side-effect import) and regenerate
  `schema.graphql`.

### 7. Dashboard UI — new `/apps` route + nav entry

- `components/layout/nav-config.ts` — add an **"Apps"** item in the **Infrastructure** section
  after Templates (lucide `Boxes`/`Blocks`, tooltip "Install apps to extend Deplo").
- `app/(dashboard)/apps/page.tsx` (+ `loading.tsx`) — server component: fetch catalog +
  installed apps via the existing server-side GraphQL pattern; render with a new
  `components/apps/apps-browser.tsx` modeled on `components/templates/templates-browser.tsx`.
- Each card: Install / Uninstall / **Start / Stop** + live status → GraphQL mutations via
  `lib/use-graphql.ts` (`useGraphqlMutation`). **Note: `useGraphqlQuery` does not exist** — the
  page fetches server-side like the rest of the dashboard, not via a client query hook.
- For the MCP app, after install show the **connect dialog**: the app-path endpoint
  (`<deplo>/apps/<slug>/mcp`) and a copyable client-config snippet, with instructions to
  **mint a token in Settings → API Tokens and paste it** as the client's bearer. Deplo
  generates and reveals **nothing** here — the credential is the user's own caller token,
  managed entirely from the existing Tokens panel.

### 8. Config / docs

- `.env.example` — add `DEPLO_APP_REPO_URL` (default `https://devrepo.pixelfederico.com`).
- `CONTEXT.md` — **done** (Apps section: App, App repository, Caller token, App path, Event).
- `docs/adr/0005-apps-are-host-managed-containers-not-projects.md` — **done**.

---

## Files to create / modify

**Create (Deplo):**

- `lib/apps/repository.ts` — catalog/manifest fetch + zod validation
- `lib/apps/manifest.ts` — `AppListing`/`AppManifest` types + placeholder resolver
- `lib/apps/runtime.ts` — gateway-style compose render + start/stop/status/destroy
- `lib/data/apps.ts` — team-scoped install/uninstall/list/start/stop (`manage_infra`)
- `lib/graphql/types/apps.ts` — GraphQL types/queries/mutations (live status resolver)
- `app/(dashboard)/apps/page.tsx`, `app/(dashboard)/apps/loading.tsx`
- `components/apps/apps-browser.tsx`, `components/apps/app-card.tsx`,
  `components/apps/mcp-connect-dialog.tsx`

**Modify (Deplo):**

- `lib/types.ts` (+`InstalledApp`, +`installedApps` on `DeploData`)
- `lib/seed.ts` (`installedApps: []`)
- `lib/graphql/schema.ts` (register apps module)
- Projects read paths — **exclude app containers**: the Projects list, the project count, and
  the GraphQL `projects` query (the last also keeps the MCP app from seeing itself). App
  containers are `deplo.role=app`, never `Project` rows, so this is mostly a non-issue — but
  audit that nothing enumerates containers by label and mistakes an app for a project.
- `components/layout/nav-config.ts` (Apps nav item)
- `.env.example`, `schema.graphql` (regenerate)

**Create (new repo `../deplo-app-repository`):** full tree in Part A (catalog, MCP manifest +
logo, `mcp-server/` source image w/ Streamable-HTTP, static `server/`).

---

## Reuse map (don't reinvent)

- **Token auth (the caller token)**: `lib/data/tokens.ts` (`authenticateToken`) +
  `runWithIdentity` — already wired into GraphQL. The user mints the caller token from the
  **existing** Tokens panel; the app system mints nothing.
- **Run as a managed container (NOT a project)**: `lib/infra/ssh-gateway.ts` (rendered compose
  + `up -d` + `docker inspect` status) and `startContainer`/`stopContainer` in
  `lib/deploy/build.ts`. This is the precedent, not `lib/data/projects.ts`.
- **App path routing**: `lib/deploy/routing.ts` `traefikRouterLabels({ pathPrefix, stripPrefix })`
  — already supports `PathPrefix` + `stripprefix` (tested in `routing.test.ts`). No new proxy.
- **Remote fetch**: copy the shape of `lib/data/updates.ts` (UA, revalidate, graceful).
- **Catalog UI**: copy `components/templates/templates-browser.tsx`.
- **Tokens panel**: `components/settings/tokens-panel.tsx` — where the user mints the caller
  token (unchanged; the connect dialog just points there).
- **Secret substitution** (future apps only): the `${secret}`/`${password:N}` engine in
  `lib/templates-blueprint.ts` — the MCP app uses none.
- **GraphQL module shape**: `lib/graphql/types/registry.ts` is the smallest template.

---

## Out of scope (deferred)

- **Events** (Phase 2): an observe-only event bus so apps react to lifecycle events
  (`deployment.succeeded`, …) by calling the capability-scoped API. Fire-and-forget + retries.
  Its own grilling + likely an ADR.
- **Blocking gates**: a true pre-deploy veto. Explicitly out of scope — reserved for a future
  ADR (it changes the deploy pipeline's control flow and adds a DoS surface against deploys).
- **stdio / local-run MCP**: dropped for v1; the container runs on Deplo's host.

---

## Verification (end-to-end)

1. **Repo serves**: `curl $REPO/catalog.json` and `curl $REPO/apps/mcp/manifest.json` return
   valid JSON (zod parses).
2. **Build MCP image**: `docker build ../deplo-app-repository/mcp-server` succeeds.
3. **Deplo lint/types**: `bun run lint` and the build (`tsc`) pass; `bun test` green.
4. **Schema regenerated**: `schema.graphql` includes `appCatalog`, `installedApps`,
   `installApp`, `uninstallApp`, `startApp`, `stopApp`.
5. **Install via UI**: log in → **Apps** → install "AI MCP Server". Confirm: a `deplo.role=app`
   container reaches running; it is **absent** from the Projects tab and project count; the
   Traefik path `https://<deplo>/apps/mcp-…/mcp` resolves; **no `apiTokens` row is minted** by
   install; the connect dialog points the user to Settings → API Tokens (Deplo reveals no
   secret of its own).
6. **Status & power**: stop the app → status flips to `stopped` **live** (read via the API, not
   stored); start → back to `running`. Kill the container out-of-band → status shows the truth.
7. **MCP works against the live API with a user-minted caller token** (core acceptance):
   - Mint a `deplo_` token in Settings → API Tokens; configure the MCP client to send it.
   - `deplo_introspect` → returns the schema.
   - `deplo_query` `{ projects { id name status } }` → returns **that caller's** team projects
     (and does NOT include the app's own container) — proves the relayed bearer resolves the
     caller's principal and the `projects` query excludes app containers.
   - `deplo_mutation` a harmless write (e.g. `renameProject`) → succeeds; a `manage_*`-gated op
     fails if **the caller's** token lacks the capability — proves capability gating flows
     through `runWithIdentity` on the relayed token.
   - A request with **no bearer** is rejected by the app (nothing to relay); revoking the
     caller's token in Settings makes subsequent calls 401 — proves per-user control.
   - Point a real MCP client (Claude Desktop/Code) at `<deplo>/apps/mcp-…/mcp` with the
     caller token and confirm tools list + a query round-trip.
8. **Uninstall**: removes the app container + its Traefik router (no orphaned path) and drops
   the `InstalledApp` row. **No token to revoke** — the user's caller token is unaffected and
   still works against `/api/graphql` directly (it was never app-owned).
```
