# Deploy your first app

## What it is

Going from a repository to a running site. This page uses GitHub because that
is the shortest path, but the same wizard takes a GitLab, Bitbucket or Gitea
repository, a registry image, an uploaded archive or a Compose file.

## How it works

Creating an app writes one row and nothing else. The first deploy is what does
the work, and it happens on the server you pick, never on the control plane:

1. The agent on that server clones the repository.
2. It detects the framework from `package.json` and the root configuration,
   which sets the build commands and the default container port.
3. It builds an image, by default with **Nixpacks**, so there is no Dockerfile
   to write.
4. The control plane renders a Compose file plus the Traefik routing labels and
   ships them over. The agent brings the stack up.
5. The app answers on a generated hostname immediately.

Framework detection is re-run on **every** deploy and is never stored as a
setting. Anything you type by hand wins over it, permanently.

## Deploy it

1. On the Overview, open **Add new**, then **New app**, then **From Scratch**.
2. Stay on the **GitHub** tab of the **Source** card. If no GitHub App is
   connected yet, click **Connect GitHub** and follow GitHub's screens. Deplo
   creates the App for you through GitHub's manifest flow, so there is nothing
   to copy and paste. Choose the repositories it may see.
3. Pick the repository and the branch to track.
4. Give the app a name under **App Name**. The name seeds the URL, so `shop`
   becomes something like `shop-brave-otter-9487cf1e.nip.io`.
5. Check the detected framework line. If it names your framework and a sensible
   port, leave everything else alone. If it does not, open **Build & Output
   Settings** and set the build command, the start command and the port
   yourself.
6. Leave **Automatic deployments** on. Every push to the branch you picked will
   deploy from now on.
7. Under **Deploy to**, choose the server. A single-machine install has exactly
   one, already selected.
8. Click **Deploy** in the **Summary** rail on the right.

The build log streams while it runs. It survives a page reload and a control
plane restart, so closing the tab does not cancel anything.

## What you get

When the badge turns **Running**, the app header shows the production URL and a
**Visit** button. That first URL is a `nip.io` hostname:
`nip.io` is public wildcard DNS where the last label before `.nip.io` is your
server's IPv4 in hexadecimal, so `9487cf1e` resolves to `148.135.207.30` with
no DNS records of your own.

It is served over **plain HTTP**. A `nip.io` name can never hold a Let's
Encrypt certificate, because it is one registered domain whose issuance budget
is shared with the entire internet. That is what the next page fixes.

## The tabs you now have

| Tab         | What is there                                               |
| ----------- | ----------------------------------------------------------- |
| Overview    | The production deployment, the last four builds, the URL    |
| Deployments | Every build, with **Redeploy**, **Rollback** and **Delete** |
| Domains     | Add your own hostname                                       |
| Environment | Variables for this app                                      |
| Logs        | What the container is printing, live                        |
| Monitoring  | CPU, memory, network and disk for this app                  |
| Backups     | Schedules and restores                                      |
| Settings    | Source, build, storage, resources, access, danger zone      |

Console, Files, Cron jobs and Pull requests appear once you turn them on or
once they have something to show. See
[Console and files](../guides/console-and-files.md) and
[Cron jobs](../guides/cron-jobs.md).

## Limits and gotchas

- **The name is permanent.** An app's slug is frozen after creation. The
  display name is editable, the slug behind the URLs and volume names is not.
- **The first build is the slow one.** Nothing is cached yet. Later builds
  reuse the server's BuildKit cache, which is shared by every app on that host.
- **A private repository needs the connection, not a key in the URL.** Connect
  the provider once in **Settings -> Git** and every app reuses it.
- **`Error` means the last deploy failed, not that the app is down.** A running
  container with a failed newer build still serves traffic.

## If it does not work

- **The build fails on a missing command** - the detected framework guessed
  wrong. Set the build and start commands in **Settings -> Deployments**.
- **The build succeeds and the URL times out** - the container is listening on
  a different port than the one Deplo routes to. Fix the port in
  **Settings -> Deployments**, or per hostname in **Domains**.
- **The repository picker is empty** - the GitHub App has no access to it.
  Click **Manage connected apps** and grant the repository on GitHub.
- More in [Deploys and builds](../troubleshooting/deploys-and-builds.md).

## See also

- [Add a domain](add-a-domain.md) - your own hostname and a real certificate
- [Build settings](../guides/build-settings.md) - every build knob
- [Automatic deployments](../guides/automatic-deployments.md) - triggers, watch paths, deploy hooks
- [What happens on a deploy](../concepts/what-happens-on-a-deploy.md) - the full trace
