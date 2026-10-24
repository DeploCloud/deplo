import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { nameFromRepo } from "../../components/apps/new-app-wizard/source-hints";
import { seedApp, seedServer } from "../data/app-graph-test-helpers";
import { seedIdentity } from "../data/identity-test-helpers";
import { makeTestDb } from "./test-harness";

const migration = readFileSync(
  path.join(process.cwd(), "lib/db/migrations/0183_normalize_app_names.sql"),
  "utf8",
);

const NAMES = [
  "fenix-ui",
  "media-NWEU-1",
  "n8n",
  "my_api--server",
  "deploD",
  "BlinkMyPC",
  "Web",
  "ndc-eur1-it && xeur",
  "Fenix UI",
];

const slugLike = (n: string) =>
  /^[A-Za-z0-9_-]+$/.test(n) &&
  /[A-Za-z0-9]/.test(n) &&
  (n === n.toLowerCase() || /[-_]/.test(n));

test("0183 titles slug-like app names as a repo import does, once, and keeps slugs", async () => {
  const { db, pg } = await makeTestDb();
  try {
    await seedIdentity(db);
    await seedServer(db);
    for (const [i, name] of NAMES.entries()) {
      await seedApp(db, { id: `app_${i}`, slug: `slug-${i}` });
      await pg.query("update apps set name = $1 where id = $2", [
        name,
        `app_${i}`,
      ]);
    }
    const read = async () =>
      (
        await pg.query<{ name: string; slug: string }>(
          "select name, slug from apps order by id",
        )
      ).rows;

    await pg.exec(migration);
    const once = await read();
    assert.deepEqual(
      once,
      NAMES.map((n, i) => ({
        name: slugLike(n) ? nameFromRepo(n) : n,
        slug: `slug-${i}`,
      })),
    );
    await pg.exec(migration);
    assert.deepEqual(await read(), once);
  } finally {
    await pg.close();
  }
});
