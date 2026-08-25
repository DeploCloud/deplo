# Rollbacks

## What it is

Going back to a deployment that worked, in seconds, without rebuilding
anything. Deplo re-runs the exact image that build produced.

## How it works

Every build Deplo performs leaves an image on the server, recorded on the
deployment row. A rollback tells the agent to run that image again.

Three things follow from that:

- **There is no rebuild.** No clone, no dependency resolution, no waiting, and
  no chance that the dependency tree resolves differently than it did in
  February.
- **Only the code goes back.** Environment variables, domains, volumes and
  resource limits are re-rendered from your **current** settings. A rollback is
  not a time machine for configuration.
- **It is a real deployment.** It gets its own row, its own logs and its own
  activity entry, marked as a rollback of the deployment it came from. It does
  not consume a retention slot.

## Roll back

1. Open the app, then **Deployments**.
2. Find the deployment you want. The list shows the commit, the branch and when
   it ran.
3. Open its menu and click **Rollback**. You can also open the deployment and
   use **Rollback** there.

The app is serving the older image within seconds.

## Retention

**Settings -> Deployments**, the **Rollbacks** card, field **Keep**.

|         |                                            |
| ------- | ------------------------------------------ |
| Default | `3`                                        |
| Maximum | `20`                                       |
| `0`     | Turns the feature off and the card says so |

Each kept rollback is a full copy of the image on that server, so this number is
disk. Older images past the limit are removed by the server's disk cleanup after
a deploy.

**This number is the real retention.** Deplo pushes to no registry, so once an
image is pruned from the host, that deployment can never be rolled back to
again, even though its row is still in the list.

## Limits and gotchas

- **Only sources Deplo builds can roll back.** A Docker image app has no image
  Deplo owns, and a Compose stack has no single image. Neither offers it.
- **A rolled-back app still auto-deploys.** The next push builds and releases
  over the top. Turn off **Deploy on push** first if you are rolling back
  because the branch is broken.
- **A database migration does not roll back with the code.** The image goes
  back; whatever it did to your data does not.
- **Rolling back does not pause anything.** If you need the app stopped, use
  **Stop**.

## If it does not work

- **The Rollback action is missing** - the app's source is a Docker image or a
  Compose stack, or **Keep** is `0`.
- **Rollback fails with an image that is not found** - it was pruned. Raise
  **Keep**, or exclude that server from unused-image cleanup.
- **It rolled back and the bug is still there** - the bug is in configuration or
  data, not in the code. Those did not travel.

## See also

- [Build settings](build-settings.md)
- [Server settings](server-settings.md) - the cleanup that prunes old images
- [What happens on a deploy](../concepts/what-happens-on-a-deploy.md)
- [Backups and restore](backups-and-restore.md) - for data, which rollbacks do not touch
