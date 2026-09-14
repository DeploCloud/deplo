import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PGlite, types } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { isoTimestampParser } from "./timestamp-parser";
import { schema } from "./schema";

// TestDb is a pglite Drizzle client over the full aggregated schema.
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

// makeTestDb builds an isolated in-memory Postgres with every migration applied.
export async function makeTestDb(): Promise<{ db: TestDb; pg: PGlite }> {
  cacheFile ??= cachePath();
  if (fs.existsSync(cacheFile)) {
    try {
      const pg = new PGlite({
        loadDataDir: new Blob([fs.readFileSync(cacheFile)]),
        parsers: PARSERS,
      });
      await pg.query("select 1");
      return { db: drizzle(pg, { schema }), pg };
    } catch {
      // A truncated or unreadable cache is not worth diagnosing: migrate instead.
    }
  }

  const pg = new PGlite({ parsers: PARSERS });
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  try {
    const dump = await pg.dumpDataDir("none");
    const tmp = `${cacheFile}.${process.pid}`;
    fs.writeFileSync(tmp, Buffer.from(await dump.arrayBuffer()));
    fs.renameSync(tmp, cacheFile); // atomic: concurrent test processes may race here
  } catch {
    // Caching is an optimisation; a read-only or full tmpdir just costs time.
  }
  return { db, pg };
}

// truncateAll empties every table and restarts every sequence.
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
