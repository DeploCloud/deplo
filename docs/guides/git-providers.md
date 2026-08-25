# Git providers

## What it is

Connecting Deplo to where your code lives, once per team, so every app can clone
it without anybody pasting a token into an app.

**Settings -> Git**.

## How it works

Two mechanisms, not one.

**GitHub** connects as a **GitHub App**, created through GitHub's manifest flow:
you click, you approve on GitHub, and Deplo receives the credentials directly.
There is no client id or private key to copy. The App is installed on the
accounts and organisations that hold your repositories, and mints short-lived
tokens to list and clone them.

**Everything else** connects as a **git connection**, which is one stored
credential per host, reused by every app that deploys from it. This covers
GitLab, Bitbucket, Gitea and Forgejo, self-hosted included, and is marked
**Beta**.

Tokens are encrypted at rest, never returned by the API, and decrypted only at
the clone edge and when calling the provider's own API.

## Connect GitHub

1. **Settings -> Git**, then **Connect**.
2. Choose **Personal account** or **Connect an organization**.
3. Approve on GitHub and pick which repositories the App may see.

**Manage** takes you back to GitHub to change that selection later.

If you plan to use [pull request previews](pull-request-previews.md), the App
needs to see pull requests. When it cannot, Deplo shows **This App cannot see
pull requests yet** with an **Update on GitHub** button.

## Connect GitLab, Bitbucket or Gitea

1. **Settings -> Git**, then add a connection.
2. Pick the **Type**.
3. Fill in the **Address**, which is the provider's base URL. A self-hosted
   GitLab or Gitea goes here.
4. Fill in the **Username**. Providers expect a specific one for token auth:
   `oauth2` for GitLab, `x-token-auth` for Bitbucket.
5. Paste the token.
6. Click **Test connection**, then **Save**.

Later, **Replace the token** swaps it without recreating anything, and **This
connection stopped working** appears when a background check finds it broken.

An instance admin can also tick **This git server is on my own network** for an
address that is not publicly routable. It is deliberately admin-only, because it
turns off a guard that stops Deplo being used to probe your internal network.

## What each connection unlocks

|                       | GitHub App | Git connection | A bare URL |
| --------------------- | ---------- | -------------- | ---------- |
| Repository picker     | yes        | yes            | no         |
| Branch list           | yes        | yes            | no         |
| Deploy on push        | yes        | yes            | no         |
| Pull request previews | yes        | no             | no         |
| Preview comments      | yes        | no             | no         |

A bare URL is the escape hatch: it clones and nothing else. Its automatic
trigger is the [deploy hook](automatic-deployments.md).

## Where the choice lives in the interface

The deploy source chips stay at five: GitHub, Git, Docker Image, Upload,
Compose. Providers other than GitHub live in a dropdown **inside** the Git chip,
which is why you will not find a Bitbucket tab.

## Limits and gotchas

- **One GitHub App per team.**
- **GitLab reports token expiry, Gitea does not.** For Gitea, a background check
  is what tells you a token died.
- **A revoked token surfaces before a deploy fails on it**, because the
  maintenance sweep re-tests connections.
- **Webhooks are registered automatically** for both connected kinds, and
  removed when the app stops using them.
- **The token is per host, not per repository.** Everything that host serves is
  reachable with it, so scope the token on the provider's side.

## If it does not work

- **The repository list is empty** - the GitHub App has no access. Use
  **Manage** and grant it there.
- **`Authentication failed` in a clone** - the token expired or was revoked.
  **Test connection** confirms it.
- **Pushes do not deploy** - check the webhook status on the app's
  **Settings -> Deployments**. A provider that cannot reach this instance cannot
  deliver.
- **Saving a self-hosted address is refused** - it resolves to a private
  address, and only an instance admin can allow that.

## See also

- [Deploy from Git](deploy-from-git.md)
- [Automatic deployments](automatic-deployments.md)
- [Pull request previews](pull-request-previews.md)
