# Deploys and builds

## The build fails

**Read the build log first.** It is the deployment's page, and it says what
command failed.

| In the log                            | Cause                                                                                           | Fix                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `command not found`                   | Framework detection guessed wrong, or the command belongs to a dependency that is not installed | Set **Build command** in **Settings -> Deployments** |
| `Cannot find module`                  | The build ran in the wrong directory                                                            | Set **Root Directory**                               |
| `pull access denied`                  | A private image with no matching credential                                                     | Add the registry in **Settings -> Registries**       |
| `Authentication failed` while cloning | The git token expired or was revoked                                                            | **Settings -> Git**, then **Test connection**        |
| `no space left on device`             | The server's disk is full                                                                       | See below                                            |
| The log ends with nothing             | The builder was killed, usually out of memory                                                   | Raise the memory limit, or build on a bigger machine |

**Detection is re-run every deploy and is never stored.** A build that used to
work and now picks the wrong commands usually means something in the repository
changed what it looks like. Type the commands you want and they win permanently.

## The build passes and the site does not answer

In order of how often it is the answer:

1. **Wrong container port.** Deplo routes to one port. Check what your process
   actually listens on and set **Container port**.
2. **Bound to `127.0.0.1`.** A process listening on localhost inside a container
   is unreachable from outside it. Bind `0.0.0.0`.
3. **The container exited.** Read the app's **Logs**. A missing environment
   variable is the usual reason.
4. **The domain is not routed.** Check the domain's DNS state in **Domains**.
   See [Domains and TLS](domains-and-tls.md).

## A push does not deploy

| Check                                       | Where                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Is **Deploy on push** on?                   | **Settings -> Deployments**                                                                |
| Is the webhook healthy?                     | Same page. A red state means the provider cannot reach this instance                       |
| Is it the branch the app tracks?            | **Deploy source**                                                                          |
| Do **Watch paths** exclude what you pushed? | Same page. Empty means deploy on anything                                                  |
| Is it a bare Git URL?                       | Then there is no webhook at all. Use the [deploy hook](../guides/automatic-deployments.md) |

If the panel's address changed recently, providers are still delivering to the
old one. Re-check **Settings -> Git**.

## The deploy is stuck queued

Deploys to one server serialize, `1` at a time by default. The build log shows
the queue position.

- Another deploy is running on that server. Wait, or raise **Concurrent
  deployments** in that server's **Overview**.
- The app builds on a [build server](../advanced/build-servers.md) and the
  **builder's** queue is full.
- The server is unreachable. Check its health.

## No space left on device

The single most common operational failure.

1. Open **Settings -> Servers -> the server -> Cleanup**.
2. Click **Reclaim disk now**.
3. If it frees little, look at what is holding disk. Old app images and the
   build cache are the usual pair.
4. Set a **Schedule** so it does not happen again, and check **Images kept per
   app**.

Deplo deliberately never runs `system prune`, container prune or volume prune,
because on a Deplo host a stopped app is a live app and a dangling volume may
hold somebody's data.

**Watch the interaction with rollbacks.** If **Images kept per app** is lower
than an app's **Keep**, rollback targets get pruned and the rollback fails.

## A rollback fails or is not offered

- **Not offered**: the source is a Docker image or a Compose stack, so there is
  no image Deplo built. Or **Keep** is `0`.
- **Fails on a missing image**: it was pruned. Raise **Keep**, and raise
  **Images kept per app** on that server.

## The deploy succeeded but nothing changed

- **A variable you set is not applied**: variables apply on the next deploy, and
  saving is not deploying.
- **Storage you added is not mounted**: same.
- **The rendered stack is identical**, so Compose changed nothing. Use **Rebuild
  container** in **Settings -> Advanced** to force a recreate.

## Stale in-flight deploys

If the control plane restarts mid-build, deploys that were in flight are marked
`error` at boot rather than left spinning. A later telemetry frame proving the
containers are running clears a stale `error` on its own.

## See also

- [Build settings](../guides/build-settings.md)
- [Automatic deployments](../guides/automatic-deployments.md)
- [What happens on a deploy](../concepts/what-happens-on-a-deploy.md)
- [Server settings](../guides/server-settings.md)
