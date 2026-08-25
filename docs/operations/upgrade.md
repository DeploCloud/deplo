# Upgrade

## What it is

Moving to a newer version. There are two clocks: the **control plane** (this
panel) and the **server agents**, which version independently.

## How it works

The control plane is a container image, `ghcr.io/deplocloud/deplo`. Upgrading it
means pulling a newer tag and restarting the stack. Database migrations apply
themselves at boot, so there is no separate migration step.

Agents are a binary on each host, updated one server at a time from the servers
page. The control plane and the agents are designed to tolerate a version gap:
new capabilities are announced in the handshake, so an older agent simply does
not offer a newer feature rather than failing.

**Agent updates only ever move forward.** There is no downgrade path.

## Upgrade the control plane

Re-run the installer on the machine that runs it:

```bash
curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | bash
```

It detects the existing `/opt/deplo/.env`, switches to update mode, pulls the
image and restarts. **Secrets are never rotated.**

To pin a version rather than take `latest`:

```bash
curl -fsSL https://raw.githubusercontent.com/DeploCloud/deplo/main/install.sh | \
  DEPLO_VERSION=0.4.1 bash
```

The panel checks for releases on its own and shows a banner when one is
available, with a link to the release notes. Nothing updates itself.

**Your apps keep running throughout.** They are containers on hosts the control
plane is not part of. A panel that is down means you cannot deploy or read logs
for a minute; it does not mean your sites are down.

## Update the agents

1. Open **Settings -> Servers**.
2. Click **Check for updates**.
3. On each server that is behind, click **Update agent**.

Sensible order, especially on a fleet:

1. One canary server that runs something you can afford to break.
2. Watch it: readiness, a deploy, logs streaming.
3. The rest.
4. **The machine running Deplo itself, last.** If an agent update goes wrong
   there, you want the panel already proven on the new version.

Do not update an agent while a deploy is in flight on that host.

## Limits and gotchas

- **Agents cannot be downgraded.** Test on a canary.
- **Some features need a newer agent.** When one is missing, Deplo says so
  rather than silently doing something else.
- **Re-running the installer is safe and idempotent.** It is the intended update
  path, not a workaround.
- **Read the release notes for a minor bump.** During `0.x`, minor means
  something you notice: a feature, changed behaviour, a database migration, or a
  newer agent required.
- **Back up before a big jump.** Migrations apply at boot and are not reversed
  by rolling the image back.

## If it does not work

- **The panel does not come back** - read `docker logs deplo` on the host. A
  failed migration is re-raised rather than swallowed, and the reason is there.
- **The image will not pull** - `DEPLO_VERSION` names a tag that does not exist,
  or the host has no route to `ghcr.io`.
- **A server says it is up to date and it is not** - the release check is rate
  limited by GitHub when unauthenticated. Wait and click again.
- **An agent update fails** - the host is unreachable, or its disk is full.
  Check readiness on that server.

## See also

- [Install Deplo](../getting-started/install.md)
- [Server settings](../guides/server-settings.md)
- [Disaster recovery](disaster-recovery.md)
- [Instance administration](instance-administration.md)
