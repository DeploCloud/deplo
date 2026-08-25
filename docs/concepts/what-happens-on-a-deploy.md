# What happens on a deploy

## What it is

The full trace of one deploy, from the thing that triggered it to a container
serving traffic. Reading it once makes most failure messages self-explanatory.

## 1. Something triggers it

| Trigger                                     | Comes from                                                    |
| ------------------------------------------- | ------------------------------------------------------------- |
| **Deploy** or **Redeploy** in the dashboard | A person                                                      |
| A push to the tracked branch                | The git provider's webhook                                    |
| A new tag                                   | The same webhook, when the trigger is set to tags             |
| A `POST` to the app's deploy hook URL       | CI, a script, a provider Deplo cannot register a webhook with |
| A pull request opened or updated            | Previews, if they are on                                      |
| **Rollback**                                | A person, and it skips almost all of what follows             |
| The MCP server or the GraphQL API           | A token holding `deploy_apps`                                 |

An automatic trigger can be filtered before it starts: **watch paths** skip the
deploy if the push touched nothing under the globs you listed, and **skip
unchanged deployments** skips it if nothing under the root directory changed.
A manual redeploy always runs.

## 2. It waits for a slot

Every server has a deploy concurrency, `1` by default, so deploys to the same
machine queue rather than fighting over CPU and the build cache. Deploys to
other servers run in parallel. Two deploys of the same app never overlap.

A queued deploy shows its position in the build log while it waits. If the app
builds on a [build server](../advanced/build-servers.md), it takes a slot on
**that** machine, because that is where the cost is.

## 3. The agent fetches the source

The control plane opens a mutual-TLS connection to the agent on the target
server and hands over the job. This is where credentials are decrypted:
plaintext exists only inside that call, and the agent never holds the key.

- **Git sources** are cloned by the agent, on the host, with the token from the
  git connection. `--recurse-submodules` is added if the app asks for it.
- **Upload sources** use the archive you uploaded.
- **Docker image** and **Compose** sources skip this step entirely.

## 4. The framework is detected

For Nixpacks and Railpack builds, Deplo re-derives the framework from
`package.json` and the root configuration **on every deploy**. It is never a
stored setting.

Detection produces the install, build and start commands and the default
container port. Anything you typed by hand wins over it, permanently. Dockerfile
and Static builds skip detection: you named everything already.

## 5. The image is built

| Method                 | What happens                                                                    |
| ---------------------- | ------------------------------------------------------------------------------- |
| **Nixpacks** (default) | Generates a build plan from the detected language and framework                 |
| **Railpack**           | The same idea, a different builder, with its own pinned version                 |
| **Dockerfile**         | Your `Dockerfile`, with your build context and optionally a `--target` stage    |
| **Static**             | Builds, then serves the output directory, with an optional single-page fallback |

Every resolved environment variable is available **during** the build, not just
at run time, so build-time inlined configuration such as `NEXT_PUBLIC_*` works.
The generated Dockerfile declares them as `ARG` and `ENV`.

The image stays on that host. Deplo pushes to no registry, which is why a
rollback needs the image still to be there.

Build output streams to the dashboard as it happens, survives a page reload and
survives a control plane restart. It is stored with a cap, so a runaway build
cannot fill the disk.

## 6. The environment is resolved

Four layers fold together, lowest priority first:

```
instance-wide variables
  <  the app's own variables
       <  a shared variable the app has linked
            <  a preview override   (previews only)
```

Every layer carries a type. A **secret**-typed value is write-only, and a
preview of a **fork** never receives one, whatever the settings say.

## 7. The stack is rendered

This happens on the control plane, never on the host. It produces:

- **The Compose file.** One service for a single-image app, or your authored
  Compose stack with Deplo's own entries folded in.
- **The Traefik labels.** One router per domain, carrying the rule, the entry
  point, the certificate resolver and the middleware chain. Path routers are
  given priority above whole-host ones, longest prefix first.
- **The port.** One container port per app, plus any per-hostname override.
- **The volumes, the resource limits and the mounts.**

The result is opaque YAML by the time it reaches the agent. Compose and routing
logic never live on the host side.

## 8. The agent brings it up

The agent writes the stack and, when there are secrets, a `0600` environment
file beside it, then runs Compose. Containers join the shared `deplo` network,
which is how apps and databases reach each other by name.

Traefik notices the new labels through its read-only socket proxy and starts
routing. If the domain asked for a certificate, Traefik requests it on the first
HTTPS request.

## 9. The result is recorded

The deployment row gets its final status, its image reference, its duration and
its logs. The app's status moves to `active`, or to `error` if the build or the
bring-up failed.

Older images beyond the app's **rollbacks kept** setting (default `3`) become
eligible for removal by the server's disk cleanup. That number is the real
retention: Deplo pushes to no registry, so a pruned image is gone.

## What a deploy does not do

- **It does not touch your data.** Volumes are reattached, never recreated.
- **It does not change the slug**, the volume names or the app's identity.
- **It does not roll back on failure.** A failed deploy leaves the previous
  stack running, which is why `error` and "the site is down" are different
  facts.

## A rollback is much shorter

Steps 3 to 6 are skipped. Deplo re-runs an existing image with the **current**
configuration: the code goes back, the variables, domains, volumes and limits do
not. It is recorded as a real deployment of its own, with its own logs.

## See also

- [Build settings](../guides/build-settings.md)
- [Automatic deployments](../guides/automatic-deployments.md)
- [Rollbacks](../guides/rollbacks.md)
- [Environment variables](../guides/environment-variables.md)
- [Deploys and builds troubleshooting](../troubleshooting/deploys-and-builds.md)
