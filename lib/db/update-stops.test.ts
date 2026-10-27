import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { DEPLO_VERSION } from "../version";
import { applyMigrations, migrateOnBoot, type BootStops } from "./migrate";
import { makeEmptyTestPg } from "./test-harness";
import {
  readPassedStops,
  stopPassed,
  UpdateRefusedError,
  type RawQuery,
} from "./update-stops";

const MIG_DIR = path.join(process.cwd(), "lib", "db", "migrations");
const STOPS = "0200_passed_update_stops";
const dirs: string[] = [];

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A migrations folder: an older release's migration, the one that adds the record, and a later release's.
function release({ record = true, next = false } = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deplo-stops-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "meta"));
  writeFileSync(
    path.join(dir, "0000_old.sql"),
    "CREATE TABLE old_release (id text);",
  );
  const entries = [
    { idx: 0, version: "7", when: 1, tag: "0000_old", breakpoints: true },
  ];
  if (record) {
    copyFileSync(
      path.join(MIG_DIR, `${STOPS}.sql`),
      path.join(dir, `${STOPS}.sql`),
    );
    entries.push({
      idx: 1,
      version: "7",
      when: 2,
      tag: STOPS,
      breakpoints: true,
    });
  }
  if (next) {
    writeFileSync(
      path.join(dir, "0002_next.sql"),
      "CREATE TABLE next_release (id text);",
    );
    entries.push({
      idx: 2,
      version: "7",
      when: 3,
      tag: "0002_next",
      breakpoints: true,
    });
  }
  writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
  return dir;
}

// The migrator as runMigrations wires it, on this release's folder.
const migrator = (pg: PGlite, folder: string) => (alsoRun: string[]) =>
  applyMigrations(drizzle(pg), folder, alsoRun);

async function boot(
  pg: PGlite,
  folder: string,
  stops?: BootStops,
): Promise<RawQuery> {
  const query: RawQuery = (text, params) => pg.query(text, params);
  await migrateOnBoot(query, migrator(pg, folder), stops);
  return query;
}

// What a refused boot must leave exactly as it found it.
async function schemaOf(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ t: string }>(
    "SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema IN ('public', 'drizzle') ORDER BY 1",
  );
  const n = await pg.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
  );
  return [...r.rows.map((row) => row.t), `${n.rows[0].n} migrations`];
}

const STOP = "0.5.1-canary.10";

test("a database never migrated before has passed every stop up to this release, on every later boot too", async () => {
  const pg = await makeEmptyTestPg();
  try {
    const folder = release();
    for (let n = 0; n < 2; n++) {
      const passed = await readPassedStops(await boot(pg, folder));
      assert.equal(stopPassed(DEPLO_VERSION, passed), true);
      assert.equal(stopPassed("0.0.1", passed), true);
      assert.equal(
        stopPassed("99.0.0", passed),
        false,
        "a later stop is passed by running it",
      );
    }
  } finally {
    await pg.close();
  }
});

test("an instance updated from an older release has passed nothing until a stop records it", async () => {
  const pg = await makeEmptyTestPg();
  try {
    // The older release boots on its own code, which knows nothing of stops.
    await migrate(drizzle(pg), {
      migrationsFolder: release({ record: false }),
    });
    const query: RawQuery = (text, params) => pg.query(text, params);
    assert.deepEqual(
      await readPassedStops(query),
      [],
      "no record on an older schema reads as none",
    );
    await boot(pg, release());
    assert.deepEqual(await readPassedStops(query), []);
  } finally {
    await pg.close();
  }
});

test("a release that requires a stop refuses to start before any migration on an instance that has not passed it", async () => {
  const pg = await makeEmptyTestPg();
  try {
    await migrate(drizzle(pg), {
      migrationsFolder: release({ record: false }),
    });
    const before = await schemaOf(pg);
    const lines: string[] = [];
    await assert.rejects(
      boot(pg, release({ next: true }), {
        requiredStop: STOP,
        log: (line) => lines.push(line),
      }),
      // What the boot hook matches to keep its own failure line out of the log.
      UpdateRefusedError,
    );
    assert.deepEqual(await schemaOf(pg), before, "the database is untouched");
    assert.equal(lines.length, 1, "one line says why");
    assert.match(
      lines[0],
      /^\[deplo\] Update refused: \S.*v0\.5\.1-canary\.10/,
    );
    assert.doesNotMatch(lines[0], /\n|\bport\b|\blink|shell|docker|ssh|http/i);
  } finally {
    await pg.close();
  }
});

test("on the stop, the release after it refuses until the stop has passed, then starts", async () => {
  const pg = await makeEmptyTestPg();
  try {
    await migrate(drizzle(pg), {
      migrationsFolder: release({ record: false }),
    });
    const query = await boot(pg, release());
    const next = release({ next: true });
    const quiet = { requiredStop: STOP, log: () => {} };
    await assert.rejects(boot(pg, next, quiet));
    // What the stop writes the first time its conditions hold.
    await query(
      "INSERT INTO passed_update_stops (version, passed_at) VALUES ($1, now())",
      [STOP],
    );
    await boot(pg, next, quiet);
    assert.ok(
      (await schemaOf(pg)).includes("public.next_release"),
      "its migrations ran",
    );
  } finally {
    await pg.close();
  }
});

test("a fresh install of a release that requires a stop starts, on every later boot too", async () => {
  const pg = await makeEmptyTestPg();
  try {
    const lines: string[] = [];
    const stops = { requiredStop: STOP, log: (l: string) => lines.push(l) };
    for (let n = 0; n < 2; n++) await boot(pg, release({ next: true }), stops);
    assert.deepEqual(lines, []);
    assert.ok((await schemaOf(pg)).includes("public.next_release"));
  } finally {
    await pg.close();
  }
});

// The real journal, through the same drizzle internals runMigrations uses: a drizzle bump that moves them fails here.
test("this release's own migrations apply on a fresh database, with the stop record committed alongside", async () => {
  const pg = await makeEmptyTestPg();
  try {
    const query = await boot(pg, MIG_DIR);
    const journal = JSON.parse(
      readFileSync(path.join(MIG_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    const applied = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
    );
    assert.equal(applied.rows[0].n, journal.entries.length);
    assert.ok(stopPassed(DEPLO_VERSION, await readPassedStops(query)));
  } finally {
    await pg.close();
  }
});

test("a fresh install whose first boot dies right after its migrations still starts the next time", async () => {
  const pg = await makeEmptyTestPg();
  try {
    const folder = release({ next: true });
    const stops = { requiredStop: STOP, log: () => {} };
    const migrateAll = migrator(pg, folder);
    await assert.rejects(
      migrateOnBoot(
        (text, params) => pg.query(text, params),
        async (...args: Parameters<typeof migrateAll>) => {
          await migrateAll(...args);
          throw new Error("the container was stopped");
        },
        stops,
      ),
      /stopped/,
    );
    await boot(pg, folder, stops);
  } finally {
    await pg.close();
  }
});
