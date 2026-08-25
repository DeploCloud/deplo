# Capabilities

## What it is

The full list of the 46 capabilities. One capability is **one action**, never a
bundle: if a name would cover two things an administrator might want to separate,
it is two capabilities.

A [role](../guides/roles-and-permissions.md) is a named set of these, owned by a
team. A [folder share](../guides/roles-and-permissions.md) is the same set
applied inside one folder, where it replaces the team role and may exceed it. An
[API token](../advanced/api-tokens-and-oauth.md) carries its own set, capped by
what its creator can still do.

Rows marked **!** are flagged **Sensitive** in the role editor.

## The floor

| Capability | What it allows                                                                    |
| ---------- | --------------------------------------------------------------------------------- |
| `view`     | **View the team.** Read-only access to apps, databases, deployments and settings. |

`view` is always on. Every member of a team has it and it cannot be taken away.

## By category

Categories exist so you can **find** a capability. There is no category-level
switch, on purpose: granting ten things with one click is how people grant nine
they did not mean to.

### Apps

Creating, shipping and running the team's apps.

| Capability               | What it allows                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `create_apps`            | **Create apps.** Add a new app from a repository, image, template or upload.                                                 |
| `deploy_apps`            | **Deploy apps.** Deploy, redeploy and cancel a running deploy.                                                               |
| `rollback_apps`          | **Roll back apps.** Put an app back on a previous deployment, with no rebuild.                                               |
| `control_apps`           | **Start & stop apps.** Start, stop, restart and reload a running app.                                                        |
| `configure_apps`         | **Configure apps.** Change an app's name, logo, deploy source, build settings, volumes, resource limits and auto-deploy.     |
| `delete_apps` **!**      | **Delete apps.** Permanently delete apps and their deployment history.                                                       |
| `move_apps`              | **Move & reorder apps.** Move an app into a folder, project or another team.                                                 |
| `open_app_console` **!** | **Open an app's console.** Run a shell inside a running app's container and attach to its process.                           |
| `manage_previews`        | **Manage pull request previews.** Turn pull request previews on, change their settings, and deploy, redeploy or destroy one. |
| `manage_crons` **!**     | **Manage cron jobs.** Create, edit and run scheduled commands inside an app or database container.                           |

### App configuration

What an app is reachable at, configured with and made of.

| Capability             | What it allows                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `manage_domains`       | **Manage domains.** Add, verify, route and remove custom domains, and pick their certificates.                |
| `manage_basic_auth`    | **Manage HTTP basic auth.** Put an app behind a username and password at the edge.                            |
| `manage_env`           | **Manage environment variables.** Add, edit, import and delete an app's variables and the team's shared ones. |
| `reveal_secrets` **!** | **Reveal secret values.** Read back the value of a masked variable, connection string or password.            |
| `read_app_files`       | **Browse app files.** Open and download the files in an app's storage directory.                              |
| `write_app_files`      | **Edit app files.** Create, edit, upload, rename and delete an app's files.                                   |

### Folders & projects

How the overview is organised.

| Capability              | What it allows                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `create_folders`        | **Create folders.** Add folders to group apps on the overview.                                                            |
| `organize_folders`      | **Organize folders.** Rename folders, nest them and share them with members.                                              |
| `delete_folders`        | **Delete folders.** Remove a folder (its apps move back out, they aren't deleted).                                        |
| `create_projects`       | **Create projects.** Add a project, which is a folder with environments of its own.                                       |
| `organize_projects`     | **Organize projects.** Rename projects and change their colour.                                                           |
| `delete_projects` **!** | **Delete projects.** Remove a project and everything scoped to its environments.                                          |
| `manage_environments`   | **Manage environments.** Add, rename, reorder and remove a project's environments (production, preview, and any you add). |

### Databases

Managed databases on the team's servers.

| Capability                    | What it allows                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `create_databases`            | **Create databases.** Provision a new managed database on one of the servers.                           |
| `configure_databases`         | **Configure databases.** Change a database's name, logo, image, exposure, resource limits and password. |
| `control_databases`           | **Start & stop databases.** Start, stop, restart and redeploy a database.                               |
| `delete_databases` **!**      | **Delete databases.** Permanently delete a database and its data volume.                                |
| `open_database_console` **!** | **Open a database console.** Run a database shell (psql, mysql, redis-cli) on the server.               |

### Backups & storage

Backup schedules and where they are stored.

| Capability                         | What it allows                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `manage_backups`                   | **Manage backups.** Create, edit, disable and run backup schedules on demand.                                                    |
| `restore_backups` **!**            | **Restore backups.** Restore a backup over a live app or database, replacing its current data.                                   |
| `delete_backups` **!**             | **Delete backups.** Permanently delete a single backup, removing the file it was restored from.                                  |
| `manage_backup_destinations` **!** | **Manage backup destinations.** Connect, test and remove the places backups are stored, and download the key that decrypts them. |

### Integrations & API

Everything deplo talks to on the team's behalf.

| Capability             | What it allows                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `manage_registries`    | **Manage container registries.** Connect and remove private image registries.                                     |
| `manage_git`           | **Manage Git connections.** Connect and disconnect the team's GitHub apps.                                        |
| `manage_tokens` **!**  | **Manage API tokens.** Mint and revoke the bearer tokens that drive deplo's API from outside the dashboard.       |
| `manage_mcp` **!**     | **Manage MCP access.** Decide whether AI agents may drive this team, and approve the web apps that connect to it. |
| `manage_notifications` | **Manage notifications.** Choose which events are announced and where they are sent.                              |

### Logs & monitoring

Seeing what the team's workloads are doing.

| Capability          | What it allows                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `view_logs`         | **View logs.** Read runtime and build logs for apps and databases.                              |
| `view_metrics`      | **View monitoring.** See live and historical CPU, memory, disk and network usage.               |
| `manage_monitoring` | **Change monitoring settings.** Turn metrics history on or off for servers, apps and databases. |
| `view_activity`     | **View the activity log.** Read the audit trail of what everyone in the team has done.          |

### Team administration

The team itself, its people and their access.

| Capability           | What it allows                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `manage_members`     | **Manage members.** Add and remove members, and assign each of them a role.                         |
| `manage_roles` **!** | **Manage roles.** Create, edit, reset and delete the roles on this page, including what they grant. |
| `manage_team`        | **Manage team settings.** Rename the team, change its settings and order the overview.              |
| `delete_team` **!**  | **Delete the team.** Permanently delete the whole team and everything in it.                        |

## Not capabilities

Three grants sit outside the list, because they are not team-scoped actions.

| Grant                                           | What it means                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instance admin**                              | Instance-wide. Unlocks Servers, Users and the Deplo instance settings. Granted by another instance admin from the member's **Advanced** tab |
| **Publish ports** (`canExposePorts`)            | May publish a container port on the host                                                                                                    |
| **Bind server folders** (`canMountHostVolumes`) | May use anything that reaches out of the container. See [Host access and privileges](../advanced/host-access-and-privileges.md)             |

**Two-factor is a policy, not a capability.** A team or a role can require it,
and a member who has not enrolled resolves nothing there at all.

## Retired names

Eight coarse capabilities were replaced by these fine-grained ones. Every stored
row was expanded into exactly what its old name already implied, so the split
granted and revoked nothing.

The old names (`deploy`, `manage_infra`, `manage_files`, `manage_s3`, and the
coarse spellings of `view`, `manage_domains`, `manage_env`, `manage_members`,
`manage_team`) are **still accepted from API clients** and expanded the same way.
They are never returned, and nothing new should use them.

## See also

- [Roles and permissions](../guides/roles-and-permissions.md) - building a role
- [Teams and capabilities](../concepts/teams-and-capabilities.md) - how the gates work
- [API tokens](../advanced/api-tokens-and-oauth.md)
