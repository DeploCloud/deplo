# Backups and restore

## What it is

Scheduled, encrypted copies of a database or an app, sent to an S3 bucket **or
to another server's disk**, with a restore that puts them back.

The second destination kind is the point: disaster recovery can use hardware you
already own, instead of requiring a cloud account you were trying to leave.

## How it works

A **destination** is where artifacts go. A **schedule** says what to copy, where,
how often and how many to keep. A **run** is one execution, producing one
artifact.

The work happens on the agent that stands on the data. For a database it is a
dump; for an app it is its data and its configuration. The stream is compressed
and **encrypted before it leaves the process**, with `age`, using one key pair
per destination. The agent only ever receives the public half, so a server
acting as a backup store produces artifacts it cannot itself read.

When the destination lives on a different host than the workload, the bytes
relay through the control plane, because agents cannot dial each other. They
relay as ciphertext: nothing in the middle ever holds your plaintext.

## Add a destination

**Storage -> Destinations -> Add Destination**. Two kinds.

**A folder on a server**

Pick any server in the fleet, including a [storage-only](../advanced/server-roles.md)
box that runs nothing else. Leave the path empty to use the agent's own managed
store.

**An S3-compatible bucket**

| Field                                    | Note                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Provider**                             | AWS, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean, Wasabi, or other                               |
| **Endpoint**, **Region**, bucket, folder | As your provider documents them                                                                       |
| Access key, secret key                   | Encrypted, never returned                                                                             |
| Advanced                                 | Extra provider quirk flags, and an instance-admin-only option for an endpoint inside your own network |

Then click **Test connection**. It is a real probe run by an agent: a bucket
gets a head request, a zero-byte write and a delete, so a read-only key is
correctly reported as failed. A folder gets a resolve, a probe write and a
free-space check.

A failed probe is a normal result, not an error dialog. **Connection log** in
the destination's menu shows the whole sequence, the agent's own message, and
the equivalent commands to reproduce it by hand.

## Save the recovery key

Every destination has one, and the card keeps nudging you until somebody
downloads it. **Download recovery key** in the destination's menu.

It is the private half of the encryption key pair. Two situations make it the
only thing standing between you and permanent loss:

- `DEPLO_SECRET` was rotated or lost, so the stored copy cannot be decrypted.
- The control plane itself is gone, which is exactly the disaster the backups
  were for.

With the file, any artifact from that destination can be decrypted anywhere:

```bash
age -d -i recovery-key.txt backup.sql.gz.age > backup.sql.gz
```

Fetching the key is recorded in the activity trail. It is one of only two places
in Deplo where a secret is deliberately shown.

## Schedule a backup

1. **Storage -> Backups -> New Backup**, or the **Backups** tab of an app or a
   database.
2. Pick the target: one app or one database.
3. Pick the **Destination**.
4. Name it. A name is suggested from the schedule.
5. Set the schedule and its **Timezone**.
6. Set **Keep**.

**Keep is a count, not a number of days.** "Keep 7" means the seven most recent
successful artifacts, whether they were taken over a week or a year. Older ones
are removed after each successful run, and the newest successful artifact is
never removed.

**Back up now** runs one immediately without touching the schedule.

## Restore

**In place and destructive.** It asks you to type the target's name.

- A **database** restore drops and recreates, per engine.
- An **app** restore stops it, wipes its data, unpacks the artifact and brings
  it back up. The app shows a `restoring` status throughout, so the host
  truthfully reporting "nothing running" does not read as a failure.

The artifact's checksum is verified before a single byte is fed to anything. An
artifact taken before checksumming existed says so out loud rather than
skipping the check quietly.

**Restore from file** takes an artifact you are holding yourself. If it is
encrypted, you paste the recovery key.

## Download an artifact

Only from a **server** destination, and it is decrypted on the way out. Bucket
artifacts are not downloadable through Deplo: you already have credentials for
that bucket.

## Limits and gotchas

- **An app schedule does not include its databases.** Schedule the database
  separately. This trips people up more than anything else here.
- **Retention counts successes.** Failed runs do not consume a slot.
- **A skipped hour on a DST change raises a warning** rather than silently
  missing a run.
- **Deleting runs can leave a target with no restore point.** That is why
  `delete_backups` is a separate, flagged capability.
- **A destination on the same server as the workload survives everything except
  losing that server**, which is the failure people actually have. Put at least
  one copy elsewhere.
- **Backups are encrypted, always, both kinds.** There is no plaintext mode.

## If it does not work

- **Test connection fails on a bucket** - most often the key is read-only, or
  the endpoint and region do not match the bucket. Read the **Connection log**.
- **Runs fail with no space** - the destination server's disk is full. The probe
  reports free space; check it there.
- **Restore refuses** - the checksum did not match, or the artifact is encrypted
  with a key this destination does not hold. Use **Restore from file** with the
  recovery key.
- More in [Databases and backups](../troubleshooting/databases-and-backups.md).

## See also

- [Disaster recovery](../operations/disaster-recovery.md) - the whole picture, including the control plane itself
- [Server roles](../advanced/server-roles.md) - a storage-only box
- [Databases](databases.md)
- [`docs/adr/0019`](../adr/0019-a-backup-destination-is-a-bucket-or-a-server.md)
