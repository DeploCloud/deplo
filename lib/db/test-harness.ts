import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PGlite, types, type PGliteOptions } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { isoTimestampParser } from "./timestamp-parser";
import { schema } from "./schema";

export type TestDb = PgliteDatabase<typeof schema>;

const MIGRATIONS = path.join(process.cwd(), "lib", "db", "migrations");

const PARSERS: Record<number, (x: string) => unknown> = {
  [types.TIMESTAMPTZ]: isoTimestampParser,
  [types.TIMESTAMP]: isoTimestampParser,
};

const PGLITE_VERSION: string = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "node_modules/@electric-sql/pglite/package.json"),
    "utf8",
  ),
).version;

function cachePath(): string {
  const h = crypto.createHash("sha256").update(PGLITE_VERSION);
  for (const f of fs.readdirSync(MIGRATIONS).sort()) {
    const p = path.join(MIGRATIONS, f);
    if (fs.statSync(p).isFile()) h.update(fs.readFileSync(p));
  }
  return path.join(os.tmpdir(), `deplo-pglite-${h.digest("hex").slice(0, 16)}`);
}

let cacheFile: string | undefined;

// lib/test/batch.mjs runs many files in one process and names the current one
// here; booting PGlite costs seconds, so each file gets the worker's one
// database back, emptied, unless the last file changed its schema.
const FILE_KEY = Symbol.for("deplo.test.file");
const SHARED_KEY = Symbol.for("deplo.test.sharedDb");
type Shared = { pg: PGlite; file: unknown; close: () => Promise<void> };
const slots = globalThis as unknown as Record<symbol, unknown>;

export async function makeTestDb(): Promise<{ db: TestDb; pg: PGlite }> {
  const file = slots[FILE_KEY];
  if (file === undefined) return openTestDb();
  const shared = slots[SHARED_KEY] as Shared | undefined;
  if (shared?.file === file) return openTestDb();
  if (shared && (await resetShared(shared.pg))) {
    shared.file = file;
    return { db: drizzle(shared.pg, { schema }), pg: shared.pg };
  }
  await shared?.close().catch(() => {});
  const { db, pg } = await openTestDb();
  await pg.exec(DDL_WATCH);
  const close = pg.close.bind(pg);
  pg.close = async () => {};
  slots[SHARED_KEY] = { pg, file, close } satisfies Shared;
  return { db, pg };
}

const DDL_WATCH = `
CREATE SEQUENCE deplo_test.ddl;
CREATE FUNCTION deplo_test.mark_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
BEGIN
  IF tg_tag <> 'ALTER SEQUENCE' THEN PERFORM nextval('deplo_test.ddl'); END IF;
END $$;
CREATE EVENT TRIGGER deplo_test_ddl ON ddl_command_end EXECUTE FUNCTION deplo_test.mark_ddl();`;

async function resetShared(pg: PGlite): Promise<boolean> {
  try {
    await pg.exec("DISCARD ALL");
    const ddl = await pg.query<{ is_called: boolean }>(
      "select is_called from deplo_test.ddl",
    );
    if (ddl.rows[0].is_called) return false;
    await truncateAll(pg);
    return true;
  } catch {
    return false;
  }
}

async function openTestDb(): Promise<{ db: TestDb; pg: PGlite }> {
  cacheFile ??= cachePath();
  let pg = await loadSnapshot(cacheFile, { parsers: PARSERS });
  if (!pg) {
    pg = await makeEmptyTestPg({ parsers: PARSERS });
    await migrate(drizzle(pg, { schema }), { migrationsFolder: MIGRATIONS });
    await saveSnapshot(pg, cacheFile);
  }
  await withFastTruncate(pg);
  await slimParsers(pg);
  return { db: drizzle(pg, { schema }), pg };
}

// A cluster as initdb leaves it, for a test that applies migrations by hand:
// booting a saved copy skips initdb, which is most of what such a test waits on.
export async function makeEmptyTestPg(
  options: PGliteOptions = {},
): Promise<PGlite> {
  const file = path.join(os.tmpdir(), `deplo-pglite-empty-${PGLITE_VERSION}`);
  const cached = await loadSnapshot(file, options);
  if (cached) return cached;
  const pg = new PGlite(options);
  await pg.waitReady;
  await saveSnapshot(pg, file);
  return pg;
}

async function loadSnapshot(
  file: string,
  options: PGliteOptions,
): Promise<PGlite | null> {
  if (!fs.existsSync(file)) return null;
  try {
    const pg = new PGlite({
      ...options,
      loadDataDir: new Blob([fs.readFileSync(file)]),
    });
    await pg.query("select 1");
    return pg;
  } catch {
    return null;
  }
}

async function saveSnapshot(pg: PGlite, file: string): Promise<void> {
  try {
    const dump = await pg.dumpDataDir("none");
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, Buffer.from(await dump.arrayBuffer()));
    fs.renameSync(tmp, file);
  } catch {}
}

// PGlite copies its parser table into a new object on every query, and the table
// holds one parser per array type: ~1ms a query. Those move to the shared defaults
// it falls back to, so the copy is just the instance's own overrides.
async function slimParsers(pg: PGlite): Promise<void> {
  const shared = types.parsers;
  const arrays = await pg.query<{ oid: number; typarray: number }>(
    "select b.oid, b.typarray from pg_type a join pg_type b on b.oid = a.typelem where a.typcategory = 'A'",
  );
  for (const { oid, typarray } of arrays.rows) {
    const element = PARSERS[oid] ?? shared[oid];
    shared[typarray] ??= (x: string) => types.arrayParser(x, element, typarray);
  }
  pg.parsers = { ...PARSERS };
}

// A real TRUNCATE rewrites every table file in the cascade: ~650ms a reset in
// pglite against ~40ms for DELETEs. Same rows gone, same sequences restarted;
// anything that is not a plain TRUNCATE list runs untouched.
const FAST_TRUNCATE_FN = `
CREATE SCHEMA IF NOT EXISTS deplo_test;
CREATE OR REPLACE FUNCTION deplo_test.truncate(names text[], do_cascade boolean, do_restart boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE rels oid[]; added oid[]; r oid; s text; prev text;
BEGIN
  SELECT array_agg(n::regclass::oid) INTO rels FROM unnest(names) n;
  LOOP
    SELECT array_agg(DISTINCT c.conrelid) INTO added FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid = ANY(rels) AND NOT c.conrelid = ANY(rels);
    EXIT WHEN added IS NULL;
    IF NOT do_cascade THEN
      RAISE EXCEPTION 'cannot truncate a table referenced in a foreign key constraint'
        USING ERRCODE = '0A000';
    END IF;
    rels := rels || added;
  END LOOP;
  prev := current_setting('session_replication_role');
  PERFORM set_config('session_replication_role', 'replica', true);
  FOREACH r IN ARRAY rels LOOP EXECUTE format('delete from %s', r::regclass); END LOOP;
  PERFORM set_config('session_replication_role', prev, true);
  IF do_restart THEN
    FOR s IN SELECT d.objid::regclass::text FROM pg_depend d
      JOIN pg_class c ON c.oid = d.objid AND c.relkind = 'S'
      WHERE d.refobjid = ANY(rels) AND d.deptype IN ('a', 'i')
    LOOP EXECUTE format('alter sequence %s restart', s); END LOOP;
  END IF;
END $$;`;

const TRUNCATE_STMT =
  /^truncate\s+(?:table\s+)?([a-z_][\w.]*(?:\s*,\s*[a-z_][\w.]*)*)(\s+(?:restart|continue)\s+identity)?(\s+(?:cascade|restrict))?$/i;

export function fastTruncateSql(sql: string): string | null {
  const stmts = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (stmts.length === 0) return null;
  const calls: string[] = [];
  for (const stmt of stmts) {
    const m = TRUNCATE_STMT.exec(stmt);
    if (!m) return null;
    const names = m[1].split(",").map((n) => `'${n.trim()}'`);
    const cascade = /cascade/i.test(m[3] ?? "");
    const restart = /restart/i.test(m[2] ?? "");
    calls.push(
      `select deplo_test.truncate(array[${names.join(",")}], ${cascade}, ${restart})`,
    );
  }
  return calls.join(";");
}

async function withFastTruncate(pg: PGlite): Promise<void> {
  await pg.exec(FAST_TRUNCATE_FN);
  const exec = pg.exec.bind(pg);
  const query = pg.query.bind(pg) as PGlite["query"];
  pg.exec = (sql, opts) => exec(fastTruncateSql(sql) ?? sql, opts);
  pg.query = ((sql: string, params?: unknown[], opts?: unknown) => {
    const fast = params?.length ? null : fastTruncateSql(sql);
    return fast && !fast.includes(";")
      ? query(fast, [], opts as never)
      : query(sql, params, opts as never);
  }) as PGlite["query"];
}

// Moves only when some transaction wrote (committed or not), so a sweep can
// skip re-seeding after a call that changed nothing.
export async function writeMark(pg: PGlite): Promise<string> {
  const res = await pg.query<{ x: string }>(
    "select pg_snapshot_xmax(pg_current_snapshot())::text as x",
  );
  return res.rows[0].x;
}

export async function truncateAll(pg: PGlite): Promise<void> {
  await pg.exec(RESET_ALL);
}

const RESET_ALL = `DO $$ DECLARE s text; BEGIN
  SET LOCAL session_replication_role = replica;
  SELECT string_agg(format('delete from public.%I', tablename), '; ') INTO s
    FROM pg_tables WHERE schemaname = 'public';
  IF s IS NOT NULL THEN EXECUTE s; END IF;
  SELECT string_agg(format('alter sequence public.%I restart', sequencename), '; ') INTO s
    FROM pg_sequences WHERE schemaname = 'public';
  IF s IS NOT NULL THEN EXECUTE s; END IF;
END $$;`;
