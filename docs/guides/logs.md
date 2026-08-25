# Logs

## What it is

What your containers are printing, live, plus the output of every build. No
`docker logs`, no SSH.

## How it works

Logs are streamed from the agent that owns the container, over the same mutual
TLS connection everything else uses. Nothing is copied into the control plane on
a schedule: the stream is opened when you open the page.

Two different things share the screen:

- **Runtime logs** come from the running container's stdout and stderr. If the
  app is stopped, the page falls back to the last build's output and says so.
- **Build logs** are the output of one deployment. They are persisted, so they
  survive a page reload and a control plane restart, with a cap on how much is
  stored so a runaway build cannot fill the disk.

Deplo detects a level for each line (`info`, `warn`, `error`, `debug`,
`command`, `success`) and colours it, which is what makes the level filter work
on software that has no idea Deplo exists.

## Where to look

| Page                      | Shows                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| **Logs** in the sidebar   | The 15 most recent deployments across every app, with their output     |
| An app's **Logs** tab     | That app's runtime output, with its build logs behind the same toolbar |
| A deployment's page       | Just that build                                                        |
| A database's **Logs** tab | The engine's output                                                    |

## The toolbar

| Control             | What it does                                                          |
| ------------------- | --------------------------------------------------------------------- |
| Instance picker     | Which container of the stack you are watching                         |
| **Live**            | Follow new lines as they arrive                                       |
| **Level**           | Filter to errors, warnings and so on, or **All levels**               |
| **Search logs**     | Filter to lines containing text                                       |
| **Time range**      | **Last 30 minutes**, **Last hour**, **Last day**, or a number of days |
| **Show timestamps** | Prefix each line with its time                                        |

## Retention

The instance sets a ceiling on how far back the time range can reach:
**Settings -> Deplo -> Max log range**. Default **7** days, minimum 1, maximum 90. Instance admins only.

> **Raising it does not make the host keep more.** Docker rotates a container's
> log files **by size**, not by age. The setting bounds what Deplo will ask for;
> what actually exists on disk is whatever the rotation left. If you need long
> retention, ship logs out to something built for it.

## Limits and gotchas

- **Nothing here is a log search engine.** It is a live tail with filters, for
  answering "what is it doing right now" and "why did that build fail".
- **A crash loop still streams.** You see each attempt's output as the container
  restarts, which is usually where the answer is.
- **`view_logs` is its own capability**, and it can be granted per folder. An
  app you cannot read logs for shows an explicit closed state rather than an
  empty pane, so you can tell "no permission" from "no output".
- **Build logs for a build server** belong to the app, not to the builder. You
  read them in the same place.

## If it does not work

- **Empty pane, app running** - the app writes to a file instead of stdout.
  Container logs only capture stdout and stderr.
- **The stream stops** - the container was recreated. Reopen the page.
- **"Not live" on the app's Logs tab** - nothing is running, so you are reading
  the last build's output.
- More in [Deploys and builds](../troubleshooting/deploys-and-builds.md).

## See also

- [Monitoring](monitoring.md)
- [Console and files](console-and-files.md)
- [Notifications and alerts](notifications-and-alerts.md)
