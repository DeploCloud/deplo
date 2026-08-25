# Compose apps

## What it is

Pasting a `docker-compose.yml` and letting Deplo run it: several containers, a
network between them, whatever the vendor's README told you to run. Deplo adds
routing, TLS, variables, volumes and backups on top.

Use it for software that ships as a Compose stack, and for your own multi-service
setups. If you just want one container from an image,
[Deploy a Docker image](../guides/deploy-a-docker-image.md) is simpler.

## How it works

Your YAML is treated as **authored input, not as a trusted document**. Deplo
parses it, checks it, folds in what it must, and ships the result to the agent.

What it folds in:

- **The shared `deplo` network**, so your services can reach other apps and
  managed databases by name.
- **Traefik labels** for each domain you added, pointing at the service you
  named on that domain.
- **Your environment variables**, injected into every service as pass-through
  entries whose values ride in a `0600` env file next to the stack.
- **Your storage rows**, mounted into the service you named.

What it drops or refuses:

- **Hand-written `aliases:` on the shared network are dropped.** Every container
  on that network already registers its service name as a DNS alias, and Docker
  round-robins a name two containers both claim.
- **A service named `deplo`, `postgres`, `traefik` or `deplo-traefik` on the
  shared network is refused outright.** Those names belong to the platform, and
  claiming one collects somebody else's traffic, the control plane's database
  connections included. The check resolves the network **by name**, so pointing
  at it under a different key does not get around it.

## Create one

1. **Add new**, then **New app**, then **From Scratch**.
2. In the **Source** card pick the **Compose** tab.
3. Paste your file. The editor lints as you type and tells you what will be
   rewritten, what needs a permission and what will be refused.
4. Name it, pick a server, then **Deploy**.

You can edit the file later in **Settings -> Deployments**.

## What is different about a Compose app

| Difference                   | What it means                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Domains name a Container** | A domain routes to one Compose service. That field appears instead of the port override, because your file already declares the ports |
| **No rollbacks**             | There is no single image Deplo built, so there is nothing to re-run                                                                   |
| **No build server**          | Same reason                                                                                                                           |
| **Storage names a service**  | Every storage row says which service to mount into. A name your file does not contain is a hard error, never a silent remount         |
| **Cron jobs name a service** | Blank means the stack's main container                                                                                                |

## Extra flags

**Settings -> Deployments -> Advanced settings -> Extra compose flags** passes
additional flags to `docker compose up`, exactly as typed. It is additive only:
anything that would change the project name, the stack file or the env file is
refused, because those are how Deplo finds your stack again.

## Limits and gotchas

- **`version:` and `ports:` are usually noise here.** Deplo routes through
  Traefik, so publishing a host port is rarely what you want and needs the
  port-exposure grant.
- **The values of your variables do not appear in the file.** They ride in the
  env file, which is why a rendered stack shown back to you has bare `- KEY`
  entries.
- **A rendered stack is masked on display**, values and the basic-auth hash
  alike.
- **Everything that reaches out of a container is gated.** See
  [Host access and privileges](host-access-and-privileges.md) for the full list,
  which is longer than most people expect.
- **The agent does not re-validate your YAML.** The checks that matter happen
  here, on save and on deploy.

## If it does not work

- **The editor refuses a service name** - it is one of the four reserved names
  on the shared network. Rename the service.
- **A service cannot resolve another one** - they must be in the same stack, or
  both on the shared network with distinct names.
- **`compose up` fails on a flag** - your extra flags. They are passed verbatim.
- **Domains show no container to pick** - the file did not parse. Fix the lint
  errors first.

## See also

- [Host access and privileges](host-access-and-privileges.md)
- [Deploy from a template](../guides/deploy-from-a-template.md) - Compose stacks somebody already wrote
- [Persistent storage](../guides/persistent-storage.md)
- [Domains and HTTPS](../guides/domains-and-https.md)
