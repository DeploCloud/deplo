# ADR-0035: A whole Deplo copies onto a new machine, and the old one keeps running

**Status**: accepted (amended 2026-10-05, before any release: the first version handed servers over)

## Context

[ADR-0034](0034-another-deplo-hands-its-team-over-itself.md) moves ONE team into an existing
Deplo by re-creating each object. It cannot move an instance: servers are shared across teams, its
export is written field by field (every table it forgets is silently lost), and re-created objects
get new ids, so every API token, deploy hook and webhook URL breaks.

The first version of this ADR moved a whole Deplo by copying its database and HANDING each server's
agent over to the new one. Apps never stopped, but the old Deplo was finished the moment the first
server switched. The owner's requirement is the opposite: **the old Deplo stays usable exactly as it
was**. A server's agent trusts one control plane, and two control planes commanding the same
servers would deploy, back up and run crons on the same apps twice, so the old Deplo can only keep
working if it keeps its servers.

## Decision

**A Deplo move is a copy. The new Deplo gets a 1:1 copy of the database and runs every app on its
own servers with its data copied in. The old Deplo keeps every server and never stops.**

### The database copy is generic and re-keyed, never the secret

- `lib/deplo-move/tables.ts` classifies EVERY table: copied, skipped, or local. A test fails on an
  unclassified table, so a table added later is a decision, not a silent loss.
- Ids are preserved. Every value sealed with the old secret is opened on the old Deplo and sealed
  again with the new one's. Hashes and passwords travel as they are.
- One `repeatable read` snapshot, streamed as NDJSON, restored in one transaction while the new
  Deplo is frozen: a cut stream leaves it exactly as it was. Both sides run the same schema.
- The old Deplo's server rows never come across. Each old server is mapped onto a server of the new
  Deplo (the new machine by default), and every column that names a server is rewritten through that
  map. Previews and queued teardowns are not copied: they belong to the old servers.

### Every workload is deployed again, then filled

For each database, then each app: the new Deplo deploys it on its mapped server - an app as a copy
of the exact image it runs over there, deployed like a rollback, so no rebuild and no drift - then
stops it, borrows the old workload for the length of its data copy, copies volumes, files and host
paths through the old Deplo's agent, and starts both again.

The borrow is a **lease**: a workload paused on the old Deplo starts again by itself when the lease
lapses, so a new Deplo that dies mid-copy can never leave the old one's apps stopped. While it is
held, the old Deplo refuses to deploy or start that workload, so nothing writes under the copy.

Only data comes across. A host path is copied only when it holds the app's own data: system paths
(the container runtime, `/etc`, `/proc`, the panel's own data) and read-only mounts are left out and
listed, because the new side writes a copied path over whatever is there.

### Two live copies must not collide

- The new Deplo's crons and backup schedules start **paused** until an admin turns them on, so no
  job runs twice by default.
- Copied backup runs are marked `copied_from`: retention never counts them and deleting one removes
  only the row, because the artifact still belongs to the old Deplo's history too.

## Consequences

- Nothing is irreversible: cancelling at any point resumes the old Deplo's paused workloads, tears
  down what the copy deployed and returns the new Deplo to setup. Before the copy commits, the
  progress page's id is enough to cancel; after it, people can sign in and work there, so cancelling
  or finishing without the old Deplo needs an instance admin.
- One workload that keeps failing never holds the rest hostage: an admin skips it and the move
  finishes without it.
- A database's container name is unique per server only, so two that share one cannot land on the
  same new server; the map is refused rather than letting one overwrite the other.
- Traffic follows DNS. Until each domain points at its new server, the old Deplo keeps serving it;
  switching is the user's DNS change, one per domain, and the one place this needs DNS at all.
- Each workload with data is briefly stopped on the old Deplo while its data copies; one without
  data never stops.
- Sessions do not survive the copy: people sign in on the new Deplo with the account they had.
  Passkeys and webhook addresses only follow if the panel keeps its domain.
- The two Deplos then live independently: an API token, a deploy hook or a member exists on both, and
  revoking it on one leaves the other. The old one is retired by uninstalling it, when the owner chooses.
- Backups kept on a server's disk stay on the old server; the new Deplo writes new ones to the
  mapped server's disk.
