# What Deplo is

## What it is

Deplo runs your apps on servers you own, and does the operations work for you.
You give it a repository, a Docker image or a Compose file. It builds the code,
starts the containers, points a hostname at them, gets the TLS certificate,
keeps the logs, takes the backups and restarts what dies.

It is the experience the big cloud platforms give you, except the machine is
yours and the bill is your hosting bill.

## What you get on the first day

- **A live URL before you own a domain.** Every app is born with a working
  hostname like `shop-brave-otter-9487cf1e.nip.io` that resolves to your
  server with no DNS setup at all.
- **Push to deploy.** Connect GitHub (or GitLab, Bitbucket, Gitea) once, and a
  push to the tracked branch builds and releases.
- **Databases as a checkbox.** Postgres, MySQL, MariaDB, MongoDB, Redis and
  ClickHouse, provisioned on a server of your choice with a connection string
  you copy.
- **A way back.** Every build keeps its image, so a rollback re-runs the exact
  binary that worked, with no rebuild.
- **A team, not just you.** Several people, one instance, each with their own
  permissions, and a trail of who did what.

## How it works, in four lines

Deplo is two programs and one rule.

```
  Browser  ->  Deplo control plane           (the dashboard, this is what you log into)
                     |
                     |  gRPC over mutual TLS, certificate pinned
                     v
               deplo-agent on each server    (the only thing that runs Docker)
                     |
                     v
               Traefik + your containers
```

The **control plane** decides what should run. It renders the Compose file, the
routing rules and the ports, resolves and decrypts the environment variables,
then hands the result over. It never runs `docker`, never opens a shell and
never touches a host directly.

The **server agent** executes. One small Go binary per server, reached over
gRPC with mutual TLS, its certificate fingerprint pinned when the server is
enrolled. The machine Deplo itself runs on is just another server in the fleet,
agent and all, so there is no privileged local shortcut that only works there.

The full picture is in [How Deplo works](../concepts/how-deplo-works.md).

## What you need

| What             | Requirement                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A server         | Linux, `x86-64` or `arm64`, and root access for the length of one install command. Docker is installed for you if it is missing. |
| Ports            | `80` and `443` reachable from the internet, `3000` for the dashboard, `9443` on every server you add later.                      |
| A domain         | Optional. Useful, not required: the generated `nip.io` hostname works from the first deploy.                                     |
| Docker knowledge | None. It is available as an escape hatch, never as a prerequisite.                                                               |

## What Deplo is not

- **Not a hosting provider.** You bring the server. Deplo never bills you for
  compute, seats or build minutes.
- **Not a DNS provider.** You keep your registrar. Deplo tells you which record
  to create and checks that it resolves.
- **Not Kubernetes.** The unit is a Docker container on a host you picked, not a
  scheduled pod. There is no cluster to operate.
- **Not a black box.** The rendered Compose file, the routing labels and the
  build logs are all readable from the dashboard.

## See also

- [Install Deplo](install.md) - the one command, and what it puts on the box
- [How Deplo works](../concepts/how-deplo-works.md) - the two planes in detail
- [Glossary](../reference/glossary.md) - App, Project, Environment, Capability
