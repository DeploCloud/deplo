# Glossary

Deplo's vocabulary, one line each. Where two words could mean the same thing,
Deplo picks one and uses only that one, so these definitions are also the
spelling rules.

| Term                     | Means                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Active team**          | The team you are currently looking at, chosen in the top bar. Every list is filtered by it                                                                                                                |
| **Agent**                | See **server agent**. Never used on its own in the interface                                                                                                                                              |
| **Alert**                | Something Deplo tells you about, delivered to a notification channel. Distinct from the **Activity** trail, which is looked up later                                                                      |
| **API token**            | A `deplo_` bearer credential that is a principal with its own capabilities, capped by what its creator can still do                                                                                       |
| **App**                  | The deployable unit: a repository, image, archive or Compose file running as a Docker stack behind Traefik. Never called a service or a project                                                           |
| **App status**           | What the control plane was last asked to do: `queued`, `building`, `active`, `error`, `stopping`, `idle`. `idle` is the stopped state, and `error` means the last deploy failed, not that the app is down |
| **Backup**               | A schedule: what to copy, where, how often, how many to keep                                                                                                                                              |
| **Backup destination**   | Where artifacts go. An S3-compatible bucket, or a folder on a server                                                                                                                                      |
| **Backup run**           | One execution of a schedule, producing one artifact                                                                                                                                                       |
| **Basic auth**           | Username and password in front of every domain of an app. Set under **Settings -> Access**                                                                                                                |
| **Bootstrap token**      | The single-use token that lets a new server enroll. Hashed at rest, about an hour                                                                                                                         |
| **Build server**         | A server that compiles images for hosts it does not run on                                                                                                                                                |
| **Capability**           | One action a member may take. There are 46, and `view` is the always-on floor. Never called a permission, a scope or a grant                                                                              |
| **Certificate provider** | Where a domain's TLS certificate comes from: none, Let's Encrypt, Cloudflare, or one installed on the server                                                                                              |
| **Connected client**     | A web AI application that reached Deplo through the OAuth consent screen                                                                                                                                  |
| **Control plane**        | The panel: the dashboard, the API, the database and the rendering. It never runs Docker                                                                                                                   |
| **Cron job**             | A command run on a schedule inside a container, tracked by the agent                                                                                                                                      |
| **Deploy hook**          | A per-app URL that triggers a deploy. Needs both the URL and a bearer token                                                                                                                               |
| **Deploy key**           | The stack name a deploy targets, for example `deplo-shop__staging`                                                                                                                                        |
| **Deployment**           | One build and release, with its own logs, status and image                                                                                                                                                |
| **Domain**               | One routing row, keyed on hostname plus path                                                                                                                                                              |
| **Environment**          | An isolated deploy target inside a Project, with its own apps, branch and variables                                                                                                                       |
| **Folder**               | A team-wide grouping with an owner, which nests and can be shared                                                                                                                                         |
| **Framework**            | What Deplo detected in your repository. Re-derived on every deploy, never stored                                                                                                                          |
| **Git connection**       | Stored credentials for one git host, reused by every app deploying from it                                                                                                                                |
| **Instance admin**       | A flag on an account that unlocks Servers, Users and the instance settings. Not a team capability                                                                                                         |
| **Instance owner**       | The tier above instance admin, immutable to every hand but its own                                                                                                                                        |
| **MCP server**           | The endpoint an AI agent connects to, exposing 78 tools that run against the same schema and the same gates a person gets                                                                                 |
| **Membership**           | A person's link to a team, carrying a role                                                                                                                                                                |
| **Migration source**     | A server that hosts nothing, installed only to import from another platform. The one server Deplo uninstalls itself from                                                                                  |
| **Preview**              | See **pull request preview**                                                                                                                                                                              |
| **Preview override**     | A variable that takes a different value in previews only                                                                                                                                                  |
| **Primary domain**       | The one hostname shown as an app's production URL. Exactly one per app                                                                                                                                    |
| **Primary owner**        | The founder of a team, immutable to every other hand and transferable only by them                                                                                                                        |
| **Project**              | An advanced folder that owns Environments. Never nests, and has no page of its own                                                                                                                        |
| **Pull request preview** | An ephemeral stack for one open pull request, at a deterministic URL, destroyed when it closes                                                                                                            |
| **Recovery key**         | The private half of a backup destination's encryption key. One of only two secrets Deplo will show you                                                                                                    |
| **Registration link**    | A single-use link that lets a new person create an account and their own team. Valid 24 hours                                                                                                             |
| **Role**                 | A named capability set owned by a team. Editing one rewrites its members' capabilities immediately                                                                                                        |
| **Rollback**             | Re-running a past deployment's exact image, with current configuration                                                                                                                                    |
| **Secret variable**      | A write-only, immutable environment value. There is no reveal path                                                                                                                                        |
| **Server**               | A machine in the fleet. Instance-wide, never team-owned                                                                                                                                                   |
| **Server agent**         | The Go binary on each host, the only thing anywhere that runs Docker                                                                                                                                      |
| **Server health**        | An observation from the last handshake: `provisioning`, `online`, `warning`, `error`, `offline`. A cache, never a gate                                                                                    |
| **Server readiness**     | A live, never-stored report on whether a host is complete enough to deploy to                                                                                                                             |
| **Shared variable**      | A team-owned variable that apps opt into with a link. Scopes only suggest                                                                                                                                 |
| **Storage-only server**  | A server that holds backups and runs nothing                                                                                                                                                              |
| **Team**                 | An isolated workspace owning apps, databases, domains, variables and people                                                                                                                               |
| **Template**             | A catalogue entry Deplo turns into an app. A family of one or more **variants**                                                                                                                           |
| **Volume**               | Disk space Deplo creates and keeps for an app. One of three storage kinds, alongside **File** and **Bind**                                                                                                |

## Words Deplo does not use

| Not this                                   | Because                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Service                                    | A Compose service is one container inside a stack. The deployable unit is an **App** |
| Permission, scope, grant                   | The word is **Capability**                                                           |
| Node, worker, daemon                       | The word is **server agent**, or "the owning server"                                 |
| Current team, selected team                | The word is **active team**                                                          |
| Stopped, as a stored value                 | The stored value is `idle`. "Stopped" is only the label                              |
| Container, group, workspace, for a Project | A **Project** owns environments; those words do not carry that                       |

## See also

- [Apps, projects and environments](../concepts/apps-projects-and-environments.md)
- [Teams and capabilities](../concepts/teams-and-capabilities.md)
- [Capabilities](capabilities.md)
