# Container registries

## What it is

Credentials for pulling private images: your own builds on GitHub Container
Registry, a paid Docker Hub repository, a GitLab registry, or anything
self-hosted.

**Settings -> Registries**.

## How it works

One entry per registry, stored per team and encrypted. On deploy, the agent uses
it to pull. The image autocomplete in the app wizard also starts including that
registry, so private images become searchable rather than something you have to
type exactly.

The password or token is write-only: it is never returned by the API and there
is no reveal path.

## Add one

1. **Settings -> Registries**, then **Add registry**.
2. Pick the **Type**: `ghcr`, `dockerhub`, `gitlab` or `generic`.
3. Fill in the **Registry host**, for example `ghcr.io`.
4. Fill in the **Username** and the token.
5. Save.

Use it by referencing the image in an app whose source is
[a Docker image](deploy-a-docker-image.md), or as the base image of a Dockerfile
build.

## Limits and gotchas

- **Registries are per team.** Another team needs its own entry.
- **Tokens expire.** A pull that used to work and now fails with
  `unauthorized` is almost always this.
- **Scope the token to read-only** on the provider's side. Deplo only ever
  pulls.
- **Deplo pushes nothing.** Images it builds stay on the server that built them,
  which is why [rollbacks](rollbacks.md) depend on local retention rather than a
  registry.

## If it does not work

- **`pull access denied`** - no credential matches that image's host, or the
  token cannot see that repository.
- **It works for one image and not another** - same host, different repository
  permissions on the provider's side.
- **A self-hosted registry with a private address is refused** - only an
  instance admin can allow a non-public endpoint.

## See also

- [Deploy a Docker image](deploy-a-docker-image.md)
- [Build settings](build-settings.md)
- [Capabilities](../reference/capabilities.md) - `manage_registries`
