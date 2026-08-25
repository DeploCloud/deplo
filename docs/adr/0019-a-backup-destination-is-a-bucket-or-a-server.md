# A backup destination is a bucket OR a server, and a server's artifacts are always encrypted

## Context

Until now a backup could go to exactly one kind of place: an S3-compatible
bucket. Every open-source competitor makes the same demand, and it has the same
consequence - someone who just wants "keep a copy of my app" has to go sign up
for a bucket, or stand up MinIO, before the most basic safety feature works at
all. That is infrastructure they may not have, demanded as a precondition, on a
platform whose stated job is to use what the user already pays for
(`AGENTS.md`, "Favor derived / live / automatic over manual … using
infrastructure they already have, not asking them to stand up more").

The premise the change rests on is that the artifact was never bucket-shaped. A
database backup is the engine's native dump gzipped; an app backup is a gzipped
tar of its volumes, files dir and compose/env snapshot. Either way it is **one
opaque compressed byte stream**, and agent-side the entire S3 coupling was a
handful of calls with an `io.Reader` → `io.Writer` shape
(`s3client.Upload(ctx, cfg, key, r)` / `s3client.Download(ctx, cfg, key)`). A
file on a disk is as valid a sink as a multipart PUT.

Three facts about the platform then shape every decision below:

- **ADR-0006/0007**: the control plane never touches a host. Every byte of a
  dump is produced, compressed and written by the agent.
- **Agents are a star** (ADR-0006): an agent can neither dial nor trust a peer.
- **The agent takes no host path off the wire.** `agent.proto` states it
  ("no generic 'run this command' RPC - each verb is closed and named") and
  `internal/server/files.go` repeats it ("the root is derived agent-side from the
  slug; a root path is never taken off the wire").

## Decision

**A backup destination has a `kind`: `s3` (a bucket) or `server` (a directory on
a server in the fleet).** `s3_destination` became `backup_destination` - a
rename, so the foreign keys from `backups` and `backup_runs` carry across and no
data moves. `manage_s3` became `manage_backup_destinations`, with the old name
kept as a legacy alias so an API token minted before the rename still works.

### Every team starts with one

A team with no destinations gets one pointing at a server it can reach, lazily,
the way `ensureTeamRoles` works. First run is where the price difference has to
land, not a settings audit, and a backup you have to go shopping for is a
backup that does not exist.

### Every artifact is encrypted, and the wrap lives in the source pipeline

`filippo.io/age`, one X25519 keypair per destination, encryption applied next to
gzip in the producing agent, **not** in the store layer. That placement is the
whole reason the cross-host path is safe:

- The artifact is ciphertext before it leaves the host, so the control plane
  relaying it never holds plaintext.
- The agent WRITING a backup only ever gets the **recipient** (the public key),
  so a storage host produces artifacts it cannot itself read. The identity
  travels only on a restore or a download.
- One integration covers same-host and cross-host, instead of two.

`age` rather than hand-rolled chunked AEAD: correct final-chunk marking against
truncation is ~150 lines of security-critical code for no gain, and `age -d`
already exists as an offline recovery tool on any machine.

**A BUCKET artifact is encrypted too.** This ADR originally scoped encryption to
the `server` kind, on the reading that a bucket is the operator's own storage
with its own at-rest encryption. That was wrong, and the reason is what an app
archive contains: the restore has to write the real `.env` back, so the archive
carries the app's **entire decrypted environment** - every API key, every
database password. Deplo's own model is that a secret is write-only with no
reveal path, and the oldest destination shape was quietly exporting all of them
to somebody else's storage in the clear. So an `s3` destination gets a keypair
like any other, with the same recovery key and the same `.age` suffix.

Destinations created before that keep `age_recipient` NULL and keep writing
plaintext: their existing objects already are, and the extension on each run's
own key is what says which of the two any given artifact is. The agent gates the
new behaviour behind a `backup-encrypt-s3` capability and the control plane
REFUSES to run an encrypted destination against an agent without it - an agent
that ignores the recipient would write plaintext under a `.age` key, and a backup
that is quietly not encrypted is worse than one that did not run.

### An artifact is not trusted input

age proves confidentiality. It does not prove authorship, and the recipient is a
**public** key the storage host is handed on every single backup, so that host
can forge an artifact that decrypts perfectly. An S3 object is weaker still:
anyone with write access to the bucket can replace it.

That mattered because a project restore read the compose YAML **out of the
archive** and handed it to `docker compose up`. A replaced artifact declaring a
bind mount of `/` was root on the restored host. Two changes close it:

- **The control plane's descriptor wins**, and the archive's snapshot is only the
  fallback for a config that no longer exists control-plane side. The descriptor
  arrives over mTLS from the only party the agent trusts, and for any backup of a
  live config the two are identical.
- **Every artifact carries a sha256**, recorded on the run when it is written and
  re-checked before a restore acts on it. A store artifact is a local file, so it
  is verified UP FRONT - before the stack is stopped or a volume wiped. An S3
  object or a relayed stream can only be hashed as it goes past, so the verdict
  lands at the end, which for a project is still before anything is executed.
  `NULL` means a run older than this, and the restore surfaces that rather than
  silently skipping the check.

The relay already computed this digest on both halves and threw it away,
comparing byte counts instead - the check the protocol was designed for and the
one that was never written.

### The recovery key is downloadable, on purpose

This is the second sanctioned exception to "never add a show-secret affordance"
(the first being the basic-auth password), and it is not a concession - it is
what makes encryption safe to ship. If `DEPLO_SECRET` is rotated, or the control
plane is lost in the very disaster the backups exist for, artifacts encrypted to
a key that lives only inside Deplo are unreadable forever. So the age identity is
downloadable by anyone holding `manage_backup_destinations`, the fetch is
recorded in Activity, and the destination card nudges until someone has taken it.

A key shown once, for a destination the platform created on the user's behalf, is
a key nobody has.

### Deleting a target's artifacts is by KEY, never by prefix

The per-target folder looked like a natural delete prefix, and the sweep believed
itself scoped to one destination. It was not: the key carries no destination
segment, and two `server` destinations on one host with no custom path resolve to
the **same** managed folder, so deleting one target's artifacts "in destination
A" also deleted destination B's, then dropped only A's run records. That is
precisely the orphaned-file-plus-dangling-restore-point pair the scoping existed
to prevent, and it is not an exotic setup: the team's seeded default lives in the
managed folder and a hand-added second destination usually lands beside it.
Deletes now enumerate the exact keys from `backup_runs`.

### An artifact outlives its target, but not forever

`backup_runs.database_id` / `app_id` are `ON DELETE SET NULL`, which used to blank
the only columns naming what an artifact belonged to: retention stopped seeing
it, no screen listed it, and on a server destination it was disk nobody could
reclaim without SSH. `target_id` is written at insert and survives the delete, so
those runs stay findable; a daily sweep on the scheduler's lease removes them
after 30 days. Keeping the backups of a deleted app is still the default and
still the right one - it just has an end.

### Cross-host relays through the control plane; cross-host restore is bidi

Agents cannot talk to each other, so an artifact destined for another server's
disk relays exactly as `ExportVolume → ImportVolume` already does for a server
move: `Backup{stream_out}` emits the artifact as `BackupEvent.data` frames and
the control plane feeds them into `WriteStoreFile` on the destination.

The restore direction uses a new **bidirectional** `RestoreFrom` rather than
staging the artifact on the host being restored. Staging would need a full
artifact's worth of free space on exactly the machine that is already in trouble,
plus cleanup that has to survive an agent restart, plus a window in which a
stranded temp file looks like a real artifact.

Which agent handles a destination is a single seam, `destinationServerId`: the
destination's own server for a store, the workload's for S3. Getting it wrong is
silent - retention and delete-with-artifacts would dial the app's host for an
artifact living elsewhere, get "no such file", and either leak the artifact or
block the delete forever.

### The MANAGED root is the agent's own; only a CUSTOM one needs vetting

Creating the store root was gated on a "test the destination" probe, which made
the platform's own auto-seeded default fail its first backup with _"test the
destination first"_, and the only thing that ran a probe required
`manage_backup_destinations`, so a member holding `manage_backups` alone could
not get out of it. The managed root is derived agent-side from `--stack-dir`,
so there is nothing about it to vet: every path creates it on demand. A custom
root still needs a check to mark it, because marking it IS the vetting.

### The root is never trusted, and the sentinel is why

An empty root means the agent's own managed store (`<data-base>/backups`, 0700),
which is the only shape a non-admin can produce. A **custom** root is accepted
only if it carries a `.deplo-backups` sentinel that the agent itself wrote onto
an empty directory. Without that rule, a wire-supplied root plus a
prefix-delete verb is a remotely-driven `rm -rf` running as root, and a typo'd
`/var/lib/docker` would be discovered the first night retention pruned.

The alternative, putting the custom path in a systemd flag, was rejected: it
would mean SSH, which the core mission forbids.

### Writes are atomic

`.partial` → `fsync` → `rename`. An S3 multipart PUT never exposes a partial
object; a file write does, and the control plane could never clean one up (a
failed run owns no object, so no delete is ever issued for it). Without this, a
cancelled or ENOSPC'd backup leaves a truncated artifact sitting at exactly the
key a restore would later hand to the user.

### The store lives in `internal/server`, not its own package

So it reuses `resolveInside` / `normalizeRel` rather than re-deriving path
containment. The obvious re-derivation is wrong in a way that costs everything:
`safepath.Inside` returns the BASE on every failure path, so
`os.RemoveAll(safepath.Inside(root, missingPrefix))` resolves to the root and
deletes every backup on the server, and "the prefix does not exist" is the
ordinary case retention hits any night a target has nothing left to prune. There
is a test named for it.

### Storage-only servers are a real thing

A VPS bought purely to hold backups: agent installed, no Docker. Without explicit
support the host would sit permanently red (the Docker readiness check is
`fail`-severity, health returns `warning` forever) - the product would ship a
screen accusing the user's storage box of being broken for doing exactly what it
was bought for. So `servers.storage_only` skips those two checks, drops the
server from every deploy-target picker, and the installer skips Docker, the
address pools, Traefik and the `docker` supplementary group.

## Consequences

- `backups.destination_id` / `backup_runs.destination_id` are unchanged; every
  existing S3 destination and run keeps working, keys and all.
- A store artifact's key gains `.age`. Existing keys are stored on the run and
  still resolve, because the extension is only computed for NEW runs.
- The GraphQL surface renamed (`S3Destination` → `BackupDestination`, and its
  queries/mutations with it). This is a **breaking change** for bearer-API
  clients, accepted deliberately: leaving a type called `S3Destination` returning
  server folders is the kind of lie someone pays for at 3am.
- `size_bytes` for a relayed backup is the **destination's** count, cross-checked
  against the source's. A filesystem has no ETag, so what the receiving agent
  fsynced is the only durable proof, and a backup that is quietly short is worse
  than one that failed.
- Downloading an artifact is gated on `restore_backups`, not `manage_backups`:
  handing someone the dump gives them every byte the target holds, which is the
  same power a restore gives and strictly more than scheduling one.
- Store destinations only, for download. Pulling an S3 artifact back through the
  control plane would double the transfer to hand over a file the operator can
  already fetch with their own credentials.
- `manage_backup_destinations` is marked **sensitive**. It is not a settings
  chore: it hands over the recovery key, which decrypts every artifact at a
  destination, including backups of apps the holder has no grant on. That is
  strictly more reach than `restore_backups`, which was already marked.
- Wiping a **database's** artifacts needs `delete_databases`, mirroring the
  target's own delete gate. It was `manage_backups`, a capability whose whole
  description is about scheduling.
- An `s3` endpoint may point at a **private address** when an instance admin says
  so (`allow_private_endpoint`). The SSRF guard on both sides is right by default,
  but a self-hosting platform whose provider list offers "MinIO (self-hosted)"
  cannot refuse every ordinary place a self-hosted bucket actually lives.
- A backup schedule carries a **timezone**, like a cron job. UTC-only meant a
  European team's "nightly at 03:00" ran at 04:00 or 05:00 depending on the
  season, with nothing above the field saying so.
- No HTTP `Range` on the download: age's stream is not seekable, so a byte range
  would mean decrypting from zero and discarding the prefix. The route says
  `Accept-Ranges: none` rather than letting a download manager assume resume
  works and produce a corrupt file.
- The relay needed read-side backpressure in `streamEvents`, which
  `exportVolume`/`exportFiles` had silently been missing - an unbounded queue put
  the whole transfer in the control plane's heap. Fixed once, for all three.

## Status

Accepted. The `server` kind ships as **beta**.
