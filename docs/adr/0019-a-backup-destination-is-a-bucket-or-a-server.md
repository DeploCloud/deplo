# A backup destination is a bucket OR a server, and a server's artifacts are always encrypted

## Context

Until now a backup could go to exactly one kind of place: an S3-compatible
bucket. Every open-source competitor makes the same demand, and it has the same
consequence — someone who just wants "keep a copy of my app" has to go sign up
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
  ("no generic 'run this command' RPC — each verb is closed and named") and
  `internal/server/files.go` repeats it ("the root is derived agent-side from the
  slug; a root path is never taken off the wire").

## Decision

**A backup destination has a `kind`: `s3` (a bucket) or `server` (a directory on
a server in the fleet).** `s3_destination` became `backup_destination` — a
rename, so the foreign keys from `backups` and `backup_runs` carry across and no
data moves. `manage_s3` became `manage_backup_destinations`, with the old name
kept as a legacy alias so an API token minted before the rename still works.

### Every team starts with one

A team with no destinations gets one pointing at a server it can reach, lazily,
the way `ensureTeamRoles` works. First run is where the price difference has to
land, not a settings audit — and a backup you have to go shopping for is a
backup that does not exist.

### Store artifacts are ALWAYS encrypted, and the wrap lives in the source pipeline

`filippo.io/age`, one X25519 keypair per destination, encryption applied next to
gzip in the producing agent — **not** in the store layer. That placement is the
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

### The recovery key is downloadable, on purpose

This is the second sanctioned exception to "never add a show-secret affordance"
(the first being the basic-auth password), and it is not a concession — it is
what makes encryption safe to ship. If `DEPLO_SECRET` is rotated, or the control
plane is lost in the very disaster the backups exist for, artifacts encrypted to
a key that lives only inside Deplo are unreadable forever. So the age identity is
downloadable by anyone holding `manage_backup_destinations`, the fetch is
recorded in Activity, and the destination card nudges until someone has taken it.

A key shown once, for a destination the platform created on the user's behalf, is
a key nobody has.

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
silent — retention and delete-with-artifacts would dial the app's host for an
artifact living elsewhere, get "no such file", and either leak the artifact or
block the delete forever.

### The root is never trusted, and the sentinel is why

An empty root means the agent's own managed store (`<data-base>/backups`, 0700),
which is the only shape a non-admin can produce. A **custom** root is accepted
only if it carries a `.deplo-backups` sentinel that the agent itself wrote onto
an empty directory. Without that rule, a wire-supplied root plus a
prefix-delete verb is a remotely-driven `rm -rf` running as root, and a typo'd
`/var/lib/docker` would be discovered the first night retention pruned.

The alternative — putting the custom path in a systemd flag — was rejected: it
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
deletes every backup on the server — and "the prefix does not exist" is the
ordinary case retention hits any night a target has nothing left to prune. There
is a test named for it.

### Storage-only servers are a real thing

A VPS bought purely to hold backups: agent installed, no Docker. Without explicit
support the host would sit permanently red (the Docker readiness check is
`fail`-severity, health returns `warning` forever) — the product would ship a
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
  fsynced is the only durable proof — and a backup that is quietly short is worse
  than one that failed.
- Downloading an artifact is gated on `restore_backups`, not `manage_backups`:
  handing someone the dump gives them every byte the target holds, which is the
  same power a restore gives and strictly more than scheduling one.
- Store destinations only, for download. Pulling an S3 artifact back through the
  control plane would double the transfer to hand over a file the operator can
  already fetch with their own credentials.
- No HTTP `Range` on the download: age's stream is not seekable, so a byte range
  would mean decrypting from zero and discarding the prefix. The route says
  `Accept-Ranges: none` rather than letting a download manager assume resume
  works and produce a corrupt file.
- The relay needed read-side backpressure in `streamEvents`, which
  `exportVolume`/`exportFiles` had silently been missing — an unbounded queue put
  the whole transfer in the control plane's heap. Fixed once, for all three.

## Status

Accepted. The `server` kind ships as **beta**.
