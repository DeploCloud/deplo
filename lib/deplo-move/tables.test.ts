import { describe, test, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb } from "../db/test-harness";
import {
  MOVE_TABLES,
  copyOrder,
  foreignKeys,
  mergeForeignColumns,
  orderingEdge,
  tableShapes,
  type ForeignKey,
} from "./tables";

const copied = (t: string) => MOVE_TABLES[t]?.kind === "copy";
const fkName = (fk: ForeignKey) =>
  `${fk.table}(${fk.columns}) -> ${fk.foreignTable}(${fk.foreignColumns})`;

function copyPolicies() {
  return Object.entries(MOVE_TABLES).flatMap(([table, p]) =>
    p.kind === "copy" ? [{ table, ...p }] : [],
  );
}

function shape(table: string) {
  const s = tableShapes().get(table);
  assert.ok(s, `${table} is not a table in lib/db/schema.ts`);
  return s;
}

describe("Deplo move table policy", () => {
  let pg: PGlite | undefined;
  after(async () => {
    await pg?.close();
  });

  test("every table in the schema has a policy, and every policy a table", () => {
    const tables = [...tableShapes().keys()].sort();
    const missing = tables.filter((t) => !MOVE_TABLES[t]);
    assert.deepEqual(missing, [], "classify these in lib/deplo-move/tables.ts");
    const stale = Object.keys(MOVE_TABLES).filter((t) => !tableShapes().has(t));
    assert.deepEqual(stale, [], "these policies name no table");
  });

  test("every *_enc column of a copied table is re-keyed with the secrets key", () => {
    for (const [table, p] of Object.entries(MOVE_TABLES)) {
      const enc = shape(table).columns.filter((c) => c.endsWith("_enc"));
      if (p.kind === "local" || enc.length === 0) continue;
      assert.equal(p.kind, "copy", `${table} is skipped but holds secrets`);
      for (const c of enc)
        assert.equal(p.rekey?.[c], "secrets", `${table}.${c} is not re-keyed`);
    }
  });

  test("every column a policy names exists, and the NULL ones may be NULL", () => {
    for (const p of copyPolicies()) {
      const s = shape(p.table);
      const named = [
        ...Object.keys(p.rekey ?? {}),
        ...(p.keepTarget ?? []),
        ...(p.nullOnCopy ?? []),
        ...(p.deferred ?? []),
      ];
      for (const c of named)
        assert.ok(s.columns.includes(c), `${p.table}.${c} does not exist`);
      for (const c of [
        ...(p.nullOnCopy ?? []),
        ...(p.deferred ?? []),
        ...(p.keepTarget ? mergeForeignColumns(p.table) : []),
      ])
        assert.ok(!s.notNull.has(c), `${p.table}.${c} cannot be written NULL`);
      if (p.keepTarget)
        assert.ok(s.primaryKey.length > 0, `${p.table} merges with no key`);
    }
  });

  test("deferred columns are foreign keys the wipe can delete past", () => {
    for (const p of copyPolicies()) {
      for (const c of p.deferred ?? []) {
        const fk = foreignKeys().find(
          (f) => f.table === p.table && f.columns.includes(c),
        );
        assert.ok(fk, `${p.table}.${c} is deferred but is no foreign key`);
        assert.ok(
          ["set null", "cascade"].includes(fk.onDelete),
          `${fkName(fk)} blocks the wipe`,
        );
      }
    }
  });

  test("the copy order holds every copied table once, parents first", () => {
    const order = copyOrder();
    const want = [...tableShapes().keys()].filter(copied).sort();
    assert.deepEqual([...order].sort(), want);
    const at = new Map(order.map((t, i) => [t, i]));
    for (const fk of foreignKeys()) {
      if (!orderingEdge(fk)) continue;
      assert.ok(
        at.get(fk.foreignTable)! < at.get(fk.table)!,
        `${fkName(fk)} is copied child first`,
      );
    }
  });

  test("the copy order is the same on every call and every machine", () => {
    assert.deepEqual(copyOrder(), copyOrder());
    assert.ok(copyOrder().indexOf("users") < copyOrder().indexOf("account"));
    assert.ok(copyOrder().indexOf("apps") < copyOrder().indexOf("deployments"));
    assert.ok(
      copyOrder().indexOf("oauth_client") < copyOrder().indexOf("api_tokens"),
    );
  });

  test("a copied row never points at a table that is not copied", () => {
    for (const fk of foreignKeys()) {
      const p = MOVE_TABLES[fk.table];
      if (p?.kind !== "copy" || copied(fk.foreignTable)) continue;
      for (const c of fk.columns)
        assert.ok(
          p.nullOnCopy?.includes(c),
          `${fkName(fk)}: add ${c} to nullOnCopy`,
        );
    }
  });

  test("a row that is not copied never stops the wipe", () => {
    for (const fk of foreignKeys()) {
      const p = MOVE_TABLES[fk.table];
      if (p?.kind === "copy" || !copied(fk.foreignTable)) continue;
      assert.ok(
        ["set null", "cascade"].includes(fk.onDelete),
        `${fkName(fk)} would block deleting ${fk.foreignTable}`,
      );
    }
  });

  test("every foreign key in the migrated database is one the order knows", async () => {
    ({ pg } = await makeTestDb());
    const res = await pg.query<{
      t: string;
      cols: string[];
      ft: string;
      fcols: string[];
    }>(`
      select c.conrelid::regclass::text as t,
        array(select a.attname::text from unnest(c.conkey) k join pg_attribute a
          on a.attrelid = c.conrelid and a.attnum = k) as cols,
        c.confrelid::regclass::text as ft,
        array(select a.attname::text from unnest(c.confkey) k join pg_attribute a
          on a.attrelid = c.confrelid and a.attnum = k) as fcols
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace`);
    const known = new Set(foreignKeys().map(fkName));
    const unknown = res.rows
      .map((r) =>
        fkName({
          table: r.t.replace(/"/g, ""),
          columns: r.cols,
          foreignTable: r.ft.replace(/"/g, ""),
          foreignColumns: r.fcols,
          onDelete: "",
        }),
      )
      .filter((name) => !known.has(name));
    assert.deepEqual(unknown, [], "add these to SQL_ONLY_FOREIGN_KEYS");
    const deferrable = await pg.query(
      "select conname from pg_constraint where condeferrable",
    );
    assert.deepEqual(deferrable.rows, []);
  });
});
