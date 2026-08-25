# Notifications and alerts

## What it is

Getting told when something happens: a deploy failed, a backup did not run, a
server went offline, somebody minted an API token.

## How it works

Two halves that are configured separately.

**A channel** is somewhere to send a message. There are twelve kinds and you can
have as many of each as you like.

**An alert selection belongs to each channel**, not to the team. A team chat
room that wants every deployment outcome and an on-call phone that wants only
failures is the normal case, so each channel carries its own list of the 35
alerts it cares about.

A channel nobody has configured sits on the catalogue defaults, so a team gets
something sensible before it ever opens the page.

## Channels

**Settings -> Notifications**, then add a channel.

| Kind                                                                               | What it needs                             |
| ---------------------------------------------------------------------------------- | ----------------------------------------- |
| **Discord**, **Slack**, **Mattermost**, **Microsoft Teams**, **Lark**, **Webhook** | An incoming webhook URL                   |
| **Telegram**                                                                       | A bot token and a chat id                 |
| **Email**                                                                          | Your own SMTP server, or a Resend API key |
| **ntfy**, **Gotify**, **Pushover**                                                 | The service's URL and token. Beta         |
| **Browser push**                                                                   | Permission from your browser. Beta        |

Each channel has a test, so you find out now rather than during an incident.
Credentials are write-only: leaving a field blank when you save keeps what is
already stored.

## Pick what each channel is told about

Open the channel's alert picker. It is the same search box and category browse
as the role editor, so it should feel familiar. The 35 alerts group into nine
categories:

| Category                | Examples                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Deployments**         | Deployment failed, deployment succeeded, deployment interrupted, git connection failing                               |
| **Apps**                | App keeps restarting                                                                                                  |
| **Cron jobs**           | Cron job failed, cron job finished                                                                                    |
| **Databases**           | Database ready, database setup failed, database rebuilt, database deleted                                             |
| **Backups & restore**   | Backup failed, backup finished, restore succeeded, restore failed                                                     |
| **Servers**             | Server offline, server online, disk low, resources high, agent certificate failed, cleanup failed, teardown abandoned |
| **This Deplo instance** | A new Deplo version is available                                                                                      |
| **Security & team**     | API token created, API token revoked, and the rest of the account surface                                             |
| **Domains & TLS**       | Certificate expiring                                                                                                  |

**Unselect all** and **Reset to defaults** are both there, spelled the way you
expect.

## Alerts are not the activity trail

Two different things, on purpose.

- **An alert interrupts.** It goes to a channel, now, because somebody should
  look.
- **The activity trail is looked up later.** It answers "who did this and when",
  in the **Activity** page, and it is never delivered anywhere.

## Limits and gotchas

- **Every webhook URL must be public HTTPS.** An outbound guard refuses
  addresses inside your own network, which means a Gotify or ntfy on the LAN is
  refused. That guard is what stops a notification URL being used to probe your
  internal network.
- **Every alert key here has a real emitter.** Nothing in the list is a switch
  that promises an alert and delivers silence.
- **Notification settings are per team.** Another team's failures go to their
  channels.
- **`manage_notifications`** is the capability.

## If it does not work

- **The test succeeds and real alerts never arrive** - that channel's alert
  selection does not include them. Open its picker.
- **Saving a channel is refused** - the URL is not public HTTPS, or it resolves
  to a private address.
- **Email never arrives** - check the SMTP host, port and credentials, and
  whether your provider requires a verified sender address.

## See also

- [Monitoring](monitoring.md) - where the server alerts come from
- [Teams and members](teams-and-members.md) - the Activity trail
- [Capabilities](../reference/capabilities.md)
