# How Deplo works

## What it is

Deplo is two programs with one rule between them. Understanding that split
explains almost every behaviour in the product: why a deploy can fail with
"the server is unreachable" instead of quietly building somewhere else, why the
dashboard cannot show you a secret, and why the machine Deplo runs on is not
special.

## The two planes

```
                   +--------------------------------------------------+
   Browser  <--->  |  Deplo control plane                             |
                   |  UI - GraphQL API - auth - Postgres - rendering  |
                   +----------------------+---------------------------+
                                          |
                                gRPC over mTLS, certificate pinned
                                          |
              +---------------------------+---------------------------+
              |                           |                           |
     +--------v--------+         +--------v--------+         +--------v--------+
     |  deplo-agent    |         |  deplo-agent    |         |  deplo-agent    |
     |  server 1       |         |  server 2       |         |  server 3       |
     |  +-----------+  |         |                 |         |                 |
     |  | Traefik   |  |         |   containers    |         |   containers    |
     |  | :80 :443  |  |         |   volumes       |         |   volumes       |
     |  +-----------+  |         |   builds        |         |   builds        |
     |   containers    |         |                 |         |                 |
     +-----------------+         +-----------------+         +-----------------+
```

**The control plane decides.** It is the dashboard you log into, written in
TypeScript. It holds the data, authenticates people, renders the Compose file
and the Traefik routing labels, picks the ports, resolves and decrypts the
environment variables, and hands the finished result over.

**The server agent executes.** One Go binary per server, `deplo-agent`. It is
the only thing anywhere that runs `docker`, touches the filesystem or opens a
shell. Builds, deploys, log streaming, the web console, metrics, the files
browser, backups, restores, disk cleanup and volume copies all go through it.

## The rule

**The control plane never touches a Docker socket or a host directly.**

Every host-coupled action takes the same path:

```
UI  ->  GraphQL  ->  the data layer  ->  connectAgent(serverId)  ->  the agent
```

There is exactly one way to dial an agent, it uses mutual TLS, and the agent's
certificate fingerprint is pinned when the server is enrolled.

Three consequences worth knowing:

- **The machine Deplo runs on is just another server in the fleet.** It runs the
  agent like every other host, and Deplo talks to it over the network like every
  other host. There is no in-process shortcut for "local", which means the code
  path you use every day is the one a remote server uses.
- **An unreachable agent is a hard error.** Every deploy starts with a live
  handshake. If it does not answer, the deploy fails and says so. It never
  silently falls back to building somewhere else.
- **The control plane container must never get the Docker socket.** It is the
  part reachable from the internet, and that mount is root on the box for
  whoever reaches it. Traefik does not get one either: it reads container events
  through a read-only socket proxy on an internal network.

## What Traefik does

One reverse proxy per server, in a container called `deplo-traefik`, holding
ports `80` and `443`. Deplo writes its routing rules and gets out of the way.

Every hostname you add becomes a router. A router carries the rule
(`Host(...)`, optionally with a path), the entry point (`web` for plain HTTP,
`websecure` for HTTPS), the certificate resolver when there is one, and the
middleware chain (basic auth, path stripping, redirects). Certificates are
issued by Let's Encrypt over an HTTP challenge and renewed by Traefik itself.

The proxy's stack file on the host is edited in place, comments included, never
regenerated from a template. Flags an operator added by hand survive.

## Where the data lives

**Postgres is the only control-plane store.** Apps, teams, domains, deployment
history, encrypted secrets, activity: all of it is rows in about 55 tables.
There is no document store and no file-based state, and the schema migrates
itself at boot.

**Your application data lives on the servers**, in Docker volumes the agent
manages. It is never copied into the control plane, except in transit as
ciphertext when a backup goes to a destination on a different host, because
agents cannot dial each other.

## How secrets move

Secrets are encrypted at rest with AES-256-GCM, using keys derived from
`DEPLO_SECRET`. They are **write-only**: the ciphertext is never projected into
an API response, and no screen has a "show secret" button except two deliberate
ones (a basic-auth password and a backup recovery key).

**The agent never holds the encryption key.** The control plane decrypts at the
deploy edge and sends plaintext inside the mutual-TLS call, either as part of
the rendered stack or as a `0600` environment file next to it.

## What this means day to day

| If you see                                      | It is because                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| A deploy failed with "agent unreachable"        | The rule. No fallback build ever happens.                                              |
| A server card says **warning**                  | The agent is up and trusted, but Docker is not answering there, so nothing can deploy. |
| A secret you set cannot be read back            | Write-only by design. Delete and set it again to change one.                           |
| The rendered Compose file shows `***`           | Masked on the way out, values and the basic-auth hash alike.                           |
| Two apps on one server reach each other by name | They share the `deplo` Docker network.                                                 |

## See also

- [Servers and the agent](servers-and-the-agent.md) - enrollment, health, readiness, roles
- [What happens on a deploy](what-happens-on-a-deploy.md) - the trace, step by step
- [Ports, networks and files](../reference/ports-networks-and-files.md)
- [`docs/adr/0006`](../adr/0006-server-agent-is-a-per-host-go-binary.md) - the decision this all rests on
