# Cron jobs

**Beta.**

## What it is

A command run on a schedule **inside** one of your containers: a nightly
cleanup, a report at 6am, a queue worker tick, `php artisan schedule:run`.

## How it works

The schedule is tracked by the **agent**, not by the control plane. That is the
whole design decision: restarting the panel, upgrading Deplo or losing the
dashboard for ten minutes never kills a run in flight.

At each occurrence the agent resolves the target container live, from the
Compose service you named, and runs your command in it. It never remembers a
container id, so a redeployed app keeps working.

Each job runs in **its own timezone**, unlike a backup schedule, which is UTC.
A job that says 03:00 Europe/Rome means 03:00 in Rome, in summer and in winter.

## Turn it on

Cron jobs are opt-in per app and per database, and the switch is also the pause
button for everything underneath it.

1. Open the app, then **Settings -> Advanced**.
2. Turn on **Cron jobs**.
3. A **Cron jobs** tab appears. Open it and click **New cron job**.

For a database it is the same, in **Settings -> Advanced** of that database.

## Create a job

| Field                           | What it does                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Name**, **Description**       | Yours, for the list                                                                                                |
| **Container**                   | Which Compose service to run in. Blank means the target's main container                                           |
| Schedule                        | Five-field cron expression                                                                                         |
| **Timezone**                    | An IANA zone, for example `Europe/Rome`                                                                            |
| **Shell**                       | `sh` or `bash`. A shell the image does not have **fails the run**, deliberately, rather than silently falling back |
| **Command**                     | What to run                                                                                                        |
| **Timeout (minutes)**           | Per attempt, not per run                                                                                           |
| **Attempts**                    | How many tries before the run is failed                                                                            |
| **If it is still running**      | Skip the new occurrence, or allow overlap                                                                          |
| **Runs kept**                   | How much history to keep                                                                                           |
| **Working directory**, **User** | Optional, passed to the exec                                                                                       |
| **Variables**                   | Extra environment for this command only                                                                            |

## Reading the run history

Six statuses, and the distinctions matter:

| Status      | Means                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `running`   | In flight now                                                                                                      |
| `succeeded` | Exit code 0                                                                                                        |
| `failed`    | It ran and exited non-zero                                                                                         |
| `timedout`  | It hit the per-attempt timeout. This points at a **setting**, not at your code                                     |
| `skipped`   | It never started: the container was stopped, or the previous run was still going. Raises no alert                  |
| `lost`      | The agent could not report the outcome. Deliberately **not** `failed`, because the command may well have completed |

Retries share one row, so a job with three attempts is one run with an attempt
counter, not three rows. The stored output is the last attempt's final 16 KiB.
**Run now** produces a run marked as manually triggered.

## Limits and gotchas

- **This is arbitrary code as the container's user, with no sandbox.** That is
  why `manage_crons` is flagged sensitive and why the feature is off until
  somebody turns it on.
- **The switch pauses everything.** Turning it off leaves the jobs defined and
  stops all of them.
- **A stopped app runs nothing.** Occurrences are `skipped`, quietly and on
  purpose.
- **Timezones are per job.** Two jobs on one app can sit in two zones.
- **This is not a job queue.** No fan-out, no dependencies, no retry backoff
  beyond the attempt count.

## If it does not work

- **Every run is `skipped`** - the container is stopped, or the previous run
  never finishes.
- **`shell not found`** - the image has no `bash`. Choose `sh`.
- **The command works in the console and fails here** - the console gives you an
  interactive shell with its environment; a cron exec does not. Use absolute
  paths, and set what you need under **Variables**.
- **Runs go `lost`** - the agent lost contact mid-run. Check that server.

## See also

- [Console and files](console-and-files.md) - to try the command by hand first
- [Notifications and alerts](notifications-and-alerts.md) - cron job failed, cron job finished
- [`docs/adr/0018`](../adr/0018-cron-jobs-are-agent-tracked-container-execs.md)
