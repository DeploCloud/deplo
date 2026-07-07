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
  -d '{"query":"{ me { username } services { name status } }"}'
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
| `deploy`          | create/redeploy/stop/start/delete services, dev, deployments, projects & environments |
| `manage_domains`  | add/verify/route/remove custom domains                      |
| `manage_env`      | service, environment-scoped, team & shared variables        |
| `manage_infra`    | servers, databases, S3, registries, backups, GitHub, tokens |
| `manage_members`  | add/remove members, change roles                            |
| `manage_team`     | rename/edit/delete the team                                 |

Some queries/mutations require **instance admin** (global): managing all users,
minting registration links, the per-user admin editor.

## Shape of the API

- **Queries** mirror the read layer: `services`, `service(slug)`, `projects`
  (the containers), `environments(projectId)`, `environmentEnv(environmentId)`,
  `deployments`, `databases`, `domains`, `servers`, `serverMetrics`, `members`,
  `apiTokens`, `activity`, `me`, `viewerTeam`, … (79 in total). Object types are
  navigable — e.g. `Service.deployments`, `Service.latestDeployment`.
- **Mutations** mirror every former server action: `createService`, `redeploy`,
  `stopService`, `createProject`, `createEnvironment`, `upsertEnvironmentEnv`,
  `addDomain`, `createDatabase`, `createToken`, `updateTeam`, `login`,
  `logout`, … (179 in total).

Mutations return the affected entity where natural (so a client needs no second
fetch), or `Boolean` for deletes/toggles, or a `String` for reveal-secret
operations.

## Errors

Errors come back in the standard GraphQL `errors[]` array. The `message` is
safe to show a user (e.g. `"You don't have permission to deploy"`); internal
stack traces are never leaked.

## Examples

Redeploy a service:

```graphql
mutation {
  redeploy(serviceId: "prj_123") { id status }
}
```

Create a service environment variable:

```graphql
mutation {
  upsertEnv(input: {
    serviceId: "prj_123"
    key: "DATABASE_URL"
    value: "postgres://…"
    targets: [production, preview]
    type: secret
  }) { id key isMasked }
}
```

Share a variable with every service of a Project, in one environment's context
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

List services with their latest deployment:

```graphql
query {
  services {
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
| `POST /api/services/[id]/upload`  | multipart archive upload         |
| `GET /api/services/[id]/logs`     | Server-Sent-Events log stream    |
| `GET /api/services/[id]/attach`   | interactive console session      |
| `GET /api/github/callback`        | GitHub App OAuth callback        |
| `POST /api/github/webhook`        | GitHub webhook receiver          |
