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

The web app calls the API same-origin; the Better Auth session cookie
(`deplo.session_token`, `__Secure-` prefixed over https) is sent automatically.
You never handle tokens in the UI. The active team comes from the `deplo_team`
cookie.

If the account has two-factor authentication, `login` returns
`requiresTwoFactor: true` and NO session; finish with `verifyTwoFactorLogin`.

### 2. API token (external clients)

Create a token in **Settings → API tokens**. It is shown **once** — store it
securely. Send it as a bearer token:

```bash
curl https://your-host/api/graphql \
  -H "Authorization: Bearer deplo_xxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ me { username } apps { name status } }"}'
```

A token carries **its own capabilities**, chosen when you create it — the same
fine-grained set a Role is built from. Its effective power is the intersection of
two things: what the token was granted, and what its creator can still do in that
team, so revoking a person's access also blunts every token they minted. An
optional **scope** narrows what it reaches, as a tree: whole teams, whole
projects, whole folders (subfolders included), or individual apps. Ticking a
node grants everything under it, now and later; ticking nothing means every team
its creator belongs to. Folders matter here — filing an app into one clears its
project link, so a folder is where most apps actually live, and a project scope
also covers the folders filed under it. Naming anything below a team narrows the
token inside that team, and the team-wide permissions it holds (managing
members, roles, registries, databases) stop applying there — naming several
whole teams restricts nothing inside them.

A token is a principal, not a stand-in for the person who minted it, so it never
reaches their **account**: the signed-in device list (`mySessions`,
`revokeSession`, `revokeOtherSessions`), the profile (`updateProfile`,
`updateEmail`, `changePassword`) and the two-factor settings all answer
`An API token can't access …` however many capabilities the token holds. Those
are dashboard actions taken by a person at a keyboard.

A POST must be `Content-Type: application/json`; anything else is refused with
**415**. GET still serves GraphiQL and query-over-GET.

A request acts in exactly ONE team. Send **`X-Deplo-Team: <team id or slug>`** to
pick which; without it the first team in the token's scope is used, and a team
the token doesn't hold is ignored rather than honoured. `myTeams` lists the ones
it may switch between. Every query and mutation is then filtered to that team
automatically.

Settings → API tokens ships templates — Read only, Deploy hook & CI, MCP & AI
agents, App automation, Root access — or you can start from scratch.

> **Breaking change:** `createToken` now takes an input object and a permission
> list: `createToken(input: { name: "ci", capabilities: [deploy_apps, view_logs] })`.
> There is no default: a token with no capabilities named is view-only. The scope
> is four optional lists on the same input — `teamIds`, `projectIds`,
> `folderIds`, `appIds` — and `updateToken` changes a live token's permissions or
> scope without re-minting it.

Unauthenticated requests resolve `me` to `null` and are rejected by any field
that requires a login (`Not authorized to resolve …`).

## Authorization

Fields are gated by the same capability model as the dashboard:

Capabilities are fine-grained — one action each, not bundles — so a role can ship
apps without being able to delete them, or read files without writing them. The
full list is the `Capability` enum in [`schema.graphql`](../../schema.graphql);
the ones you will meet most:

| Capability                                          | Covers                                              |
| --------------------------------------------------- | --------------------------------------------------- |
| `create_apps` · `deploy_apps` · `control_apps`       | create an app · deploy/redeploy/promote · start/stop |
| `configure_apps` · `delete_apps` · `move_apps`       | build & source settings · delete · folder/project/team |
| `open_app_console`                                   | shell into a running container                       |
| `manage_domains` · `manage_basic_auth`               | custom domains & routing · the edge password gate    |
| `manage_env` · `reveal_secrets`                      | variables · reading a masked value back              |
| `read_app_files` · `write_app_files`                 | browse/download · edit/upload/delete                 |
| `create_folders` · `organize_folders` · `delete_folders` | the overview's folders                          |
| `create_projects` · `organize_projects` · `delete_projects` · `manage_environments` | projects & their environments |
| `create_databases` · `configure_databases` · `control_databases` · `delete_databases` · `open_database_console` | managed databases |
| `manage_backups` · `restore_backups` · `manage_s3`   | schedules & runs · restoring over live data · buckets |
| `manage_registries` · `manage_git` · `manage_tokens` · `manage_notifications` | integrations & API access |
| `view_logs` · `view_metrics` · `manage_monitoring` · `view_activity` | logs, monitoring, the audit trail    |
| `manage_members` · `manage_roles`                    | who is in the team · what each role grants           |
| `manage_team` · `delete_team`                        | team settings · deleting the team                    |

Three names from the old coarse model — `deploy`, `manage_infra` and
`manage_files` — are still ACCEPTED on input (marked deprecated in the schema):
each expands to exactly the permissions it used to imply, so an existing script
keeps working unchanged. They are never returned. The other five old names
(`view`, `manage_domains`, `manage_env`, `manage_members`, `manage_team`) survived
the split as capabilities in their own right and mean exactly themselves.

Some queries/mutations require **instance admin** (global): managing all users,
minting registration links, the per-user admin editor, Docker cleanup
(`dockerCleanupPolicy`, `dockerCleanupRuns`, `updateDockerCleanupPolicy`,
`setServerCleanupExcluded`, `runDockerCleanupNow`) — one instance-wide policy over
hosts every team shares — and the instance's own settings (`instanceSettings`,
`setPanelUrl`, `checkPanelUrl`, `panelHttps`, `setPanelHttps`,
`serverCertificateAccounts`, `setCertificateEmail`):
the address this Deplo answers on, and the Let's Encrypt account every host's
proxy issues certificates under. The panel publishes ITSELF through its host's
proxy, so both are settings rather than install-time facts: `setPanelUrl` moves
the panel's route with the address and puts the old one back if the new address
does not answer, and `setPanelHttps(enabled: false)` serves the panel over plain
http - for an address that cannot get a certificate yet, where https means a
browser warning on a page nobody has logged into. Turning it off moves the route,
the stored address and the session cookie together; a `__Secure-` cookie is one a
browser will not send over http. On a Deplo installed before it published its own
route, the first change adopts that route instead of requiring a re-install.
A host's own TLS certificates are the same kind
of thing (`serverCertificates`, `addServerCertificate`, `removeServerCertificate`):
they front whatever any team runs on that server, they live in that host's proxy
rather than in Deplo, and the private key is write-only, with no read path. A
domain reaches one by setting its `certProvider` to `custom` - HTTPS with no ACME
resolver named - which, unlike `letsencrypt`, draws on no shared account and is
therefore not capped per team.

## Shape of the API

- **Queries** mirror the read layer: `apps`, `app(slug)`, `projects`
  (the containers), `environments(projectId)`, `sharedVars`, `sharedVarsForApp(appId)`,
  `deployments`, `databases`, `database(id)`, `databaseRuntime(databaseId)`,
  `databaseConsoleInfo`/`databaseLogsInfo`/`databaseShellLabel`, `domains`, `servers`,
  `serverMetrics`, `appMetrics(appId)`/`databaseMetrics(databaseId)` (live per-container
  resource usage for the Monitoring tab) and their `*MetricsHistory` seeds,
  `detectRepoFramework(repo, buildMethod, …)` (names the JavaScript framework in a
  GitHub repository *before* an App exists for it — what the new-app wizard shows
  while you pick a repo; an App carries the same answer on `App.framework`, re-derived
  by every deploy),
  `members`, `teamRoles` (the team's roles and exactly what each grants),
  `apiTokens`, `activity`, `me`, `viewerTeam`, …. Object
  types are navigable — e.g. `App.deployments`, `App.latestDeployment`.
- **Mutations** mirror every former server action: `createApp`, `redeploy`,
  `stopApp`, `createProject`, `createEnvironment`, `upsertEnvironmentEnv`,
  `addDomain`, `createDatabase`, `updateDatabase`, `restartDatabase`,
  `redeployDatabase`, `rebuildDatabase`, `updateDatabaseResources`, `updateDatabaseImage`,
  `rotateDatabasePassword`, `execDatabaseConsole`, `setSaveMetrics`,
  `setAppSaveMetrics(appId, enabled)`/`setDatabaseSaveMetrics(databaseId, enabled)`
  (the per-resource "Save metrics" switch, `manage_infra`, default off),
  `createToken`, `updateTeam`, `createRole`/`updateRole`/`resetRole`/`deleteRole`
  (a role edit applies to every member holding it), `login`, `logout`, ….
  On `updateRole` every optional field means "leave it as it is": omit
  `capabilities`, `requireTwoFactor` or `scope` and they are untouched, so a bare
  rename is a bare rename. Send the field to replace it, or `clearScope: true` to
  make the role reach the whole team again.
  `addExistingMember`/`updateMember` take a `roleId`; the older `role` +
  `capabilities` pair still works and lands on the matching role when there is
  one — never a role limited to part of the team, since that shape says nothing
  about reach.
- **Subscriptions** (SSE via graphql-yoga): `appStatus(slug)` and
  `databaseStatus(id)` — each emits the entity on every state change (initial
  snapshot, then live), so a client tracks provisioning/start/stop/deploy with
  no polling.

Mutations return the affected entity where natural (so a client needs no second
fetch), or `Boolean` for deletes/toggles, or a `String` for reveal-secret
operations (e.g. `revealConnection`, `rotateDatabasePassword` return the
connection string).

**A verdict is a return value, not an error.** Where a mutation asks another
system whether something works, the answer comes back in the payload and a
failure resolves normally — `testS3(id)` returns `S3TestResult { destination,
report }`, and `report.ok` is the verdict (`report.error` carries the storage
provider's verbatim message, `report.steps` the probe sequence). A client that
treats "the request succeeded" as "the bucket works" will report success over a
bucket that just refused it — which is exactly the bug the old
`testS3: S3Destination` shape caused in deplo's own UI. `s3TestReport(id)` reads
the stored verdict without re-probing.

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
| `POST /api/apps/[id]/deploy-hook/[token]` | deploy hook — a webhook sender posts a URL, it can't compose a query |

### Deploy hook

The one REST endpoint that takes an **API token** instead of the session cookie, so a git
provider, a CI job or a script can deploy an app:

```bash
curl -X POST -H "Authorization: Bearer deplo_your_token" \
  https://deplo.example.com/api/apps/prj_123/deploy-hook/<token>
```

Both secrets are required. The URL's `<token>` says which app (read it back with
`revealAppDeployHook`, replace it with `rotateAppDeployHook`, switch the hook off entirely
with `setAppDeployHookEnabled`); the bearer token says who, and must itself HOLD
`deploy_apps` in that app's team (the **Deploy hook & CI** template is exactly this set) —
the deploy runs through exactly the gates the dashboard button does. Answers `200` with the queued deployment:

```json
{ "deploymentId": "dpl_…", "appId": "prj_123", "status": "queued", "url": "https://…" }
```

`401` — no/invalid API token. `403` — the hook is switched off, or the token (or the member it
acts as) may not deploy this app. `404` — no such app, wrong URL token, the app belongs to
another team, or it is outside the token's scope.
