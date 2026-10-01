import { test, before, after, describe } from "node:test";
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

async function count(table: string, db = pg): Promise<number> {
  const res = await db.query<{ n: number }>(
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

test("results parse as PGlite's own parsers would, from a table of two overrides", async () => {
  const { rows } = await pg.query<Record<string, unknown>>(
    `select array['a','b'] t, array[1,2] i, '{"k":1}'::jsonb j,
       '2026-01-02 03:04:05+00'::timestamptz ts,
       array['2026-01-02 03:04:05+00'::timestamptz] tsa`,
  );
  assert.deepEqual(rows[0], {
    t: ["a", "b"],
    i: [1, 2],
    j: { k: 1 },
    ts: "2026-01-02T03:04:05.000Z",
    tsa: ["2026-01-02T03:04:05.000Z"],
  });
  assert.ok(
    Object.keys(pg.parsers).length <= 2,
    "every query copies this table",
  );
});

describe("one database per worker", () => {
  const FILE = Symbol.for("deplo.test.file");
  const SHARED = Symbol.for("deplo.test.sharedDb");
  const slots = globalThis as unknown as Record<symbol, unknown>;
  let saved: unknown[];
  const asFile = (name: string) => {
    slots[FILE] = name;
    return makeTestDb();
  };

  before(() => {
    saved = [slots[FILE], slots[SHARED]];
    slots[SHARED] = undefined;
  });

  after(async () => {
    await (slots[SHARED] as { close(): Promise<void> } | undefined)?.close();
    [slots[FILE], slots[SHARED]] = saved;
  });

  test("the next file gets the same database back, emptied and reset", async () => {
    const a = await asFile("a.test.ts");
    const work = async (db: PGlite) =>
      (await db.query<{ work_mem: string }>("show work_mem")).rows[0].work_mem;
    const before = await work(a.pg);
    await a.pg.exec(
      "insert into instance_settings (updated_at) values (now()); set work_mem = '77MB'",
    );
    await a.pg.close();
    const b = await asFile("b.test.ts");
    assert.equal(b.pg, a.pg);
    assert.equal(await count("instance_settings", b.pg), 0);
    assert.equal(await work(b.pg), before);
  });

  test("a second database inside one file is its own", async () => {
    const a = await asFile("c.test.ts");
    const b = await makeTestDb();
    assert.notEqual(b.pg, a.pg);
    await b.pg.close();
  });

  test("a file that changed the schema leaves a fresh database to the next", async () => {
    const a = await asFile("d.test.ts");
    await a.pg.exec("create table zz_drift (id int)");
    const b = await asFile("e.test.ts");
    assert.notEqual(b.pg, a.pg);
    await assert.rejects(
      b.pg.query("select 1 from zz_drift"),
      /does not exist/,
    );
  });
});
