# Deploy a Docker image

## What it is

Running an image that is already built, from Docker Hub, GitHub Container
Registry, or any registry you can reach. There is no build step at all: Deplo
pulls the image and runs it.

Use it for software you did not write (a database viewer, a metrics dashboard,
a game server) and for images your own CI already builds and pushes.

## How it works

The app stores an image reference such as `nginx:1.27-alpine` or
`ghcr.io/acme/api:v2.3.1`. On deploy, the control plane renders a Compose file
with that image, the Traefik routing labels and your variables, and the agent
pulls and starts it.

Because nothing is built, several features simply do not apply: there is no
build log worth reading, no build cache, no build server, and **no rollback**,
because a rollback re-runs an image Deplo built and kept. Moving the tag is your
version control here.

## Deploy one

1. **Add new**, then **New app**, then **From Scratch**.
2. In the **Source** card pick the **Docker Image** tab.
3. Type the image reference. The field autocompletes from public registries and
   from any private registry you have added.
4. Set **App Name**.
5. Set the container port. Deplo cannot detect it from an image it has not
   built, so if the software listens on something other than `80`, say so now
   or fix it later in **Domains**.
6. Pick the server, then **Deploy**.

## Private registries

Add the registry once in **Settings -> Registries**: a type (`ghcr`,
`dockerhub`, `gitlab` or `generic`), the registry host, a username and a
password or token. Every app on that team can then pull from it, and the image
autocomplete starts including it.

The password is encrypted and never returned. See
[Container registries](container-registries.md).

## Settings that matter for an image app

| Setting               | Where                       | Note                                              |
| --------------------- | --------------------------- | ------------------------------------------------- |
| Image reference       | **Settings -> Deployments** | Change it and redeploy to move versions           |
| Container port        | **Settings -> Deployments** | Required, since nothing detected it               |
| Environment variables | **Environment**             | The normal way to configure this kind of software |
| Volumes               | **Settings -> Storage**     | A prebuilt image must name the mount path itself  |
| Resource limits       | **Settings -> Resources**   | Worth setting for software you did not write      |

## Limits and gotchas

- **No rollback.** There is no image Deplo owns to go back to. Pin a specific
  tag or a digest rather than `latest` if you care about reproducibility.
- **`latest` does not re-pull by itself.** Redeploying pulls again; nothing
  watches the registry for you.
- **The mount path is not derived.** For a built app Deplo can infer that
  `uploads` means `/app/uploads`. For a prebuilt image it cannot, so you type
  the full path.
- **Multi-container software wants Compose, not this.** If the vendor ships a
  `docker-compose.yml`, use [Compose apps](../advanced/compose-apps.md) or look
  for it in [Templates](deploy-from-a-template.md).

## If it does not work

- **`pull access denied`** - the image is private and no registry credential
  matches its host. Add it in **Settings -> Registries**.
- **The container starts and exits immediately** - it usually needs a variable
  or a volume. Read [Logs](logs.md); the exit reason is in there.
- **The URL times out** - wrong port. Check what the image documents and set it
  in **Settings -> Deployments**.

## See also

- [Container registries](container-registries.md)
- [Deploy from a template](deploy-from-a-template.md) - the same idea, preconfigured
- [Compose apps](../advanced/compose-apps.md) - more than one container
- [Persistent storage](persistent-storage.md)
- [Upload your code](upload-your-code.md) - when you have source but no repository
