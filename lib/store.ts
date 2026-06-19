import "server-only";

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type { DeploData } from "./types";
import { buildSeed } from "./seed";
import { migrate } from "./migrate";
import { isPostgresEnabled } from "./db/pg";
import { loadDocument, saveDocument } from "./db/document-store";

/**
 * Control-plane store with two interchangeable backends behind one API:
 *
 *  - Postgres (when `DEPLO_DATABASE_URL` is set)  the production system of
 *    record. The document is hydrated into an in-memory cache once per process
 *    so reads stay synchronous; mutations write through to Postgres.
 *  - Local JSON file (default)  zero-config, so the app runs with no database.
 *
 * `read()`/`mutate()` are synchronous (the data-access layer depends on that).
 * In Postgres mode, call `ensureStoreReady()` (awaited in the dashboard layout
 * and the auth resolver) before the first read so the cache is hydrated.
 */

const DATA_DIR = process.env.DEPLO_DATA_DIR || join(process.cwd(), ".deplo");
const DATA_FILE = join(DATA_DIR, "data.json");
const USE_PG = isPostgresEnabled();

/**
 * Backfill collections added in later versions so a document persisted by an
 * older build never yields `undefined` where the data layer expects an array.
 * Runs on every hydrate from either backend; mutates and returns the same
 * object. Add new top-level collections here when the schema grows.
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
};

const STORE_KEY = Symbol.for("deplo.store.singleton");
const g = globalThis as unknown as { [STORE_KEY]?: StoreState };

const state: StoreState = (g[STORE_KEY] ??= {
  cache: null,
  hydrated: false,
  hydrating: null,
  writeChain: Promise.resolve(),
  dirty: false,
});

/* ------------------------------------------------------------------ */
/* JSON file backend                                                   */
/* ------------------------------------------------------------------ */

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromFile(): DeploData {
  ensureDir();
  if (existsSync(DATA_FILE)) {
    try {
      return normalize(JSON.parse(readFileSync(DATA_FILE, "utf8")) as DeploData);
    } catch {
      // corrupt file  fall through to reseed
    }
  }
  const seeded = buildSeed();
  persistToFile(seeded);
  return seeded;
}

function persistToFile(data: DeploData) {
  ensureDir();
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, DATA_FILE);
}

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
 * Hydrate the in-memory cache from Postgres. Idempotent and safe to call from
 * multiple concurrent requests  the work happens at most once.
 */
export async function ensureStoreReady(): Promise<void> {
  if (!USE_PG || state.hydrated) return;
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
  state.cache = loadFromFile();
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
  else persistToFile(data);
  return result;
}

/** Reset the store (used by tests / re-seed flows). */
export function reseed(): DeploData {
  state.cache = buildSeed();
  state.hydrated = true;
  state.dirty = true;
  if (USE_PG) queuePostgresWrite(state.cache);
  else persistToFile(state.cache);
  return state.cache;
}
