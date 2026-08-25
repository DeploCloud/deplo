# Pull request previews

## What it is

Every open pull request gets its own running copy of the app at its own URL, and
it tears itself down when the pull request closes. Reviewers click a link
instead of checking out a branch.

## How it works

A preview is a separate stack, `deplo-<slug>__pr-<n>`, with its own containers,
its own volumes and its own files directory. It inherits the app's environment
variables with no configuration, because every variable is written for both
production and preview.

The hostname is **deterministic**: the same app and the same pull request always
produce the same URL. That matters because the URL gets posted on the pull
request, and a link that changed on every rebuild would strand whoever was
testing it.

Two shapes, depending on whether you set a preview domain:

|                                | Hostname                              | TLS                                                      |
| ------------------------------ | ------------------------------------- | -------------------------------------------------------- |
| No preview domain, the default | `<slug>-pr-<n>-<hash>-<hexip>.nip.io` | Plain HTTP. A `nip.io` name can never hold a certificate |
| A preview domain set           | `<slug>-pr-<n>.<your-base>`           | A normal Let's Encrypt certificate per preview           |

A preview is deliberately **neither an App nor an Environment**. It has no team
placement, no domains of its own, and no console, files, backups or monitoring
surface.

## Turn it on

Only an app deploying from a connected **GitHub** App can have previews. For
other sources the settings are visible but disabled, with the reason on them.

1. Open **Settings -> Pull requests**.
2. Turn on **Deploy pull requests**. This saves immediately.
3. A **Pull requests** tab appears on the app.

## Settings

| Field                           | What it does                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Preview domain**              | A base such as `preview.example.com`, with one wildcard DNS record pointing at the server. Unlocks HTTPS |
| HTTPS                           | Locked until a preview domain exists, for the reason above                                               |
| **Live previews**               | The maximum number running at once                                                                       |
| **Destroy after**               | Days of inactivity before a preview is torn down                                                         |
| **Fork pull requests**          | Whether a pull request from a fork gets one, and whether it waits for approval                           |
| **Server**                      | Where previews run. Often a cheaper machine than production                                              |
| **Build them automatically**    | Rebuild on every new commit, or only on demand                                                           |
| **Only pull requests labelled** | Restrict previews to pull requests carrying a label                                                      |
| Build drafts                    | Whether draft pull requests get one                                                                      |
| Comment on the pull request     | Post the URL as a comment                                                                                |
| **Port**                        | Per-preview container port, if it differs                                                                |

Everything past the switch is a normal form with a **Save** button, and the
fields nobody needs to start are under **Advanced**.

## Day to day

The **Pull requests** tab lists them: **New preview**, **Redeploy**, **Destroy
preview**, **Open pull request**. **Deploy pull request** deploys one on demand.

A preview from a fork shows **Needs approval** until somebody with
`manage_previews` reviews it.

## The two rules about forks and secrets

- **A fork preview never receives a secret-typed variable.** Not because of a
  setting, but because the code in that pull request was written by somebody
  outside your team, and a build step can print anything it likes.
- **A fork preview waits for a human**, if you leave that on. Approving is
  saying "I read this diff".

## Over the limit

At the maximum, a new preview evicts the open one with the oldest activity. The
evicted row **survives** and keeps its deploy key and its hostname, so clicking
**Redeploy** brings the same URL back.

A push never revives an evicted preview. Only a person does. It renders grey,
never red, because nothing failed.

## Limits and gotchas

- **Turning previews off destroys every live preview**, right then.
- **Previews share the app's database unless you point them elsewhere.** A
  [preview override](environment-variables.md) on the connection string is how
  you give them a scratch one, and it is worth doing before somebody's test run
  writes to production.
- **A preview domain belongs to one team**, compared across the whole DNS zone
  in both directions. Another team cannot claim a parent or a child of it.
- **Previews cost real resources.** Ten open pull requests are ten running
  stacks. That is what **Live previews** is for.

## If it does not work

- **The Pull requests tab never appears** - the app does not deploy from a
  GitHub App, or the switch is off.
- **"This App cannot see pull requests yet"** - the GitHub App lacks the pull
  request permission. Use **Update on GitHub** on that notice.
- **The preview URL shows a certificate warning** - it is on `nip.io`, which
  cannot have one. Set a preview domain.
- **A fork preview never deploys** - it is waiting for approval, or forks are
  disabled.
- More in [Deploys and builds](../troubleshooting/deploys-and-builds.md).

## See also

- [Git providers](git-providers.md)
- [Environment variables](environment-variables.md) - preview overrides
- [Domains and HTTPS](domains-and-https.md)
- [`docs/adr/0017`](../adr/0017-pull-request-previews-are-per-pull-request-stacks.md)
