import "server-only";

import type { DeploData } from "./types";
import { buildSeed } from "./seed";
import { migrate } from "./migrate";
import { isPostgresEnabled, isTestEnv } from "./db/pg";
import { loadDocument, saveDocument } from "./db/document-store";

/**
 * Control-plane store. PostgreSQL is the ONE system of record: the document is
 * hydrated into an in-memory cache once per process so reads stay synchronous,
 * and every mutation writes through to Postgres.
 *
 * `read()`/`mutate()` are synchronous (the data-access layer depends on that).
 * Call `ensureStoreReady()` (awaited in the dashboard layout and the auth
 * resolver) before the first read so the cache is hydrated from Postgres.
 *
 * Configuration is mandatory: outside `node --test`, the store REQUIRES
 * `DEPLO_DATABASE_URL` (see `lib/db/pg.ts`). There is no file-based fallback.
 * Under `node --test` only, with no database configured, persistence is a no-op
 * and the document lives purely in memory so the data-layer tests run without a
 * Postgres instance.
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
 * Backfill collections added in later versions so a document persisted by an
 * older build never yields `undefined` where the data layer expects an array.
 * Runs on every hydrate; mutates and returns the same object. Add new top-level
 * collections here when the schema grows.
 */
function normalize(data: DeploData): DeploData {
  const seed = buildSeed();
  const d = data as unknown as Record<string, unknown>;
  for (const key of Object.keys(seed) as (keyof DeploData)[]) {
    if (d[key] === undefined || d[key] === null) {
      d[key] = seed[key] as unknown;
    }
  }
  // Forward-migrate to the multi-team model (memberships, teamId stamping,
  // per-team notification settings, dropped "hobby" plan). Idempotent.
  return migrate(data);
}

/**
 * Process-global singleton state.
 *
 * In `next dev`, the RSC (react-server) layer and the route-handler / server-
 * action / client layer are compiled into SEPARATE module registries, so a
 * module-level `let cache` would exist as TWO independent variables in the SAME
 * Node process — two caches and two write chains. A whole-document write from
 * one instance then reverts changes made through the other (observed: a GitHub
 * App written by a server action reverted by a background `recordActivity`).
 *
 * Pinning the state on `globalThis` (one V8 isolate per process — there are no
 * worker threads for rendering) collapses all module instances onto ONE cache
 * and ONE serialized write chain. Whole-document writes are then always safe:
 * the single cache already reflects every prior in-process mutation.
 */
type StoreState = {
  cache: DeploData | null;
  hydrated: boolean;
  hydrating: Promise<void> | null;
  writeChain: Promise<void>;
  /**
   * True once a mutate() has been applied to the in-memory cache. Used only to
   * resolve the (rare) race where a sync read/mutate seeds an empty document
   * before hydration: if the seed was mutated we must keep it (it holds real
   * intent and may already be queued for persistence); if it was never touched
   * we discard it in favour of the durable Postgres document.
   */
  dirty: boolean;
  /**
   * Single-flight for the relational-store cut-set backfills (relational-store
   * PLAN §7, Step 2+). Separate from hydration: a migrated cut-set copies from
   * the freshly-hydrated JSONB into its relational tables at most once per
   * process, gated by the `store_migration` marker. `backfilled` flips true once
   * every wired cut-set's gate has returned; `backfilling` is the in-flight run
   * (re-armed to null on failure so the next ensureStoreReady retries — a backfill
   * failure must NOT 500 the request path, PLAN §8).
   */
  backfilled: boolean;
  backfilling: Promise<void> | null;
};

const STORE_KEY = Symbol.for("deplo.store.singleton");
const g = globalThis as unknown as { [STORE_KEY]?: StoreState };

const state: StoreState = (g[STORE_KEY] ??= {
  cache: null,
  hydrated: false,
  hydrating: null,
  writeChain: Promise.resolve(),
  dirty: false,
  backfilled: false,
  backfilling: null,
});

/* ------------------------------------------------------------------ */
/* Postgres backend (write-through, serialized)                        */
/* ------------------------------------------------------------------ */

function queuePostgresWrite(data: DeploData) {
  // Snapshot at enqueue time so later in-place mutations of the shared cache
  // cannot tear an in-flight write. Because every mutate() runs against the one
  // shared cache and serializes onto this one chain, writes hit Postgres in
  // submission order and each carries the full state as of its own enqueue —
  // the last writer's whole-document save never reverts an earlier sibling.
  const snapshot = JSON.parse(JSON.stringify(data)) as DeploData;
  state.writeChain = state.writeChain
    .then(() => saveDocument(snapshot))
    .catch((err) => {
      console.error("[deplo] Failed to persist state to Postgres:", err);
    });
}

/**
 * Run every wired relational-store cut-set backfill once (relational-store PLAN
 * §7, Step 2+). Each cut-set copies its collections from the freshly-hydrated
 * JSONB (`state.cache`) into its relational tables, gated cross-process by the
 * `store_migration` marker + scheduler-lease so it runs at most once even across
 * a rolling-restart double-boot.
 *
 * It must NEVER throw out to the caller: `ensureStoreReady` is awaited on the
 * request path (auth, webhooks, agent bootstrap) and a single-flight that caches
 * a rejected promise would 500 the process for its whole life. A failure here is
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
  const { CUT_SETS } = await import("./db/backfill/markers");
  const db = getDb();
  const owner = `pid-${process.pid}`;
  const doc = state.cache!;

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
}

/**
 * Hydrate the in-memory cache from Postgres AND run the relational-store cut-set
 * backfills. Idempotent and safe to call from multiple concurrent requests — the
 * work happens at most once. In the test-only in-memory mode (no Postgres) this
 * seeds the cache and returns without touching any backend (no backfill).
 */
export async function ensureStoreReady(): Promise<void> {
  if (state.hydrated && state.backfilled) return;
  if (!USE_PG) {
    // Test-only in-memory mode: seed once, never persist, no relational backfill.
    if (!state.cache) state.cache = buildSeed();
    state.hydrated = true;
    state.backfilled = true;
    return;
  }
  if (!state.hydrating) {
    state.hydrating = (async () => {
      const existing = await loadDocument();
      if (existing && !state.dirty) {
        // Durable document exists and nothing has mutated the in-memory seed:
        // the Postgres copy is authoritative. (If a pre-hydration mutate() ran,
        // state.dirty is true and we must NOT clobber it with `existing` — that
        // draft is the live, possibly-already-queued state.)
        state.cache = normalize(existing);
      } else if (state.cache) {
        // Either no durable document yet, or a pre-hydration mutate() already
        // touched the in-memory draft. Persist the live draft as the document.
        state.cache = normalize(state.cache);
        await saveDocument(state.cache);
      } else {
        state.cache = buildSeed();
        await saveDocument(state.cache);
      }
      state.hydrated = true;
    })();
  }
  await state.hydrating;

  // Relational-store cut-set backfills run AFTER hydration (they copy from the
  // freshly-hydrated, normalized JSONB). Gated by its own single-flight so it
  // runs once even under concurrent callers, and re-armed on failure so a
  // transient DB blip doesn't permanently cache a rejection.
  if (!state.backfilled) {
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
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function load(): DeploData {
  if (state.cache) return state.cache;
  if (USE_PG) {
    // Reached only if a sync read()/mutate() runs before ensureStoreReady() has
    // hydrated — e.g. a background runDeployment() whose process never served a
    // request first. Kick off hydration so the durable document is adopted at
    // the next await boundary (ensureStoreReady() will adopt this draft if a
    // mutation has already been applied to it), and seed in-memory so the
    // synchronous caller never crashes.
    void ensureStoreReady();
    if (!state.cache) state.cache = buildSeed();
    return state.cache;
  }
  // Test-only in-memory mode.
  state.cache = buildSeed();
  return state.cache;
}

/** Read the whole store (do not mutate the returned object directly). */
export function read(): DeploData {
  return load();
}

/**
 * Mutate the store atomically. The callback receives a draft it can mutate;
 * its return value is returned to the caller and the draft is persisted.
 */
export function mutate<T>(fn: (data: DeploData) => T): T {
  const data = load();
  const result = fn(data);
  state.dirty = true;
  if (USE_PG) queuePostgresWrite(data);
  return result;
}

/** Reset the store (used by tests / re-seed flows). */
export function reseed(): DeploData {
  state.cache = buildSeed();
  state.hydrated = true;
  // A reseed replaces the whole document; treat the relational backfill as
  // settled too so the next ensureStoreReady doesn't re-run a copy over the
  // fresh seed. (Used by tests in in-memory mode, where USE_PG is false and no
  // relational backfill runs anyway.)
  state.backfilled = true;
  state.dirty = true;
  if (USE_PG) queuePostgresWrite(state.cache);
  return state.cache;
}
