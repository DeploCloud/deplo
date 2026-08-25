# Databases and backups

## An app cannot reach its database

| Check                                                     | Why                                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Are they on the **same server**?                          | The shared `deplo` network is per host. An app on server A cannot resolve a database on server B by name |
| Is the host in the connection string the database's name? | Not an IP, not `localhost`                                                                               |
| Is the database running?                                  | Its status badge                                                                                         |
| Did the password change?                                  | Rotating it does not update the app's variable. Update it and redeploy                                   |
| Did you redeploy after setting the variable?              | Variables apply on the next deploy                                                                       |

## A database will not start

- **Stuck on `provisioning`**: the agent could not pull the image, or the server
  is unreachable. Neither Redeploy nor Rebuild works while provisioning.
- **After a version change**: a major version bump will not start on an older
  data directory. Postgres in particular refuses. Dump, rebuild, restore.
- **After a custom command**: for Redis, the default command carries
  `--requirepass`. A custom command that omits it drops authentication, and
  anything expecting a password then fails.
- **After a server move, with a data-copy error**: that block is deliberate and
  it is protecting you. An engine started on an emptied volume does not fail, it
  initialises a brand-new empty database over your data. Resolve the copy, or
  restore from a backup.

## The data is gone after a Rebuild

**Rebuild is a factory reset.** It tears the stack down with its volume and
provisions a fresh one from the stored credentials, which is why the connection
string still works and everything looks fine.

**Redeploy** is the data-preserving verb. Restore a backup.

## Deleting a database is refused

Deletion is authoritative: it refuses unless the host confirms both the
container and the volume are gone, so a half-deleted database cannot linger as a
row pointing at a live volume.

If the host is dead and never coming back, a `force` option appears after the
refusal.

## A backup destination test fails

A failed probe is a normal result, not an error dialog. Open **Connection log**
in the destination's menu: it shows the whole probe sequence, the agent's own
message, and the equivalent commands to reproduce by hand.

| Symptom                       | Usual cause                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A bucket fails on write       | The key is read-only. The probe writes a zero-byte object on purpose, so a read-only key correctly reads as failed |
| A bucket fails on head        | Wrong endpoint or region for that bucket                                                                           |
| A folder fails to resolve     | The path does not exist on that server, or the agent cannot write there                                            |
| Anything on a private address | The outbound guard refuses non-public endpoints unless an instance admin allowed it                                |

## Backup runs fail

- **No space** on the destination server. The probe reports free space.
- **The workload is not running.** A backup reads from the live target.
- **The server is unreachable.** Check its health.

## The app's data was not in the backup

**An app schedule does not include its databases.** They are backed up as
databases. Schedule both.

## A restore refuses

- **The checksum did not match.** The artifact is corrupt, and Deplo verifies
  before feeding a single byte to anything.
- **It is encrypted with a key this destination does not hold.** Use **Restore
  from file** and paste the recovery key.
- **The target name typed does not match.** A restore is destructive and asks
  you to type it.

## An artifact will not decrypt

Every artifact is encrypted with `age`, one key pair per destination.

```bash
age -d -i recovery-key.txt backup.sql.gz.age > backup.sql.gz
```

If you do not have the recovery key, download it from the destination's menu.
If the control plane itself is gone, the downloaded copy is the **only** way,
which is exactly why the card nags until somebody saves it.

## Old backups are disappearing

**Keep is a count, not a number of days.** "Keep 7" means the seven most recent
successful artifacts. Older ones are removed after each successful run, and the
newest successful artifact is never removed.

## See also

- [Databases](../guides/databases.md)
- [Backups and restore](../guides/backups-and-restore.md)
- [Disaster recovery](../operations/disaster-recovery.md)
