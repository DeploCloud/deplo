# ADR-0026: A source platform is one adapter behind one client interface

**Status**: accepted

## Context

The migration wizard read exactly one product. Every file said so - `lib/dokploy/*`,
`lib/data/dokploy-*.ts`, ten `*Dokploy*` mutations, five `dokploy_*` tables - and every mapper
note said so out loud: _"Runs on Dokploy instead of a plain postgres"_.

Adding Coolify meant deciding where the second product attaches. Two seams were available and
they cost very different things:

- **The client.** Eleven functions the importer actually calls (`listProjects`, `getService`,
  `stopService`, ...). Already an interface in all but name.
- **The row shapes.** `DokployApplication` and its siblings, read field by field by ~5000 lines
  of mapper and importer. Coolify's rows fold onto them almost exactly - a `fqdn` list becomes
  domains, `persistent_storages` becomes mounts - but rewriting the field names would be a
  thousand-line diff through the one path that already works.

A third option was a module of `if (kind === "coolify")` dispatchers. It substitutes just as
well, but two of the eleven calls are not one shape of question: Coolify has no
`docker.getConfig` and no container list, so `sourceState` would have had to be handed a
**fabricated** inspect result, and Coolify's per-resource network cannot be a constant.

## Decision

**The seam is the client, and only the client.** `lib/migration/source.ts` declares
`MigrationSourceClient`; `sourceClient(credential)` is the one place a platform becomes code.
Each product is a folder under `lib/migration/<name>/` with a transport client and a pure mapper
that answers in the shared row shapes of `lib/migration/model.ts`.

Consequences that follow from it:

- **The row shapes are shared, renamed neutral** (`SourceApplication`, `SourceCompose`, ...).
  They started as one product's; they are now the model an adapter answers in.
- **Two methods exist because the question differs, not the answer.** `serviceRuntime` (what a
  service mounts right now) and `platformNetworks` (which networks belong to the platform rather
  than to the stack) are per-adapter by construction.
- **A mapper never names a product.** It writes `{panel}` and the report resolves it from the
  run's platform, because a Coolify migration that said what happened "on Dokploy" would simply
  be wrong.
- **The platform is decided once, at Connect, and stored** (`migration_runs.platform`). A run
  resumes hours later from that row; re-detecting could answer differently and would point the
  data cutover - the destructive half - at the wrong API.
- **The whole domain is renamed to `migration`**, wire and tables included. The old `import`
  spelling was defended on the grounds that renaming a published schema breaks the MCP tools; no
  MCP tool names a field here, and `scanDokploy` pointed at a Coolify panel was worse than an
  old name.

## Consequences

- A third product is one folder and one line in `sourceClient()`. Nothing above the seam changes.
- The invariant that says the seam is in the right place is a test one: the ~200 tests of the
  first platform pass unmodified. If a change to the shared path forces edits across that suite,
  the seam has moved to the wrong layer.
- Two engines have no twin here (`keydb`, `dragonfly`) and are refused by name rather than
  forgotten - the same treatment `libsql` already had.
- Coolify hides secrets from a token without `read:sensitive` by DROPPING the fields, not by
  blanking them. The client asks once, before anything is written, because the alternative is a
  migration that looks like it worked and left every variable empty. That is why the interface
  carries `assertReadable()`.

## Alternatives rejected

- **Dispatch functions instead of an interface.** Same substitutability, but it forces one
  adapter to fake the other's API shape for the two calls that genuinely differ.
- **Adapters that write straight into Deplo.** Every mapping rule - domains, volumes, compose
  networks, the pairing by container path - would then exist once per platform, and the second
  copy would drift from the first the first time either was fixed.
