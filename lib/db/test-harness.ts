import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PGlite, types } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { isoTimestampParser } from "./timestamp-parser";
import { schema } from "./schema";

export type TestDb = PgliteDatabase<typeof schema>;

const MIGRATIONS = path.join(process.cwd(), "lib", "db", "migrations");

const PARSERS = {
  [types.TIMESTAMPTZ]: isoTimestampParser,
  [types.TIMESTAMP]: isoTimestampParser,
};

function cachePath(): string {
  const h = crypto.createHash("sha256");
  for (const f of fs.readdirSync(MIGRATIONS).sort()) {
    const p = path.join(MIGRATIONS, f);
    if (fs.statSync(p).isFile()) h.update(fs.readFileSync(p));
  }
  return path.join(os.tmpdir(), `deplo-pglite-${h.digest("hex").slice(0, 16)}`);
}

let cacheFile: string | undefined;

export async function makeTestDb(): Promise<{ db: TestDb; pg: PGlite }> {
  cacheFile ??= cachePath();
  if (fs.existsSync(cacheFile)) {
    try {
      const pg = new PGlite({
        loadDataDir: new Blob([fs.readFileSync(cacheFile)]),
        parsers: PARSERS,
      });
      await pg.query("select 1");
      await withFastTruncate(pg);
      return { db: drizzle(pg, { schema }), pg };
    } catch {}
  }

  const pg = new PGlite({ parsers: PARSERS });
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  try {
    const dump = await pg.dumpDataDir("none");
    const tmp = `${cacheFile}.${process.pid}`;
    fs.writeFileSync(tmp, Buffer.from(await dump.arrayBuffer()));
    fs.renameSync(tmp, cacheFile);
  } catch {}
  await withFastTruncate(pg);
  return { db, pg };
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
