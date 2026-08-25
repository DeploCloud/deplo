# Deploy from Git

## What it is

Pointing an app at a repository and letting Deplo build it. This is the source
most apps use. GitHub is the deepest integration; GitLab, Bitbucket, Gitea and
Forgejo work through a token, and any other Git server works through a URL.

## How it works

The repository is cloned **by the agent, on the target server**, using a
credential the control plane decrypts at that moment. Deplo then detects the
framework, builds an image and brings the stack up. Nothing is cloned onto the
control plane.

What the provider gives you depends on how it is connected:

|                       | GitHub App                     | GitLab, Bitbucket, Gitea (Beta)        | A bare Git URL             |
| --------------------- | ------------------------------ | -------------------------------------- | -------------------------- |
| Repository picker     | yes                            | yes                                    | no, you paste the URL      |
| Branch list           | yes                            | yes                                    | no, you type it            |
| Deploy on push        | yes, automatic webhook         | yes, automatic webhook                 | no, use the deploy hook    |
| Pull request previews | yes                            | no                                     | no                         |
| Credential            | short-lived installation token | a personal access token you store once | the URL, or a stored token |

## Deploy one

1. On the Overview, open **Add new**, then **New app**, then **From Scratch**.
2. In the **Source** card, pick the tab you need.
   - **GitHub**: if nothing is connected yet, click **Connect GitHub**. Deplo
     creates the GitHub App through GitHub's manifest flow, so there is no
     client id or private key to copy. Choose which repositories it can see,
     then pick the repository and the branch.
   - **Git**: pick the provider, paste the repository URL and set the
     production branch. Add the connection first in **Settings -> Git** if the
     repository is private.
3. Set **App Name**.
4. Check the detected framework line. Open **Build & Output Settings** only if
   it guessed wrong.
5. Leave **Deploy on push** on unless you want to release by hand.
6. Pick the server under **Deploy to**.
7. Click **Deploy**.

## Change the source later

**Settings -> Deployments**, the **Deploy Source** card. You can move an app
between repositories, branches and even source types. The app keeps its slug,
its domains, its variables and its volumes, so switching from a Docker image to
a repository does not start over.

| Field              | What it does                                                                      |
| ------------------ | --------------------------------------------------------------------------------- |
| Repository, branch | What gets cloned                                                                  |
| **Root directory** | Subdirectory to build from. A monorepo points each app at its own package         |
| **Build method**   | Nixpacks, Railpack, Dockerfile or Static. See [Build settings](build-settings.md) |
| **Deploy trigger** | **On push to branch** or **On new tag**                                           |
| Submodules         | Clone with `--recurse-submodules`                                                 |
| Watch paths        | Only auto-deploy when a push touched these globs                                  |
| **Deploy to**      | Which server runs it                                                              |

Saving the source does not deploy. Click **Redeploy** when you are ready.

## Private repositories

Deplo never asks you to paste a key into an app. Credentials live once, on the
connection, and every app that uses that host reuses them:

- **GitHub**: one connected App per team, with installations on the accounts or
  organisations that hold your repositories.
- **Everything else**: **Settings -> Git**, one entry per host, holding the
  provider, the base URL (self-hosted GitLab and Gitea are fine), a username
  such as `oauth2` or `x-token-auth`, and a write-only token.

The token is never returned by the API and has no reveal path. **Test
connection** re-checks it, and a background sweep does too, so a revoked token
surfaces before it breaks a deploy.

## Limits and gotchas

- **Only a GitHub app can have pull request previews.** The settings page is
  visible for other sources but disabled, with the reason on it.
- **A bare Git URL cannot register a webhook.** Deploy on push is not available,
  and the [deploy hook](automatic-deployments.md) is how you trigger it instead.
- **Watch paths fail open.** When a webhook delivery carries no file list, which
  happens with some tag pushes, the deploy runs rather than being skipped.
- **The branch is the app's, not the repository's.** Two apps can track two
  branches of the same repository, and that is a normal way to run staging.
- **Changing the repository does not clear the volumes.** Data written by the
  old code is still mounted.

## If it does not work

- **The repository picker is empty** - the GitHub App cannot see it. Use
  **Manage connected apps** and grant the repository on GitHub.
- **`Authentication failed` in the clone step** - the stored token expired or
  was revoked. **Settings -> Git**, then **Test connection**.
- **Pushes do not deploy** - check the webhook status on
  **Settings -> Deployments**, and see [Automatic deployments](automatic-deployments.md).
- More in [Deploys and builds](../troubleshooting/deploys-and-builds.md).

## See also

- [Git providers](git-providers.md) - connecting each provider in detail
- [Build settings](build-settings.md)
- [Automatic deployments](automatic-deployments.md)
- [Pull request previews](pull-request-previews.md)
