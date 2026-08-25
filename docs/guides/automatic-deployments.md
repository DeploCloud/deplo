# Automatic deployments

## What it is

Making a deploy happen without anybody clicking anything: on a push, on a new
tag, or when a script calls a URL you hold.

## How it works

There are two independent mechanisms, and which one you get depends on how the
repository is connected.

**A webhook, registered for you.** When an app deploys from a connected GitHub
App or a Git connection, Deplo registers a push webhook on that repository. The
provider posts to Deplo, the signature is verified, and if the delivery passes
the filters, a deploy starts.

**The deploy hook, which is a URL you call.** When there is no connection to
register a webhook with, the app gets a URL instead. Anything that can send a
`POST` can deploy: CI, a cron job on your laptop, another provider's webhook.

## Deploy on push

1. Open **Settings -> Deployments**.
2. Turn on **Deploy on push**.
3. Set **Deploy trigger**:
   - **On push to branch** deploys when the tracked branch moves. This is the
     default.
   - **On new tag** deploys when any new tag appears, which is how you get
     release-only deploys.
4. Optionally set **Include submodules** so the clone pulls nested repositories.
5. Optionally set **Watch paths (optional)**: one glob per line. The deploy only
   happens if the push touched a matching file.

   ```
   apps/web/**
   packages/ui/**
   ```

   This is what makes a monorepo bearable: four apps in one repository, each
   only rebuilding when its own code changes.

6. Save.

The webhook's health is shown on the same page, so you can see whether the
provider is actually reaching you.

## The deploy hook

Under **Settings -> Deployments -> Advanced settings**. It appears only for apps
that do **not** already deploy from a connected git provider, because those
already have a trigger.

1. Enable **Deploy hook**.
2. Click **Reveal deploy hook URL**, then **Copy deploy hook URL**.
3. Call it from wherever you like:

   ```bash
   curl -X POST \
     -H "Authorization: Bearer deplo_xxxxxxxxxxxxxxxxxxxx" \
     https://deplo.example.com/api/apps/prj_1a2b3c/deploy-hook/9f2c4d6e8a
   ```

**It needs two independent secrets, and neither is enough alone.** The last
segment of the URL says _which app_. The bearer token is an ordinary
[API token](../advanced/api-tokens-and-oauth.md) that says _who_, and it must
hold `deploy_apps`. That is what keeps a leaked URL from being a deploy button
for the internet.

**Rotate URL** mints a new last segment and invalidates the old one. The switch
next to it is a kill switch.

## Limits and gotchas

- **A bare Git URL cannot have a push webhook.** No connection, nothing to
  register on. Use the deploy hook.
- **Watch paths fail open.** If a delivery carries no file list, which happens
  with some annotated tag pushes, the deploy runs rather than being skipped.
  Better a build you did not need than a release that silently never happened.
- **A manual redeploy ignores every filter.** Watch paths and change detection
  gate automatic deploys only.
- **Turning off deploy on push does not remove the webhook's history.** Past
  deliveries stay visible on the provider's side.
- **Two apps can watch the same repository** on different branches or different
  watch paths, and both will fire.

## If it does not work

- **Pushes do nothing** - check the webhook status on **Settings ->
  Deployments**. A red state usually means the provider cannot reach this
  instance, which means the panel address is wrong or not public.
- **Pushes to the wrong branch deploy** - the app tracks a branch, and it may
  not be the one you think. Check **Deploy source**.
- **The deploy hook returns 401** - the bearer token is missing, expired,
  revoked, or lacks `deploy_apps`.
- **The deploy hook returns 404** - the URL was rotated.
- More in [Deploys and builds](../troubleshooting/deploys-and-builds.md).

## See also

- [Deploy from Git](deploy-from-git.md)
- [Git providers](git-providers.md) - webhook registration per provider
- [API tokens](../advanced/api-tokens-and-oauth.md)
- [Pull request previews](pull-request-previews.md)
