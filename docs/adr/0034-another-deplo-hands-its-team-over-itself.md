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
  host-volumes grant - the same rule the target applies when it copies one. With `upload: true`
  it hands over an upload app's archive instead, read from the source control plane's own disk
  (that is where an archive lives); the target stores it with the app at import time, since it
  is the app's source rather than its data. An export without the `upload` field is from a
  Deplo too old to do this, and the report says the archive needs uploading again.
  With `dump: true` and an age `recipient` it hands over a database as a dump its own engine
  takes while it keeps running, encrypted on the source agent to a key only the target holds.
  With `image: <ref>` it hands over the image an app runs, from that app's own server, and only
  the image the app names; the target asks for it when no registry has that image, and loads it
  on the app's server at import time. An image that cannot be copied is reported as blocking.
- A run may ask for a copy that keeps the source running (`live_copy`, Deplo sources only, an
  advanced option): nothing is stopped there, databases come over as that dump, app volumes are
  read live and each says so, crons and backup schedules land paused, deploy on push lands off
  with no webhook added (turning it on adds one), and the switch-over is left to the user. The target is still stopped before any volume is written into it.
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
- Apps outside projects land where they were: in the same folder tree (matched by name under
  its parent, colour included) or at the top level.
- Roles, each member's role and their per-project, per-folder and per-app access travel when the
  reader may manage members (absent from an older Deplo, and said so). They are rebuilt through
  the same guarded calls as Settings, so the person migrating never hands out more than they hold,
  and only on nodes this run created. A member matched by email to an account already here joins
  able to view only and is then given exactly what they had in one write; anyone whose access
  could not be rebuilt exactly, or who has no account yet, stays at view only and is named in the
  report. Access to a single environment has no writer here yet and is reported the same way.
- The shared model gained `nativeBuild`, `nativeResources` and `SourceDomain.generated`, all
  optional, so the other two platforms are untouched and a Deplo source loses no build setting.
- Backups carry every destination (bucket or server disk) with the key its artifacts are
  encrypted to, every schedule paused or not, and each successful run as a copied run
  ([ADR-0035](0035-a-whole-deplo-copies-onto-a-new-machine.md)): a bucket's restore points stay
  restorable here, a server disk's are named in the report, since only the old Deplo reaches it.
- An app's compose `up` flags, rollback count and deploy hook switch carry as they were. The hook
  never keeps its token: its address names the app, so it changes anyway, and the report says so
  when the old one was ever handed out. An older source sends none of them, and the report says so.
- Git connections travel as `gitConnections`, their tokens only when the reader may manage git
  connections there (`manage_git`). The import reuses a connection here for the same account on
  the same server, or adds one, and attaches it to the app. A GitHub App install cannot move
  between instances, so the app is reported as needing one linked before it deploys.
- Registries travel as `registries`, their passwords only with `manage_registries` there, and
  land once per team (matched by host and username), since every deploy pulls with all of them.
- Preview settings travel whole, as an optional `preview` block plus the preview overrides
  (`previewEnv`), and land even when previews are off; the preview server goes through the
  run's server map. An export without them came from an older Deplo, and only on/off lands.
- Every cron job, on an app or a database, carries all its settings and variables, and the
  target's `cron_enabled` switch comes along, so jobs run here as they ran there once the source is
  stopped. A source older than this sends schedule and command only, and the report says so.
- A domain carries its middlewares, CORS origins, security headers, proxied flag and its www
  redirect. A custom certificate travels with its key only when an instance admin's token reads
  the export (the right to install one), and is installed on the target's server; any other
  lands without one, named as a blocker in the report.
