# Deplo GraphQL API

Deplo exposes a single GraphQL endpoint that is the canonical way to drive the
platform — the dashboard UI and any external client (CLI, CI, your own tooling)
speak the same API.

```
POST  https://<your-deplo-host>/api/graphql
GET   https://<your-deplo-host>/api/graphql      # GraphiQL explorer (in a browser)
```

The full schema is published as [`schema.graphql`](../../schema.graphql) at the
repo root and is browsable interactively via GraphiQL at the endpoint above.

## Authentication

Two ways to authenticate, both resolving to the same per-request identity and
team scope:

### 1. Session cookie (browser / same-origin)

The web app calls the API same-origin; the `deplo_session` cookie is sent
automatically. You never handle tokens in the UI. The active team comes from the
`deplo_team` cookie.

### 2. API token (external clients)

Create a token in **Settings → API tokens**. It is shown **once** — store it
securely. Send it as a bearer token:

```bash
curl https://your-host/api/graphql \
  -H "Authorization: Bearer deplo_xxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ me { username } apps { name status } }"}'
```

A token is scoped to the team it was created in and acts with its creator's
capabilities. Every query and mutation is filtered to that team automatically —
there is no way for a token to reach another team's data.

Unauthenticated requests resolve `me` to `null` and are rejected by any field
that requires a login (`Not authorized to resolve …`).

## Authorization

Fields are gated by the same capability model as the dashboard:

| Capability        | Covers                                                       |
| ----------------- | ----------------------------------------------------------- |
| `deploy`          | create/redeploy/stop/start/delete apps, dev, deployments, projects & environments |
| `manage_domains`  | add/verify/route/remove custom domains                      |
| `manage_env`      | app, environment-scoped, team & shared variables        |
| `manage_infra`    | servers, databases, S3, registries, backups, GitHub, tokens |
| `manage_members`  | add/remove members, change roles                            |
| `manage_team`     | rename/edit/delete the team                                 |

Some queries/mutations require **instance admin** (global): managing all users,
minting registration links, the per-user admin editor.

## Shape of the API

- **Queries** mirror the read layer: `apps`, `app(slug)`, `projects`
  (the containers), `environments(projectId)`, `sharedVars`, `sharedVarsForApp(appId)`,
  `deployments`, `databases`, `database(id)`, `databaseRuntime(databaseId)`,
  `databaseConsoleInfo`/`databaseLogsInfo`/`databaseShellLabel`, `domains`, `servers`,
  `serverMetrics`, `appMetrics(appId)`/`databaseMetrics(databaseId)` (live per-container
  resource usage for the Monitoring tab) and their `*MetricsHistory` seeds,
  `members`, `apiTokens`, `activity`, `me`, `viewerTeam`, …. Object
  types are navigable — e.g. `App.deployments`, `App.latestDeployment`.
- **Mutations** mirror every former server action: `createApp`, `redeploy`,
  `stopApp`, `createProject`, `createEnvironment`, `upsertEnvironmentEnv`,
  `addDomain`, `createDatabase`, `updateDatabase`, `restartDatabase`,
  `redeployDatabase`, `rebuildDatabase`, `updateDatabaseResources`, `updateDatabaseImage`,
  `rotateDatabasePassword`, `execDatabaseConsole`, `setSaveMetrics`,
  `setAppSaveMetrics(appId, enabled)`/`setDatabaseSaveMetrics(databaseId, enabled)`
  (the per-resource "Save metrics" switch, `manage_infra`, default off),
  `createToken`, `updateTeam`, `login`, `logout`, ….
- **Subscriptions** (SSE via graphql-yoga): `appStatus(slug)` and
  `databaseStatus(id)` — each emits the entity on every state change (initial
  snapshot, then live), so a client tracks provisioning/start/stop/deploy with
  no polling.

Mutations return the affected entity where natural (so a client needs no second
fetch), or `Boolean` for deletes/toggles, or a `String` for reveal-secret
operations (e.g. `revealConnection`, `rotateDatabasePassword` return the
connection string).

## Errors

Errors come back in the standard GraphQL `errors[]` array. The `message` is
safe to show a user (e.g. `"You don't have permission to deploy"`); internal
stack traces are never leaked.

## Examples

Redeploy an app:

```graphql
mutation {
  redeploy(appId: "prj_123") { id status }
}
```

Create an app environment variable:

```graphql
mutation {
  upsertEnv(input: {
    appId: "prj_123"
    key: "DATABASE_URL"
    value: "postgres://…"
    targets: [production, preview]
    type: secret
  }) { id key isMasked }
}
```

Share a variable with every app of a Project, in one environment's context
(no `targets` — the environment IS the scope):

```graphql
mutation {
  upsertEnvironmentEnv(input: {
    environmentId: "environ_123"
    key: "API_BASE_URL"
    value: "https://api.example.com"
    type: plain
  }) { id key value }
}
```

List apps with their latest deployment:

```graphql
query {
  apps {
    name
    status
    latestDeployment { status createdAt commitMessage }
  }
}
```

## Not over GraphQL

A few endpoints stay REST because GraphQL is the wrong transport for them
(binary upload and long-lived byte streams):

| Endpoint                          | Why                              |
| --------------------------------- | -------------------------------- |
| `POST /api/apps/[id]/upload`  | multipart archive upload         |
| `GET /api/apps/[id]/logs`     | Server-Sent-Events log stream    |
| `GET /api/apps/[id]/attach`   | interactive console session      |
| `GET /api/github/callback`        | GitHub App OAuth callback        |
| `POST /api/github/webhook`        | GitHub webhook receiver          |
