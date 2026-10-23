import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { makeTestDb } from "./test-harness";

const migration = (name: string) =>
  readFileSync(path.join(process.cwd(), "lib/db/migrations", name), "utf8");

test("0182 restores a 0.5.0 database and preserves existing moves on replay", async () => {
  const { pg } = await makeTestDb();
  try {
    await pg.exec(migration("0181_drop_between_deplo.sql"));
    await pg.exec(migration("0182_restore_between_deplo.sql"));
    const { rows } = await pg.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema='public' and table_name like 'deplo_move%'",
    );
    assert.deepEqual(rows.map((row) => row.table_name).sort(), [
      "deplo_move_pauses",
      "deplo_move_servers",
      "deplo_move_workloads",
      "deplo_moves",
    ]);
    await pg.exec(
      "select copied_from from backup_runs; select live_copy from migration_runs",
    );
    await pg.exec(
      "insert into deplo_moves (id, side, state, started_by, created_at, updated_at) values ('move_1', 'source', 'done', 'user_1', now(), now())",
    );
    await pg.exec(migration("0182_restore_between_deplo.sql"));
    const moves = await pg.query<{ id: string }>("select id from deplo_moves");
    assert.deepEqual(moves.rows, [{ id: "move_1" }]);
  } finally {
    await pg.close();
  }
});
