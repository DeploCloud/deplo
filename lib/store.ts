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

let cache: DeploData | null = null;
let hydrated = false;
let hydrating: Promise<void> | null = null;

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
      return JSON.parse(readFileSync(DATA_FILE, "utf8")) as DeploData;
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

let writeChain: Promise<void> = Promise.resolve();

function queuePostgresWrite(data: DeploData) {
  // Snapshot so later in-place mutations cannot corrupt an in-flight write.
  const snapshot = JSON.parse(JSON.stringify(data)) as DeploData;
  writeChain = writeChain
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
  if (!USE_PG || hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const existing = await loadDocument();
      if (existing) {
        cache = existing;
      } else {
        cache = buildSeed();
        await saveDocument(cache);
      }
      hydrated = true;
    })();
  }
  await hydrating;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function load(): DeploData {
  if (cache) return cache;
  if (USE_PG) {
    // Reached only if a read happens before hydration. Seed in-memory so the
    // request never crashes; ensureStoreReady() replaces this with the durable
    // document on the next await boundary.
    cache = buildSeed();
    return cache;
  }
  cache = loadFromFile();
  return cache;
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
  if (USE_PG) queuePostgresWrite(data);
  else persistToFile(data);
  return result;
}

/** Reset the store (used by tests / re-seed flows). */
export function reseed(): DeploData {
  cache = buildSeed();
  if (USE_PG) queuePostgresWrite(cache);
  else persistToFile(cache);
  return cache;
}
