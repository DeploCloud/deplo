import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { fastTruncateSql, makeTestDb, writeMark } from "./test-harness";

let pg: PGlite;

before(async () => {
  ({ pg } = await makeTestDb());
  await pg.exec(`
    create table zz_parent (id int generated always as identity primary key);
    create table zz_child (
      id serial primary key,
      parent_id int references zz_parent(id)
    );
    create table zz_grandchild (child_id int references zz_child(id));
    create table zz_loner (id serial primary key);
  `);
});

after(async () => {
  await pg.close();
});

async function seed() {
  await pg.exec(`
    insert into zz_parent default values;
    insert into zz_child (parent_id) select id from zz_parent;
    insert into zz_grandchild select id from zz_child;
    insert into zz_loner default values;
  `);
}

async function count(table: string): Promise<number> {
  const res = await pg.query<{ n: number }>(
    `select count(*)::int as n from ${table}`,
  );
  return res.rows[0].n;
}

test("only a statement made of plain TRUNCATEs is rewritten", () => {
  assert.equal(fastTruncateSql("select 1"), null);
  assert.equal(fastTruncateSql("truncate table a; select 1"), null);
  assert.equal(fastTruncateSql('truncate "Quoted"'), null);
  assert.equal(fastTruncateSql("truncate only a"), null);
  assert.match(
    fastTruncateSql("truncate table a, b\n  restart identity cascade;")!,
    /array\['a','b'\], true, true/,
  );
});

test("CASCADE empties every table that references the list, and nothing else", async () => {
  await seed();
  await pg.exec("truncate table zz_parent cascade");
  assert.equal(await count("zz_parent"), 0);
  assert.equal(await count("zz_child"), 0);
  assert.equal(await count("zz_grandchild"), 0);
  assert.ok((await count("zz_loner")) > 0);
});

test("without CASCADE a referenced table is refused, as Postgres does", async () => {
  await seed();
  await assert.rejects(
    pg.exec("truncate zz_parent"),
    /referenced in a foreign key/,
  );
  assert.ok((await count("zz_parent")) > 0);
});

test("RESTART IDENTITY restarts the list's sequences; the default continues", async () => {
  await pg.query("truncate zz_loner restart identity");
  await pg.exec("insert into zz_loner default values");
  assert.equal(
    (await pg.query<{ id: number }>("select id from zz_loner")).rows[0].id,
    1,
  );

  await pg.exec("insert into zz_loner default values; truncate zz_loner");
  await pg.exec("insert into zz_loner default values");
  assert.equal(
    (await pg.query<{ id: number }>("select id from zz_loner")).rows[0].id,
    3,
  );
});

test("the write mark moves on a write and holds still on a read", async () => {
  const m0 = await writeMark(pg);
  await pg.query("select count(*) from zz_loner");
  assert.equal(await writeMark(pg), m0);
  await pg.exec("insert into zz_loner default values");
  assert.notEqual(await writeMark(pg), m0);
});
