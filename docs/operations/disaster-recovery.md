# Disaster recovery

## What it is

What to keep so that losing a machine is an afternoon rather than an ending, and
the order to bring things back in.

## What actually matters

Three things, in order of how badly you want them.

### 1. `DEPLO_SECRET`

It lives in `/opt/deplo/.env` on the panel's host. **Every encryption key,
session signature and agent certificate authority is derived from it.**

Lose it and every stored secret becomes unreadable: environment variables,
database passwords, S3 keys, registry and git credentials. Deplo will start, and
it will not be able to open anything.

Copy that file into a password manager today. It is four lines.

### 2. The Postgres database

Every app, team, domain, role, token, deployment record and encrypted secret is
a row in it. It runs as a container on the panel's host, on a network that is
deliberately not published.

```bash
docker compose -f /opt/deplo/docker-compose.yml --env-file /opt/deplo/.env \
  exec -T postgres pg_dump -U deplo deplo | gzip > deplo-$(date +%F).sql.gz
```

Keep those dumps somewhere that is not that machine.

### 3. Backup recovery keys

Every backup destination has one, and it is what decrypts its artifacts. Deplo
stores a copy, encrypted with `DEPLO_SECRET`, which is no help in the scenario
where you lost both.

Download each one from the destination's menu and keep them with the secret.
With a recovery key, any artifact reads anywhere:

```bash
age -d -i recovery-key.txt backup.sql.gz.age > backup.sql.gz
```

## Your apps' data

That is what [backups](../guides/backups-and-restore.md) are for. Two rules
worth stating plainly:

- **A backup on the same server as the workload survives everything except
  losing that server**, which is the failure people actually have. Send at least
  one copy to a bucket or to a [backups-only server](../advanced/server-roles.md).
- **An app schedule does not include its databases.** Schedule both.

## Losing the panel's machine

Your apps keep serving. The control plane is not in the request path: Traefik
and your containers are on the servers, and they do not need Deplo to keep
running. What you lose is deploying, logs, metrics and the dashboard.

To come back:

1. Install Deplo on a new machine:
   `curl -fsSL .../install.sh | bash`
2. Stop it, and put the **old `DEPLO_SECRET`** into `/opt/deplo/.env`.
3. Restore the Postgres dump into the new instance's database.
4. Start it. Migrations apply at boot.
5. The agents pin the **old** control plane's certificate authority, which was
   derived from that same secret, so they trust the new one. Where an agent does
   not reconnect, re-run the agent installer on that host to re-enroll it.
6. Check **Settings -> Deplo** and set the panel address, then re-point any
   webhook that names the old address.

The order matters: **secret first, then the database**. A restore under the
wrong secret produces a working panel full of unreadable secrets.

## Losing an app server

1. Add a replacement server.
2. Recreate or move the apps onto it.
3. Restore each app and database from its backups.
4. Remove the dead server. That is
   [trust revocation](remove-a-server-or-uninstall.md), and it does not need the
   machine to answer.

If a database refuses to start with a data-copy error after a move, that block
is protecting you: an engine started on an emptied volume does not fail, it
initialises a brand-new empty database over your data.

## A ten-minute drill worth doing

Once, before you need it:

1. Restore one backup into a scratch app or database and confirm the data is
   there.
2. Decrypt one artifact by hand with `age` and its recovery key.
3. Confirm you can read `/opt/deplo/.env` from wherever you filed it.

An untested backup is a hope, not a plan.

## Limits and gotchas

- **`DEPLO_SECRET` cannot be rotated.** There is no key versioning. Treat it as
  permanent.
- **Deplo pushes no images to a registry**, so rebuilding an app after losing
  its server means rebuilding from source. Keep the source somewhere that is not
  that machine.
- **Backup artifacts survive their target's deletion** for a keep window, so a
  deleted-by-mistake app is usually still recoverable.

## See also

- [Backups and restore](../guides/backups-and-restore.md)
- [Server roles](../advanced/server-roles.md) - a backups-only box
- [Upgrade](upgrade.md)
- [Environment variables reference](../reference/environment-variables.md)
