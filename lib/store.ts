import "server-only";

import { isPostgresEnabled, isTestEnv } from "./db/pg";
import { loadDocument } from "./db/document-store";

/**
 * Control-plane store — the relational-store cut-set BACKFILL GATE only
 * (relational-store PLAN Step 6 "Cutover").
 *
 * The whole control plane is RELATIONAL now: every collection lives in its own
 * Postgres table and the data layer queries it directly (`await`). The in-memory
 * JSONB cache, the synchronous `read()`/`mutate()` API, the serialized
 * `queuePostgresWrite`/`writeChain`, the `state.dirty` seed-then-adopt crutch, and
 * `reseed()` are all GONE — there is no in-memory document to read or mutate.
 *
 * What remains is `ensureStoreReady()`: it runs each cut-set's one-time backfill
 * (copy the legacy `deplo_state` JSONB into the relational tables) at most once per
 * process, gated by the `store_migration` markers. It is awaited on the request
 * path (the dashboard layout, the auth resolver, the GraphQL context, the
 * webhook / agent-bootstrap routes), and is a NO-OP once all five markers exist
 * (every migrated instance, and every fresh install after the first boot).
 *
 * The legacy `deplo_state` row + `document-store.ts` are deliberately KEPT as the
 * rollback artifact for the pre-leaf-cut-set window (PLAN §3/§7); a much-later
 * Step 7 drops them after production soak.
 *
 * Configuration is mandatory: outside `node --test`, this REQUIRES
 * `DEPLO_DATABASE_URL` (see `lib/db/pg.ts`). Under `node --test` only, with no
 * database configured, the gate is a no-op (the data-layer tests inject a pglite
 * client via `__setTestDb` and seed the relational tables directly).
 */

const USE_PG = isPostgresEnabled();

if (!USE_PG && !isTestEnv()) {
  // Fail fast at module load: a real run with no database is a misconfiguration,
  // not a silent fall-through to ephemeral in-memory data.
  throw new Error(
    "DEPLO_DATABASE_URL is required. Deplo uses PostgreSQL as its only " +
      "control-plane data store; set DEPLO_DATABASE_URL (or DATABASE_URL) to " +
      "a Postgres connection string."
  );
}

/**
 * Process-global single-flight for the relational-store cut-set backfills
 * (relational-store PLAN §7). A migrated cut-set copies from the legacy
 * `deplo_state` JSONB into its relational tables at most once per process, gated
 * cross-process by the `store_migration` marker + scheduler-lease. `backfilled`
 * flips true once every wired cut-set's gate has returned; `backfilling` is the
 * in-flight run (re-armed to null on failure so the NEXT `ensureStoreReady`
 * retries — a backfill failure must NOT 500 the request path, PLAN §8).
 *
 * Pinned on `globalThis` with the same `Symbol.for` pattern `lib/db/client.ts`
 * uses: in `next dev` the RSC and route-handler layers compile into SEPARATE
 * module registries, so a plain module-level `let` would exist as two independent
 * single-flights in one process and run the gate twice.
 */
type StoreState = {
  backfilled: boolean;
  backfilling: Promise<void> | null;
};

const STORE_KEY = Symbol.for("deplo.store.singleton");
const g = globalThis as unknown as { [STORE_KEY]?: StoreState };

const state: StoreState = (g[STORE_KEY] ??= {
  backfilled: false,
  backfilling: null,
});

/**
 * Run every wired relational-store cut-set backfill once (relational-store PLAN
 * §7). Each cut-set copies its collections from the legacy `deplo_state` JSONB
 * (loaded fresh via `loadDocument()`) into its relational tables, gated
 * cross-process by the `store_migration` marker + scheduler-lease so it runs at
 * most once even across a rolling-restart double-boot. A fresh install (no legacy
 * document) copies zero rows and still writes the markers.
 *
 * It must NEVER throw out to the caller: `ensureStoreReady` is awaited on the
 * request path (auth, webhooks, agent bootstrap) and a single-flight that caches a
 * rejected promise would 500 the process for its whole life. A failure here is
 * caught, logged, and the single-flight re-armed so the NEXT ensureStoreReady
 * retries (the marker makes a successful re-run a no-op). Dynamically imported so
 * the relational layer never loads on the test in-memory path (guarded by the
 * USE_PG caller) and to avoid a static import cycle through `lib/store`.
 */
async function runCutSetBackfills(): Promise<void> {
  const { getDb } = await import("./db/client");
  const { awaitBackfill } = await import("./db/backfill/gate");
  const { runBackfill } = await import("./db/backfill/engine");
  const { leafCutSetCopy } = await import("./db/backfill/cut-sets/leaf");
  const { identityCutSetCopy } = await import(
    "./db/backfill/cut-sets/identity"
  );
  const { projectGraphCutSetCopy } = await import(
    "./db/backfill/cut-sets/project-graph"
  );
  const { backupsCutSetCopy } = await import("./db/backfill/cut-sets/backups");
  const { infraCutSetCopy } = await import("./db/backfill/cut-sets/infra");
  const { CUT_SETS } = await import("./db/backfill/markers");
  const db = getDb();
  const owner = `pid-${process.pid}`;
  // The legacy JSONB document is the backfill source. Absent on a fresh install →
  // each cut-set copies zero rows and just writes its marker. (Not normalized
  // here; `runBackfill` runs the read-time normalizer before each copy.)
  const doc = (await loadDocument()) ?? (await import("./seed")).buildSeed();

  // Cut-set (a) — leaf collections (Step 2). Add later cut-sets here in order.
  await awaitBackfill(db, CUT_SETS.leaf, owner, () =>
    runBackfill(db, CUT_SETS.leaf, doc, leafCutSetCopy),
  );

  // Cut-set (b) — identity / auth (Step 3). Ordered AFTER the leaf cut-set: it is
  // the authoritative owner of the teams/users roots the leaf cut-set seeded, and
  // its copy no-ops over those via onConflictDoNothing.
  await awaitBackfill(db, CUT_SETS.identity, owner, () =>
    runBackfill(db, CUT_SETS.identity, doc, identityCutSetCopy),
  );

  // Cut-set (c) — project graph (Step 4). Ordered AFTER identity: its NOT-NULL
  // team FKs are now owned relationally by (b). It seeds `servers` (the bridge
  // seed; cut-set (e) owns servers authoritatively) for the project RESTRICT FK,
  // prunes the live deleteProject orphans, and migrates the team ordering arrays.
  await awaitBackfill(db, CUT_SETS.projectGraph, owner, () =>
    runBackfill(db, CUT_SETS.projectGraph, doc, projectGraphCutSetCopy),
  );

  // Cut-set (d) — backups (Step 5). Ordered after the project graph: a backup
  // target FKs a database / project / destination, so it copies `s3_destination` +
  // `databases` first, then `backups` + `backup_runs`.
  await awaitBackfill(db, CUT_SETS.backups, owner, () =>
    runBackfill(db, CUT_SETS.backups, doc, backupsCutSetCopy),
  );

  // Cut-set (e) — infra / integrations (Step 6). Ordered LAST: the authoritative
  // copy of `servers` (cut-sets (c)/(d) only bridge-seeded it), plus the
  // collections a–d never migrated: invites, github_apps(+installation),
  // dev_ssh_user, activities. Its FKs reference teams (b) and projects (c).
  await awaitBackfill(db, CUT_SETS.infra, owner, () =>
    runBackfill(db, CUT_SETS.infra, doc, infraCutSetCopy),
  );
}

/**
 * Run every wired relational-store cut-set backfill once (idempotent; safe under
 * concurrent callers — the work happens at most once via the single-flight + the
 * `store_migration` markers). A no-op once all markers exist. In the test-only
 * in-memory mode (no Postgres) it returns immediately (tests inject a pglite
 * client and seed the relational tables directly).
 *
 * It MUST NOT 500 the process on failure (PLAN §8): the single-flight is re-armed
 * on a rejected run so a transient DB blip retries on the next call rather than
 * caching the rejection for the life of the process.
 */
export async function ensureStoreReady(): Promise<void> {
  if (state.backfilled) return;
  if (!USE_PG) {
    // Test-only in-memory mode: no relational backfill (the data-layer tests seed
    // pglite directly via __setTestDb).
    state.backfilled = true;
    return;
  }
  if (!state.backfilling) {
    state.backfilling = runCutSetBackfills().then(
      () => {
        state.backfilled = true;
      },
      (err) => {
        console.error(
          "[deplo] relational-store backfill failed; will retry on the next ensureStoreReady:",
          err,
        );
        // Re-arm so the next call retries (the marker makes a good run a no-op).
        state.backfilling = null;
      },
    );
  }
  await state.backfilling;
}
