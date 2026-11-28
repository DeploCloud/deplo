import { test } from "node:test";
import assert from "node:assert/strict";

import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { deleteDatabase } from "./databases/lifecycle";
import {
  asAdmin,
  databaseLab,
  db,
  eu,
  host,
  main,
} from "./cluster-database-test-helpers";

databaseLab();

// c44: lab-db's 303 MB volume stayed on eu-3, the member that held it during a hang, after it was deleted.
test("deleting a cluster database tears it down on every member, its volume and set-aside copies too", async () => {
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await main(cluster.id);
  const asked: Record<string, unknown[]> = {};
  for (const id of ["srv_2", "srv_3", "srv_4"])
    Object.assign(host[id].extra, {
      destroyStack: async (...args: unknown[]) => {
        asked[id] = args;
        return { ok: true, error: "" };
      },
      listInstances: async () => [],
    });

  await asAdmin(() => deleteDatabase("db_main"));

  assert.deepEqual(await db.select().from(databasesTable), []);
  for (const id of ["srv_3", "srv_4"])
    assert.deepEqual(
      asked[id],
      ["db-main", true, ["deplo-db-main_db-main-data"], true],
      `${id} keeps nothing of it`,
    );
  assert.deepEqual(asked.srv_2?.slice(0, 2), ["db-main", true]);
});
