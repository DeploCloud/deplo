# Server settings

## What it is

Everything you can change about one machine in the fleet: which teams may use
it, how many deploys run at once, disk cleanup, restarts, its address and its
certificates.

**Settings -> Servers**, then open a server. Instance admins only.

## How it works

Each tab talks to that server's agent. Nothing here reaches into the host any
other way, and the control plane never opens a shell.

The tabs are **Overview**, **Access**, **Certificates**, **Cleanup**,
**Maintenance** and **Advanced**.

## Overview

Specifications (CPU, memory, disk, Docker version), the health chip, the agent
version, and:

| Setting                    | What it does                                                                  |
| -------------------------- | ----------------------------------------------------------------------------- |
| **Concurrent deployments** | How many deploys may run at once on this host. Default `1`, so they serialize |
| **Build concurrency**      | The same for builds when this machine is a build server                       |

Raising concurrency past what the machine can take makes every deploy slower,
not faster. One is a sane default for a small VPS.

## Access

**Team access**: every team, or a chosen list. New servers are open to every
team, so a team that adds an app can pick it. **Save access** applies it.

Narrowing access does not move anything already deployed there.

## Certificates

Certificates you installed yourself, for wildcards, a company CA, or names no
HTTP challenge can reach. They live in that host's Traefik stack, Deplo keeps no
copy, and the private key has no read path. **Nothing renews them.** See
[Custom certificates](../advanced/custom-certificates.md).

## Cleanup

Reclaiming disk. This is the setting people wish they had found earlier.

**One schedule for the whole instance**, and individual hosts opt **out** of it,
so a server you add tomorrow can never silently go unswept.

| Scope                     | Removes                                               |
| ------------------------- | ----------------------------------------------------- |
| **Build cache**           | BuildKit cache older than the minimum age             |
| **Dangling images**       | Untagged layers nothing references                    |
| **Orphaned build caches** | Cache from builders that no longer exist              |
| **Unused app images**     | Old images of your apps, past **Images kept per app** |
| **Leftover app files**    | Directories of apps that no longer exist              |

| Control                 | Note                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| **Schedule**            | Cron, in UTC                                                                               |
| **Minimum age (hours)** | Gates the cache scopes only                                                                |
| **Images kept per app** | Interacts directly with [rollbacks](rollbacks.md): a pruned image cannot be rolled back to |
| **Reclaim disk now**    | Runs immediately and ignores the opt-out list                                              |
| **Recent cleanups**     | History, with what each run actually freed                                                 |

**What it deliberately never does**: `system prune`, container prune, volume
prune, network prune. On a Deplo host a _stopped_ app is a live app, and a
dangling volume may hold somebody's data.

## Maintenance

| Action              | What it does                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Restart Traefik** | Restarts the proxy on this host                                                                                |
| **Restart**         | Restarts the workloads                                                                                         |
| **Restart all**     | Both                                                                                                           |
| **Restart Deplo**   | Only on the host running the control plane. It restarts the panel itself                                       |
| Timezone            | The host's timezone, with **Save timezone**. Cron jobs use their own zone, so this is for the host's own clock |

## Advanced

| Setting                                | What it does                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Host details**                       | What the agent reports about the machine                                                                                                               |
| **Change address**                     | The address the control plane dials. Use it when the IP changes                                                                                        |
| **Agent port**                         | Default `9443`                                                                                                                                         |
| **Install command**                    | The command to re-run on the host, for reinstalling or repairing the agent                                                                             |
| **Domain**, **Password**, **Generate** | Publish that host's Traefik dashboard on a domain behind basic auth. Turning it on recreates the Traefik container, because it is static configuration |
| **Docker data**                        | Where Docker keeps its data on this host                                                                                                               |
| **Remove server**                      | Danger zone. See below                                                                                                                                 |

## Removing a server

**Removing is trust revocation, not an uninstall.** The pinned certificate is
cleared and Deplo never talks to that machine again. It does not reach in and
remove containers, because by then it may not be able to.

Deplo prints a one-line uninstall command to run on the host if you want the
agent, its Traefik and its state directory gone. See
[Remove a server or uninstall](../operations/remove-a-server-or-uninstall.md).

The machine running the control plane cannot remove itself.

## Limits and gotchas

- **Health is a cache, not a gate.** Past a staleness window the page shows
  **Unknown** rather than a stale green. Deploys gate on a live handshake.
- **Cleanup and rollbacks fight over the same images.** If rollbacks stop
  working, **Images kept per app** is too low for the app's **Keep**.
- **Restarting Traefik drops connections** for a moment on every app on that
  host.
- **Changing the address does not move anything.** It only changes how Deplo
  dials.

## If it does not work

- **The card says warning** - the agent is up, Docker is not answering there.
  Check the Docker service on the host.
- **Cleanup frees nothing** - the minimum age is protecting everything, or the
  only large thing on disk is images your apps still use.
- **A restart action fails** - the agent is unreachable. Health and readiness
  will say so.
- More in [Servers and agents](../troubleshooting/servers-and-agents.md).

## See also

- [Add a server](add-a-server.md)
- [Server roles](../advanced/server-roles.md)
- [Custom certificates](../advanced/custom-certificates.md)
- [Upgrade](../operations/upgrade.md) - agent updates
