# Databases

## What it is

A managed database running on one of your servers: Postgres, MySQL, MariaDB,
MongoDB, Redis or ClickHouse. Deplo provisions it, gives you a connection
string, and handles backups, logs, metrics and a console.

## How it works

A database is provisioned exactly like an app, by the agent on the server you
pick. It runs as its own Compose stack keyed `db-<name>` and joins the shared
`deplo` network, which is what lets your apps reach it **by name** rather than
by IP. The connection string therefore never changes when the container is
recreated.

Images are the official ones, tagged with the version you pick:
`postgres:<v>-alpine`, `mysql:<v>`, `mariadb:<v>`, `mongo:<v>`,
`redis:<v>-alpine` and `clickhouse/clickhouse-server:<v>`.

Credentials are encrypted at rest and masked in the interface. Revealing them
needs `reveal_secrets`.

## Create one

1. Open **Storage**, then the **Databases** tab.
2. Click **New Database**.
3. Pick the engine and the **Version**.
4. Name it.
5. Use **Generate** for the password unless you have a reason not to.
6. Pick the server.
7. Optionally set a **Host port** to expose it outside the server. This needs
   the `canExposePorts` grant, and you should think twice: an app on the same
   Deplo instance does not need it.
8. Click **Create database**.

Then open it and copy the connection string into the app that needs it, as an
environment variable of type **Secret**.

## Connect an app to it

Apps and databases on the same server share the `deplo` network, so the host in
the connection string is the database's stable name. Nothing else is required:
no port publishing, no firewall rule, no IP.

```
DATABASE_URL = postgres://appuser:••••••@db-orders:5432/orders
```

Set it in the app's **Environment** tab as a **Secret**, then redeploy.

## The lifecycle verbs, and which one destroys data

| Action                             | What it does                                                                                                 | Data       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| **Start** / **Stop** / **Restart** | Container lifecycle                                                                                          | kept       |
| **Redeploy**                       | Re-renders the stack and brings it back up. The data-preserving recreate                                     | kept       |
| **Rebuild**                        | Danger Zone. Tears the stack down **with its volume** and provisions a fresh one from the stored credentials | **erased** |
| **Delete**                         | Removes the database and reclaims its volume                                                                 | **erased** |

**Rebuild is a factory reset.** The connection string keeps working because the
engine re-initialises from the same stored credentials, which is exactly what
makes it dangerous: everything looks fine and the data is gone. Restore a backup
afterwards.

**Delete is authoritative.** It refuses unless the host confirms both the
container and the volume are gone, so a half-deleted database cannot linger as a
row pointing at a live volume. If the host is dead and never coming back, a
`force` option appears after the refusal.

## Settings

**Settings -> Connection**

| Field               | Note                                                        |
| ------------------- | ----------------------------------------------------------- |
| **Server**          | Changing it **moves the database**, see below               |
| **Host port**       | Publish it outside the server. `canExposePorts`             |
| **Rotate password** | **New password (optional)**, or leave blank to generate one |

Password rotation runs inside the engine for Postgres, MySQL, MariaDB and
MongoDB, because their users live in the data volume. Redis and ClickHouse take
theirs from the rendered stack, so rotation is a recreate.

**Settings -> Advanced**

| Field              | Note                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Custom image**   | Replaces the derived image. **Version** goes inert while it is set                                                     |
| **Custom command** | Replaces the container command verbatim                                                                                |
| Config files       | **Add file**, give it a **File name** and a **Path in the container**, edit it in the browser, then **Save and apply** |

> **Redis and `--requirepass`.** The default command carries the password. A
> custom command that omits it silently drops authentication, and the interface
> warns you about exactly this.

Config files are how you set `postgresql.conf`, `my.cnf`, `redis.conf` or an
init script without a shell. **Save and apply** writes them next to the stack
and reroutes the container so they take effect.

## Move a database to another server

Change **Server** in **Settings -> Connection**. Deplo stops both sides, streams
the gzipped data volume off the source host and imports it on the destination,
relayed through the control plane because agents cannot talk to each other.

If the copy fails, the database is blocked from starting until you resolve it.
That block is deliberate: an engine started on an emptied volume does not fail,
it quietly initialises a brand-new empty database over your data.

## The other tabs

**Logs**, **Monitoring** and **Backups** work exactly as they do for an app.
**Console** gives you the engine's own shell (`psql`, `mysql`, `redis-cli`)
behind a one-time acknowledgement, and **Cron jobs** runs scheduled commands
inside the container once you turn the switch on.

## Limits and gotchas

- **The username and the logical database name are set at creation and never
  change.** The official images apply them only on first initialisation against
  an empty volume, so afterwards they are display-only. Renaming the database
  itself is just a label change.
- **Neither Redeploy nor Rebuild works while the database is provisioning.**
- **An app's backup schedule does not cover its database.** Databases are backed
  up as databases. Schedule both.
- **`Host port` is a real exposure.** Anything that can reach the server on that
  port can try to log in.
- **Version upgrades are not migrations.** Changing the version tag restarts the
  engine on the same volume, and major-version upgrades of Postgres in
  particular will refuse to start on an older data directory. Dump, rebuild,
  restore.

## If it does not work

- **The app cannot resolve the database name** - they are on different servers.
  The shared network is per host.
- **Authentication fails after a rotate** - the app still has the old string.
  Update the variable and redeploy.
- **Stuck in provisioning** - the agent could not pull the image or the server
  is unreachable. Check the server's health.
- More in [Databases and backups](../troubleshooting/databases-and-backups.md).

## See also

- [Backups and restore](backups-and-restore.md)
- [Persistent storage](persistent-storage.md)
- [Console and files](console-and-files.md)
- [Resource limits](../advanced/resource-limits.md)
