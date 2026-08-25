# Apps, projects and environments

## What it is

Four words that sound interchangeable and are not. An **App** is the thing that
runs. A **Folder** groups apps. A **Project** is a folder that also has
environments. An **Environment** is one isolated copy of a project's apps.

Nothing here is mandatory. A perfectly normal Deplo instance is a flat list of
apps and no folders at all.

## App

The deployable unit: a repository, an image, an archive or a Compose file
turned into a Docker stack named `deplo-<slug>` and fronted by Traefik.

An App owns its source, its build configuration, its domains, its environment
variables, its volumes and its deployment history. It may sit at the team's top
level, inside a Folder, or inside one Environment of one Project. Never more
than one of those at a time.

The **slug** is minted from the name at creation and then frozen: it is baked
into the stack name, the volume names (`deplo-<slug>-<volume>`) and the
generated hostname. The display name stays editable.

> In Compose, a "service" is one container inside a stack. That is a different
> thing from an App, and Deplo never calls an App a service.

### App status is intent, not observation

`status` records the last thing the control plane was **asked** to do. Six
values: `queued`, `building`, `active`, `error`, `stopping`, `idle`. There is no
stored "stopped" value: `idle` is it, and **Stopped** is just the grey label it
renders with.

Two important consequences:

- **`error` means the last deploy attempt failed**, not that the app is down. A
  failed redeploy leaves the previous stack serving traffic.
- What the interface shows is a live fold over that column, not the column. An
  `active` app whose containers are restarting renders as **restarting**,
  **degraded**, **unhealthy** or **down**, from a live probe. An app that
  telemetry does not mention at all is unknown, never failed.

## Folder

A team-wide grouping with a name, a colour and an owner. Folders nest.

Folders are also the unit of delegated access. The owner of a folder, or an
admin, can share it with a member and give them a capability set **that applies
inside that folder only**, and that set may be larger than the member's team
role. That is how "Marta runs Production and nothing else" is expressed without
widening what Marta can do everywhere else.

## Project

A **Project is an advanced folder whose contents are scoped per environment.**
That is the whole difference. It has an owner, a colour and an order like a
folder, and on top of that it owns Environments, each holding its own apps and
its own shared variables.

Two rules that catch people out:

- **A Project never nests** inside another Project, and **Folders never live
  inside a Project**.
- **A Project has no page of its own.** It is browsed on the Overview, by
  drilling in: `/?project=<id>&env=<envId>`. Old `/projects/<slug>` links
  redirect there.

## Environment

A first-class isolated deploy target inside a Project: its own containers, its
own URLs, its own git branch, its own variables. A new Project is seeded with
**Development**, **Preview** and **Production**, all renamable, and you can add
more.

The default environment (Production, as seeded) keeps the plain `deplo-<slug>`
stack key so existing live stacks are untouched. Every other environment gets
`deplo-<slug>__<envSlug>`, which is what keeps them from colliding on a host.

An Environment is also one of the three availability scopes of a
[shared variable](../guides/shared-variables.md): a variable scoped to an
environment is _suggested_ to the apps living there, and each app still links it
on purpose.

## Which one do I want

| Situation                                              | Use                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| A handful of apps, one of everything                   | Nothing. Leave them at the top level.                                     |
| "These six apps belong to the marketing site"          | A **Folder**                                                              |
| "Sara should manage those six and nothing else"        | A **Folder**, shared with her                                             |
| "I want staging and production of the same three apps" | A **Project** with two **Environments**                                   |
| "Every pull request should get its own copy"           | Not this. Use [pull request previews](../guides/pull-request-previews.md) |

A pull request preview is deliberately neither an App nor an Environment. It has
no team placement, no domains of its own, and no console, files, backups or
monitoring surface. It is an ephemeral stack that disappears when the pull
request closes.

## Limits and gotchas

- **Moving an app between teams is possible, moving its folder is not.** Folders,
  projects and shared variables belong to the source team and stay behind. Env
  vars, domains, deployments, volumes and basic-auth users travel with the app.
- **An app belongs to at most one Project.** Putting it in an environment takes
  it out of a folder, and the other way round.
- **Deleting a folder does not delete the apps in it** unless you say so in the
  confirmation. Deleting an app is always final.

## See also

- [Teams and capabilities](teams-and-capabilities.md) - who can see and do what
- [Roles and permissions](../guides/roles-and-permissions.md) - sharing a folder
- [Shared variables](../guides/shared-variables.md)
- [Glossary](../reference/glossary.md)
