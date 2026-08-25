# Monitoring

## What it is

Live CPU, memory, disk and network for every server, and for every app and
database on them, with enough history to see what happened five minutes ago.

## How it works

Each agent opens **one** telemetry stream to the control plane and pushes
metrics for the whole host: the machine itself and every container on it. The
control plane keeps a short rolling window in memory, roughly the last quarter
of an hour, at a cost of about half a megabyte per server.

That is why charts are full the instant a page opens rather than drawing
themselves from nothing, and why per-app monitoring has no switch to turn on:
the data was already flowing.

## Where to look

| Page                            | Shows                                                                     |
| ------------------------------- | ------------------------------------------------------------------------- |
| **Monitoring** in the sidebar   | Every server: CPU, memory, disk, network                                  |
| An app's **Monitoring** tab     | That app's containers, plus disk I/O, with the resource limits that apply |
| A database's **Monitoring** tab | The same for the engine                                                   |

## Save metrics on server

One instance-wide switch on the **Monitoring** page, **on by default**, changed
by anyone holding `manage_monitoring`.

Turning it off stops keeping history and clears what is stored. Live charts
still work, because they read the stream directly. Turn it off if you would
rather that window did not exist at all.

## Alerts that come from metrics

The metric stream is also what raises these, delivered through
[notifications](notifications-and-alerts.md):

| Alert                                  | Fires when                                 |
| -------------------------------------- | ------------------------------------------ |
| **Server resources high**              | Sustained CPU or memory pressure on a host |
| **Server disk low**                    | The root filesystem is running out         |
| **Server offline** / **Server online** | The agent stopped or started answering     |
| **App keeps restarting**               | A container is in a crash loop             |

## Limits and gotchas

- **History is in memory, not in the database.** Restarting the control plane
  clears it. This is deliberate: metrics are for looking at now, and writing
  every sample to Postgres would cost far more than it is worth.
- **The fleet page needs whole-team access.** A member scoped to one folder sees
  an explicit "outside your access" state, because a fleet view has no
  meaningful per-folder version.
- **A gap in a chart means no data arrived**, usually a reconnect. It does not
  mean the value was zero.
- **`view_metrics` is its own capability**, grantable per folder like the rest.

## If it does not work

- **A server shows dashes instead of numbers** - the stream is not connected.
  Check that server's health, and see
  [Servers and agents](../troubleshooting/servers-and-agents.md).
- **An app shows nothing** - it is stopped, or its containers are on a server
  whose agent is not reporting.
- **Charts are empty right after a restart** - the window is in memory and
  starts again from scratch.

## See also

- [Notifications and alerts](notifications-and-alerts.md)
- [Logs](logs.md)
- [Resource limits](../advanced/resource-limits.md)
- [Server settings](server-settings.md)
