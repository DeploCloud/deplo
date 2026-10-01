# ADR-0034: Another Deplo hands its team over itself

**Status**: accepted

## Context

The migration wizard read Dokploy and Coolify ([ADR-0026](0026-a-source-platform-is-one-adapter-behind-one-client.md))
and refused a Deplo address by name. Moving between two Deplo instances (a rented box to a
bigger one, a managed instance to your own) is the case that refusal blocked, and the existing
path cannot simply be pointed at it:

- **The data path would destroy the source.** A volume is read by an agent on its disk, so the
  wizard installs one there ([ADR-0025](0025-a-migration-source-is-a-server-that-hosts-nothing.md)).
  A Deplo host already runs `deplo-agent`, and `install-agent.sh` has one unit, one binary and
  one state dir: the import-only install re-enrols the source's own agent with the target,
  cutting the source off its own machine, and **Finish** then `SelfUninstall`s it.
- **The public API does not carry an app.** Build settings and repositories are write-only over
  GraphQL, and a secret variable has no read path at all.

## Decision

**The source exports itself, and streams its own data.**

- `migrationExport` (a GraphQL `JSON` field, shape and version in
  `lib/migration/deplo/export-shape.ts`) is one read of the active team: projects, apps in
  Deplo's own shape, databases, variables, domains, crons, backups, members, and the real
  volume names each workload keeps on its host (`landedFor`). Gate: whole team plus
  `reveal_secrets`. It is the one place a secret value leaves Deplo decrypted, so every read is
  written to the source's Activity (once per sitting).
- `POST /api/migration/export` (API token) streams one volume or host path of one workload
  through the source's own agent. It refuses a volume the named workload does not mount, and a
  host path outside the app's own files unless the caller is an instance admin with the
  host-volumes grant - the same rule the target applies when it copies one.
- `deplo` is the third adapter behind `MigrationSourceClient`, with one optional addition,
  `dataExport`. When it is set no machine is planned or installed on, and the data move pulls
  from the panel into the target's agents (`sourceDataHost`); the checksum, the stop/start
  cutover and the database verification are unchanged.
- A Deplo token names itself (`deplo_`), so only a Deplo token is ever sent to a Deplo API,
  and a connection to this very instance is refused by a fingerprint derived from `DEPLO_SECRET`.
- `install-agent.sh` refuses an import-only install over an agent another panel enrolled.
- Take over stays Dokploy and Coolify (`TAKEOVER_PLATFORMS`): there is nothing to take over.

## Consequences

- Both sides must run a version that has the export. An older source is told to update, and an
  export version this side does not know is refused rather than half-read.
- Deplo keeps apps outside projects; the import lands in projects, so each folder becomes one
  and the top level becomes one named after the team.
- The shared model gained `nativeBuild`, `nativeResources` and `SourceDomain.generated`, all
  optional, so the other two platforms are untouched and a Deplo source loses no build setting.
- Not carried, and said so in the report: a database's crons, a compose stack's `up` flags, and
  preview settings beyond on/off.
