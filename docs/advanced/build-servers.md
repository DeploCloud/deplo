# Build servers

**Beta.**

## What it is

Compiling on one machine and running on another. The image is built on a
dedicated host and shipped to the server that will serve traffic.

Use it when builds are starving production of CPU, or when several small servers
would rather share one big builder.

## How it works

A build server is a server installed in the **Build only** role: it gets Docker
and the address-pool setup, because it runs the full build pipeline, but **no
Traefik**, and it drops out of every deploy-target picker. Nothing is ever
routed to it.

At deploy time the builder produces the image, and the image is relayed to the
target host **through the control plane**, because agents cannot dial each
other. The deploy occupies a slot in the **builder's** queue, since that is
where the cost is.

Build logs still belong to the app. You read them where you always do.

## Set one up

1. Install a server with the **Build only** role. See
   [Add a server](../guides/add-a-server.md).
2. Open the app, then **Settings -> Deployments -> Advanced settings**.
3. Set where it builds:
   - **Automatic** lets Deplo choose
   - this app's own server
   - a named build server
4. Leave the fallback on so a build still happens if the builder is unreachable.
5. Save, then redeploy.

## Limits and gotchas

- **Both machines need the same CPU architecture.** An `arm64` builder cannot
  produce an `amd64` image here. Mismatched choices are shown but disabled.
- **A Compose app cannot use one.** There is no single image to build and move.
- **The image crosses the network twice**, once to the control plane and once
  out again. On a fast local network this is cheap; over a slow link it can cost
  more than it saves.
- **The build cache lives on the builder.** Moving an app to a different builder
  starts cold.
- **A build-only server is not a deploy target**, and it will never appear as
  one.

## If it does not work

- **The builder does not appear in the list** - it is not in the Build only
  role, or its architecture does not match the target.
- **Builds fall back to the app's own server** - the builder was unreachable and
  the fallback did its job. Check that server's health.
- **Deploys queue behind each other** - they share the builder's concurrency.
  Raise it in that server's **Overview** if the machine can take it.

## See also

- [Server roles](server-roles.md)
- [Build settings](../guides/build-settings.md)
- [`docs/adr/0020`](../adr/0020-a-build-server-builds-for-hosts-it-does-not-run-on.md)
