import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { makeEmptyTestPg } from "./test-harness";

const MIG_DIR = path.join(process.cwd(), "lib", "db", "migrations");
const DROP = "0265_drop_gravatar.sql";
const FACE = "pixelbot:terminal:zoe";
const PICTURE = "data:image/png;base64,iVBORw0KGgo=";

let pg: PGlite;

async function applyFile(file: string): Promise<void> {
  const sql = readFileSync(path.join(MIG_DIR, file), "utf8");
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const s = chunk.trim();
    if (s) await pg.exec(s);
  }
}

before(async () => {
  pg = await makeEmptyTestPg();
  const files = readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    if (f === DROP) break;
    await applyFile(f);
  }
  await pg.exec(`insert into instance_settings (id, gravatar_enabled, updated_at)
                 values ('default', true, now());`);
  for (const [id, image] of [
    ["usr_gravatar", "gravatar"],
    ["usr_face", FACE],
    ["usr_picture", PICTURE],
    ["usr_none", null],
  ])
    await pg.query(
      `insert into users (id, email, username, name, role, avatar_color, image, created_at)
       values ($1, $1 || '@example.io', $1, $1, 'member', '#abc', $2, now())`,
      [id, image],
    );
  await applyFile(DROP);
});

after(async () => {
  await pg.close();
});

test("0265: a saved Gravatar choice falls back to the letters, every other picture stays", async () => {
  const rows = (
    await pg.query<{ id: string; image: string | null }>(
      "select id, image from users order by id",
    )
  ).rows;
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.image])), {
    usr_face: FACE,
    usr_gravatar: null,
    usr_none: null,
    usr_picture: PICTURE,
  });
});

test("0265: the instance switch is gone", async () => {
  const cols = (
    await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'instance_settings' and column_name = 'gravatar_enabled'`,
    )
  ).rows;
  assert.equal(cols.length, 0);
});
