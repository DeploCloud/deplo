# Troubleshooting

Organised by **symptom**, because a symptom rarely belongs to one feature.

## Start here, whatever the symptom

Four questions answer most of it before you read anything else.

1. **Is the server online?** **Settings -> Servers**. A card reading **warning**
   means the agent is up but Docker is not answering there, and nothing can
   deploy. **Unknown** means the reading is stale.
2. **What do the logs say?** The app's **Logs** tab, or the deployment's build
   log. The answer is usually a sentence in there.
3. **Did it ever work?** If it did, something changed: a push, a variable, a
   token expiring, a certificate, a disk filling up.
4. **Can you reach the panel on `http://<server-ip>:3000`?** That address always
   answers, and it is the way back in when a domain, a certificate or the proxy
   is what broke.

## Find your symptom

| What you see                                  | Page                                              |
| --------------------------------------------- | ------------------------------------------------- |
| The build fails                               | [Deploys and builds](deploys-and-builds.md)       |
| The build passes and the site does not answer | [Deploys and builds](deploys-and-builds.md)       |
| A push does not deploy                        | [Deploys and builds](deploys-and-builds.md)       |
| The deploy is stuck queued                    | [Deploys and builds](deploys-and-builds.md)       |
| No space left on device                       | [Deploys and builds](deploys-and-builds.md)       |
| A domain is stuck on **Waiting for DNS**      | [Domains and TLS](domains-and-tls.md)             |
| Certificate warning in the browser            | [Domains and TLS](domains-and-tls.md)             |
| 404 from the proxy                            | [Domains and TLS](domains-and-tls.md)             |
| A redirect loop                               | [Domains and TLS](domains-and-tls.md)             |
| A server is stuck **provisioning**            | [Servers and agents](servers-and-agents.md)       |
| A server is online but every deploy fails     | [Servers and agents](servers-and-agents.md)       |
| Metrics show dashes                           | [Servers and agents](servers-and-agents.md)       |
| A database will not start                     | [Databases and backups](databases-and-backups.md) |
| An app cannot reach its database              | [Databases and backups](databases-and-backups.md) |
| A backup or a restore fails                   | [Databases and backups](databases-and-backups.md) |
| A backup artifact will not decrypt            | [Databases and backups](databases-and-backups.md) |
| You cannot sign in                            | [Sign-in and access](sign-in-and-access.md)       |
| A team shows a lock screen                    | [Sign-in and access](sign-in-and-access.md)       |
| Passkeys say **Not usable here**              | [Sign-in and access](sign-in-and-access.md)       |
| An API token returns 401 or 403               | [Sign-in and access](sign-in-and-access.md)       |
| A button is missing or greyed out             | [Sign-in and access](sign-in-and-access.md)       |

## Things that look like bugs and are not

| What you see                             | What it means                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| An app says **Error** but the site works | `error` means the **last deploy attempt** failed. The previous stack is still serving           |
| A preview is grey, not red               | It was evicted because the app is at its preview limit. **Redeploy** brings the same URL back   |
| A cron run says **skipped**              | It never started: the container was stopped, or the previous run was still going. Not a failure |
| A cron run says **lost**                 | The agent could not report the outcome. The command may well have completed                     |
| A readiness row says **skip**            | It could not be evaluated. Deliberately not a pass                                              |
| A server says **Unknown**                | The health reading is stale. Click **Check status**                                             |
| A domain says **Cloudflare DNS**         | Proxied, so the origin cannot be verified from here. It is routed anyway                        |
| A destination test **failed**            | A normal result, not an error. Read the **Connection log**                                      |

## Where to get the details

Almost every symptom has a matching **If it does not work** section on the
feature's own guide. Start from [the index](../README.md) if you know which
feature you are in.

If you think you found a real bug, the repository's issue tracker is the place.
If you think you found a security hole, do not open an issue: read
[SECURITY.md](../../SECURITY.md).
