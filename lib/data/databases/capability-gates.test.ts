import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedDatabase, settleProvisioning } from "../backup-test-helpers";
import {
  restartDatabase,
  redeployDatabase,
  rebuildDatabase,
} from "./lifecycle";
import { rotateDatabasePassword } from "./rotate-password";
import { updateDatabase } from "./server-move";
import { updateDatabaseResources, updateDatabaseImage } from "./settings";
import { TRUNCATE, USER_MEMBER, seedBase } from "./databases-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  await settleProvisioning(db);
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await settleProvisioning(db);
  await seedBase(db, pg);
});

test("focused mutations reject a member without manage_infra", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "user_viewer",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view"],
      },
    ],
  });
  await seedDatabase(db, { id: "db_cap", name: "cap" });
  await runWithIdentity({ userId: "user_viewer", teamId: TEAM_A }, async () => {
    await assert.rejects(updateDatabaseResources("db_cap", { memoryMb: 256 }));
    await assert.rejects(updateDatabaseImage("db_cap", { version: "16" }));
    await assert.rejects(restartDatabase("db_cap"));
    await assert.rejects(redeployDatabase("db_cap"));
    await assert.rejects(rebuildDatabase("db_cap"));
    await assert.rejects(rotateDatabasePassword("db_cap"));
  });
});

test("publishing a port is refused without the canExposePorts grant", async () => {
  await seedDatabase(db, { id: "db_1", name: "one" });

  await runWithIdentity({ userId: USER_MEMBER, teamId: TEAM_A }, async () => {
    await assert.rejects(
      () =>
        updateDatabase("db_1", {
          exposedPublicly: true,
          exposedPort: 25432,
        }),
      /permission to publish ports/i,
    );
  });

  const [row] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_1"));
  assert.equal(row.exposedPublicly, false);
  assert.equal(row.exposedPort, null);
});
