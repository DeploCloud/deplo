# Deplo documentation

Deplo is a self-hosted deploy platform. You point it at a repository, pick a
server you own, and it builds the code, starts it in Docker, routes a hostname
to it through Traefik and issues the certificate. Nothing on the happy path
requires you to open a shell on the server.

This is the full manual: every screen, every setting, and the limits that are
easy to trip over.

## Start here

Never used Deplo? Read these four pages in order. It takes about twenty minutes
and ends with a live app.

1. [What Deplo is](getting-started/what-is-deplo.md) - what it does, what you need
2. [Install Deplo](getting-started/install.md) - one command on a fresh Linux box
3. [Deploy your first app](getting-started/first-app.md) - repository to live URL
4. [Add a domain](getting-started/add-a-domain.md) - your own hostname, with HTTPS

## The sections

| Section                              | What is in it                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [getting-started/](getting-started/) | Install Deplo and ship one app. Read once, in order.                                            |
| [concepts/](concepts/)               | How Deplo is put together. Read when you want to know why something behaves the way it does.    |
| [guides/](guides/)                   | One page per feature. The part you come back to.                                                |
| [advanced/](advanced/)               | Expert surfaces: Compose stacks, host access, build servers, MCP, tokens.                       |
| [operations/](operations/)           | Running the instance itself: upgrades, disaster recovery, instance administration.              |
| [reference/](reference/)             | Tables to look things up in: environment variables, ports, capabilities, the API, the glossary. |
| [troubleshooting/](troubleshooting/) | Organised by symptom, not by feature.                                                           |

Two folders here are written for people working on Deplo itself, not for people
using it: [`adr/`](adr/) records the architecture decisions, and
[`agents/`](agents/) holds maintainer process notes. [`research/`](research/) is
a historical archive and no longer describes the running system.

## I want to

| Task                                                   | Page                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Deploy from GitHub, GitLab, Bitbucket or Gitea         | [Deploy from Git](guides/deploy-from-git.md)                                      |
| Deploy a ready-made image from a registry              | [Deploy a Docker image](guides/deploy-a-docker-image.md)                          |
| Deploy WordPress, n8n, Ghost or another ready stack    | [Deploy from a template](guides/deploy-from-a-template.md)                        |
| Deploy a project that is not in Git                    | [Upload your code](guides/upload-your-code.md)                                    |
| Change the build command, the port, the root directory | [Build settings](guides/build-settings.md)                                        |
| Deploy automatically on every push                     | [Automatic deployments](guides/automatic-deployments.md)                          |
| Go back to the version that worked                     | [Rollbacks](guides/rollbacks.md)                                                  |
| Put my own domain on an app, with HTTPS                | [Domains and HTTPS](guides/domains-and-https.md)                                  |
| Set an API key or a database URL                       | [Environment variables](guides/environment-variables.md)                          |
| Reuse one variable across many apps                    | [Shared variables](guides/shared-variables.md)                                    |
| Run Postgres, MySQL, MongoDB, Redis or ClickHouse      | [Databases](guides/databases.md)                                                  |
| Take backups and restore them                          | [Backups and restore](guides/backups-and-restore.md)                              |
| Keep uploaded files across deploys                     | [Persistent storage](guides/persistent-storage.md)                                |
| Read what my app is printing                           | [Logs](guides/logs.md)                                                            |
| Watch CPU, memory and disk                             | [Monitoring](guides/monitoring.md)                                                |
| Get told when something breaks                         | [Notifications and alerts](guides/notifications-and-alerts.md)                    |
| Run a command on a schedule                            | [Cron jobs](guides/cron-jobs.md)                                                  |
| Give every pull request its own URL                    | [Pull request previews](guides/pull-request-previews.md)                          |
| Open a terminal inside a container                     | [Console and files](guides/console-and-files.md)                                  |
| Add somebody to my team                                | [Teams and members](guides/teams-and-members.md)                                  |
| Give somebody access to one folder only                | [Roles and permissions](guides/roles-and-permissions.md)                          |
| Turn on two-factor or add a passkey                    | [Account security](guides/account-security.md)                                    |
| Deploy to a second server                              | [Add a server](guides/add-a-server.md)                                            |
| Free up disk on a server                               | [Server settings](guides/server-settings.md)                                      |
| Connect GitHub, GitLab, Bitbucket or Gitea             | [Git providers](guides/git-providers.md)                                          |
| Pull from a private registry                           | [Container registries](guides/container-registries.md)                            |
| Move everything off Dokploy                            | [Move from Dokploy](guides/move-from-dokploy.md)                                  |
| Paste a `docker-compose.yml`                           | [Compose apps](advanced/compose-apps.md)                                          |
| Let an AI agent drive my infrastructure                | [MCP server](advanced/mcp-server.md)                                              |
| Call Deplo from a script or CI                         | [API tokens](advanced/api-tokens-and-oauth.md), [API reference](reference/api.md) |
| Update Deplo to a new version                          | [Upgrade](operations/upgrade.md)                                                  |
| Survive losing the server                              | [Disaster recovery](operations/disaster-recovery.md)                              |
| Take a server off the fleet, or remove Deplo entirely  | [Remove a server or uninstall](operations/remove-a-server-or-uninstall.md)        |

## Conventions in these pages

- **Bold** is a control you can click, spelled exactly as the interface spells it.
- `Monospace` is something you type, or a name from a file or the API.
- A page marked **Beta** matches a feature the interface also marks Beta. It
  works, it is in use, and its edges may still move.
- Every guide ends with the two or three failures that actually happen, and
  links into [troubleshooting/](troubleshooting/) for the rest.
