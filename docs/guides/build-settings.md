# Build settings

## What it is

How your source becomes a container image: which builder runs, what commands it
runs, and which port the result listens on. Everything here lives in
**Settings -> Deployments**, and most apps never need to touch it.

## How it works

For a source Deplo builds, it re-derives the framework from `package.json` and
the root configuration **on every deploy**. Detection is never stored, so
upgrading your framework changes the build without you editing anything.

Anything you type by hand is stored, and it wins from then on. The fields sit
empty and show the detected value as a placeholder, which is how you can always
tell "detected" from "set by me". Clearing a field hands it back to detection.

## The four build methods

Pick one under **Build method**.

| Method                 | Use it when                                                     | Fields it adds                                                        |
| ---------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Nixpacks** (default) | Normal application code, any common language                    | none                                                                  |
| **Railpack**           | The same job, different builder. Try it if Nixpacks mis-detects | **Builder** version                                                   |
| **Dockerfile**         | You already have a `Dockerfile` and want it used exactly        | **Dockerfile path**, **Build context path**, **Build stage (target)** |
| **Static**             | The build produces plain files to serve                         | **Publish directory**, **Single-page application**                    |

**Single-page application** makes unmatched paths fall back to `index.html`,
which is what a client-side router needs.

Dockerfile and Static skip framework detection entirely. You have already said
what happens.

## The fields everyone eventually uses

| Field               | What it does                                                                   |
| ------------------- | ------------------------------------------------------------------------------ |
| **Root Directory**  | The subdirectory to build from. A monorepo gives each app its own package here |
| **Build command**   | Overrides the detected build step, for example `npm run build:prod`            |
| **Start command**   | Overrides the detected start step, for example `node dist/server.js`           |
| **Node.js version** | Pins the runtime instead of taking the detected default                        |
| **Container port**  | The port your process listens on inside the container                          |

Click **Save build settings**. Saving does not deploy: click **Redeploy** when
you want the change to take effect.

### The port is the one people get wrong

Deplo routes traffic to exactly one port per app, and detection sets a sensible
default per framework (Vite `4173`, Angular `4200`, and so on). If the container
starts fine and the URL times out, this is nearly always why.

Your process must also listen on `0.0.0.0`, not `127.0.0.1`. A server bound to
localhost inside a container is unreachable from outside it.

A single hostname can override the port for itself, which is how one app can
serve an API on one domain and a dashboard on another. That override lives in
**Domains**, not here.

## Build cache

Under **Advanced settings**, **Build cache** is on by default. The cache lives
on the **server**, one BuildKit cache shared by every app on that host, which is
why a first build is slow and later ones are not.

Two controls:

- The switch turns caching off for this app only.
- **Clear build cache** arms a one-shot clear, applied on the next build.

Pruning the cache on disk is not this switch's job. That is
[disk cleanup](server-settings.md) on the server.

## Advanced settings you probably do not need

| Setting                 | What it does                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Build server**        | Compile on a different machine than the one that runs the app. Beta. See [Build servers](../advanced/build-servers.md)                                                  |
| **Extra compose flags** | Additional flags passed to `docker compose up`, exactly as typed. Additive only: anything that would change the project name, the stack file or the env file is refused |
| **Deploy hook**         | A URL that triggers a deploy. See [Automatic deployments](automatic-deployments.md)                                                                                     |
| **Rollbacks**           | How many past images to keep. See [Rollbacks](rollbacks.md)                                                                                                             |

## Limits and gotchas

- **Saving is not deploying.** Nothing changes on the server until the next
  build.
- **Detection cannot help a Docker image or a Compose source.** There is nothing
  to detect. You name the port yourself.
- **A heavy builder that the agent cannot run is a hard failure.** There is no
  fallback to building somewhere else.
- **Changing the build method keeps everything else.** Domains, variables and
  volumes are untouched.

## If it does not work

- **`command not found` during build** - the detected framework guessed wrong,
  or the command belongs to a dependency that is not installed. Set **Build
  command** explicitly.
- **The build passes, the site does not answer** - wrong **Container port**, or
  the process is bound to `127.0.0.1`.
- **The build is slow every single time** - the cache is off for this app, or a
  cleanup sweep is removing it. Check **Build cache** and the server's cleanup
  scopes.
- More in [Deploys and builds](../troubleshooting/deploys-and-builds.md).

## See also

- [What happens on a deploy](../concepts/what-happens-on-a-deploy.md)
- [Automatic deployments](automatic-deployments.md)
- [Domains and HTTPS](domains-and-https.md) - per-hostname port overrides
- [Resource limits](../advanced/resource-limits.md)
