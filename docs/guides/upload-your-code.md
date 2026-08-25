# Upload your code

## What it is

Deploying an archive of your project instead of connecting a repository. Deplo
builds it exactly as it would build a clone, framework detection included.

Use it for a project that is not in Git, for a one-off, or when the code lives
somewhere Deplo cannot reach.

## How it works

You upload a compressed archive of the project. It is stored in the control
plane's staging directory, and the agent unpacks it on the target server and
builds it with the same pipeline a Git source uses: framework detection, then
Nixpacks, Railpack, a Dockerfile or a Static build.

An upload app is **created idle**. It has no source until the first archive
lands, so nothing deploys at creation time.

## Deploy one

1. **Add new**, then **New app**, then **From Scratch**.
2. In the **Source** card pick the **Upload** tab.
3. Choose the archive. Include your project's root, so `package.json` (or the
   equivalent) sits at the top level or under the root directory you set.
4. Set **App Name**, pick the server, then **Deploy**.

To ship a new version, go to **Settings -> Deployments**, upload a new archive
and click **Redeploy**.

## Limits and gotchas

- **No automatic deploys.** There is no repository to watch. You can still
  trigger a build from CI with a [deploy hook](automatic-deployments.md), but
  the hook rebuilds whatever archive is currently stored.
- **Rollbacks still work.** Deplo builds this source, so past images are kept
  and a rollback re-runs one.
- **Exclude `node_modules` and build output.** They make the upload huge, and
  the build reinstalls dependencies anyway.
- **The archive replaces the previous one.** There is no upload history.

## If it does not work

- **The build cannot find the project** - the archive has an extra top-level
  directory. Set **Root directory** to it, or repackage from inside the project.
- **The upload is rejected** - check the file is a supported archive and that
  the control plane has disk in its data directory.
- More in [Deploys and builds](../troubleshooting/deploys-and-builds.md).

## See also

- [Build settings](build-settings.md)
- [Deploy from Git](deploy-from-git.md) - the same build, with history and push triggers
- [Rollbacks](rollbacks.md)
