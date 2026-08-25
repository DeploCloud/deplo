# Persistent storage

## What it is

Somewhere for your app to write files that survive a deploy. A container's own
filesystem is thrown away every time it is recreated, so uploads, caches and
databases need a mount.

Everything here is in **Settings -> Storage**, in the **Mounted storage** card.

## How it works

Three kinds, and the interface names them exactly this way.

| Kind       | What it is                                                                              | Needs permission |
| ---------- | --------------------------------------------------------------------------------------- | ---------------- |
| **Volume** | Disk space Deplo creates and looks after for this app. The normal answer                | no               |
| **File**   | A file you write in the browser, placed inside the app. For config files                | no               |
| **Bind**   | A folder that already exists on the server, shared with everything else on that machine | yes              |

A **Volume** is namespaced on the host as `deplo-<slug>-<name>`, so it can never
collide with another team's app and it survives the app changing source. Its
data is never deleted automatically: removing the row stops mounting it, it does
not erase it.

A **File** is written into the app's files directory before the container
starts, and the content is edited right there in the storage editor. That
ordering matters: Docker answers a missing bind source by inventing an empty
directory, which is how a config file silently becomes a folder in other tools.

A **Bind** reaches outside Deplo's control, which is why it needs the "Bind
server folders" permission and why the row reads **Needs permission** instead of
**Advanced** when you do not hold it.

## Add storage

1. Open the app, then **Settings -> Storage**.
2. Click **Add storage** and choose the kind.
3. Fill the source:
   - **Volume**: a **Name** such as `uploads`
   - **File**: the file's path and its content
   - **Bind**: the **Path on the server**, for example `/srv/media`
4. Set the path inside the container, for example `/app/uploads`.
5. For a multi-container app, name the **Container** to mount into.
6. Click **Save storage**, then redeploy.

**The mount path can often be left blank.** For anything Deplo builds, the
working directory is a known fact, so `uploads` is derived to `/app/uploads`. A
prebuilt image or a Compose service has no such fact, and there you must name
the full path.

## Bind options

A **Bind** row has two extra controls, both worth understanding before you use
them:

| Option                                      | What it does                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| **Only what is already there (rprivate)**   | The container sees the folder as it was when it started. The default     |
| **Keep up with the server (rslave)**        | Mounts that appear on the host later become visible inside the container |
| **Let the app read but not change it (ro)** | Read-only                                                                |

The propagation choice is not cosmetic. Without `rslave`, a network share or a
FUSE mount attached after the container started simply never appears inside it,
with no error anywhere.

## Limits and gotchas

- **Storage applies on the next deploy.** Adding a row does not remount a
  running container.
- **Data is never deleted by a redeploy, a source change, or removing the row.**
  Deleting the app is what removes its volumes.
- **A Compose service name that does not exist is a hard error**, deliberately,
  rather than a silent remount somewhere else.
- **Do not put a database's data in a Bind unless you mean it.** A managed
  [database](databases.md) already has its own managed volume.
- **Backups of an app include its files.** They do not include its databases.

## If it does not work

- **The app writes and the data disappears on deploy** - the path it writes to
  is not mounted. Check what the framework actually uses.
- **Permission denied inside the container** - the container's user does not own
  the directory. For a **Bind**, fix ownership on the server; for a **Volume**,
  make sure the image creates the directory as its own user.
- **A Bind row will not save** - you do not hold the permission. Ask an
  administrator, and see [Host access and privileges](../advanced/host-access-and-privileges.md).

## See also

- [Databases](databases.md)
- [Backups and restore](backups-and-restore.md)
- [Console and files](console-and-files.md) - browsing what is actually there
- [Host access and privileges](../advanced/host-access-and-privileges.md)
