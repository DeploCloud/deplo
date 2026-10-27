import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { DEPLO_VERSION } from "../version";
import { migrateOnBoot } from "./migrate";
import { makeEmptyTestPg } from "./test-harness";
import { readPassedStops, stopPassed, type RawQuery } from "./update-stops";

const MIG_DIR = path.join(process.cwd(), "lib", "db", "migrations");
const STOPS = "0200_passed_update_stops";
const dirs: string[] = [];

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A migrations folder holding an older release's migration and, optionally, the one that adds the record.
function release(withRecord: boolean): string {
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
  if (withRecord) {
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
  writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
  return dir;
}

async function boot(pg: PGlite, folder: string): Promise<RawQuery> {
  const query: RawQuery = (text, params) => pg.query(text, params);
  await migrateOnBoot(query, () =>
    migrate(drizzle(pg), { migrationsFolder: folder }),
  );
  return query;
}

test("a database never migrated before has passed every stop up to this release, on every later boot too", async () => {
  const pg = await makeEmptyTestPg();
  try {
    const folder = release(true);
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
    await migrate(drizzle(pg), { migrationsFolder: release(false) });
    const query: RawQuery = (text, params) => pg.query(text, params);
    assert.deepEqual(
      await readPassedStops(query),
      [],
      "no record on an older schema reads as none",
    );
    await boot(pg, release(true));
    assert.deepEqual(await readPassedStops(query), []);
  } finally {
    await pg.close();
  }
});
