import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { encryptSecret } from "../crypto";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { seedDatabase, settleProvisioning } from "./backup-test-helpers";
import { TRUNCATE } from "./databases/databases-test-helpers";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { appEnv, appEnvKeys } from "../deploy/build/deploy-env";
import { listEnv, renameEnv, upsertEnv } from "./env";
import {
  connectDatabase,
  disconnectDatabase,
  listDatabaseAppLinks,
  listDatabaseLinkOptionsForApp,
} from "./database-links";

const NO_REVEAL = "user_no_reveal";
const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

describe("database links", () => {
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
    await pg.exec(TRUNCATE);
    await seedIdentity(db, {
      users: [
        { id: USER_1, teamId: TEAM_A, role: "owner" },
        { id: "user_2", teamId: TEAM_B, role: "owner" },
        {
          id: NO_REVEAL,
          teamId: TEAM_A,
          role: "member",
          capabilities: ["view", "manage_env"],
        },
      ],
    });
    await seedServer(db);
    await seedServer(db, "srv_2");
    await seedApp(db, { id: "prj_hub" });
    await seedDatabase(db, { id: "db_hub", name: "ia-hub" });
  });

  const setPassword = (id: string, url: string) =>
    db
      .update(databasesTable)
      .set({ connectionStringEnc: encryptSecret(url) })
      .where(eq(databasesTable.id, id));

  test("a connection is a production secret whose value follows the database", async () => {
    await asOwner(async () => {
      await connectDatabase({
        appId: "prj_hub",
        databaseId: "db_hub",
        key: "DATABASE_URL",
      });
      const [v] = await listEnv("prj_hub");
      assert.equal(v.connected, true);
      assert.equal(v.type, "secret");
      assert.deepEqual(v.targets, ["production"]);
      assert.equal(v.database?.name, "ia-hub");
      assert.equal(v.database?.reachable, true);

      assert.equal(
        (await appEnv("prj_hub")).DATABASE_URL,
        "postgres://app:pw@db-ia-hub:5432/db-ia-hub",
      );
      await setPassword("db_hub", "postgres://app:n3w@db-ia-hub:5432/x");
      assert.equal(
        (await appEnv("prj_hub")).DATABASE_URL,
        "postgres://app:n3w@db-ia-hub:5432/db-ia-hub",
      );
      assert.equal(
        (await appEnv("prj_hub", "preview")).DATABASE_URL,
        undefined,
      );
    });
  });

  test("a database on another server is connected through its public address, and a deploy refuses once that goes", async () => {
    await seedDatabase(db, {
      id: "db_far",
      name: "far",
      serverId: "srv_2",
      exposedPublicly: true,
      exposedPort: 15432,
    });
    await setPassword("db_far", "postgres://app:pw@10.0.0.1:15432/db-far");
    await asOwner(async () => {
      const options = await listDatabaseLinkOptionsForApp("prj_hub");
      assert.deepEqual(
        options.map((o) => [o.name, o.reach]),
        [
          ["far", "public"],
          ["ia-hub", "internal"],
        ],
      );
      await connectDatabase({
        appId: "prj_hub",
        databaseId: "db_far",
        key: "FAR_URL",
      });
      assert.equal(
        (await appEnv("prj_hub")).FAR_URL,
        "postgres://app:pw@10.0.0.1:15432/db-far",
      );

      await db
        .update(databasesTable)
        .set({ exposedPublicly: false, exposedPort: null })
        .where(eq(databasesTable.id, "db_far"));
      await assert.rejects(
        appEnv("prj_hub"),
        /FAR_URL comes from far.*another server/,
      );
      assert.ok((await appEnvKeys("prj_hub")).includes("FAR_URL"));
      await assert.rejects(
        connectDatabase({ appId: "prj_hub", databaseId: "db_far", key: "X" }),
        /another server/,
      );
    });
  });

  test("connecting needs reveal_secrets and a database of the active team", async () => {
    await seedDatabase(db, { id: "db_b", name: "theirs", teamId: TEAM_B });
    await asOwner(() =>
      assert.rejects(
        connectDatabase({ appId: "prj_hub", databaseId: "db_b", key: "X" }),
        /Database not found/,
      ),
    );
    await runWithIdentity({ userId: NO_REVEAL, teamId: TEAM_A }, () =>
      assert.rejects(
        connectDatabase({ appId: "prj_hub", databaseId: "db_hub", key: "X" }),
        /permission/,
      ),
    );
  });

  test("a hand-written value is recognised, connecting replaces it, and disconnecting keeps the value", async () => {
    await asOwner(async () => {
      await upsertEnv({
        appId: "prj_hub",
        key: "DATABASE_URL",
        value: "postgres://app:old@db-ia-hub:5432/db-ia-hub",
        type: "secret",
      });
      let [v] = await listEnv("prj_hub");
      assert.equal(v.connected, false);
      assert.equal(v.detectedDatabase?.id, "db_hub");

      await connectDatabase({
        appId: "prj_hub",
        databaseId: "db_hub",
        key: "DATABASE_URL",
      });
      [v] = await listEnv("prj_hub");
      assert.equal(v.connected, true);
      assert.equal(v.detectedDatabase, null);

      await renameEnv(v.id, "PRIMARY_DB");
      const links = await listDatabaseAppLinks("db_hub");
      assert.deepEqual(
        links?.links.map((l) => [l.appName, l.key]),
        [["prj_hub", "PRIMARY_DB"]],
      );

      await disconnectDatabase({ appId: "prj_hub", databaseId: "db_hub" });
      [v] = await listEnv("prj_hub");
      assert.equal(v.key, "PRIMARY_DB");
      assert.equal(v.connected, false);
      assert.equal(
        (await appEnv("prj_hub")).PRIMARY_DB,
        "postgres://app:pw@db-ia-hub:5432/db-ia-hub",
      );
    });
  });

  test("deleting the database deletes the variables that came from it", async () => {
    await asOwner(() =>
      connectDatabase({ appId: "prj_hub", databaseId: "db_hub", key: "DB" }),
    );
    await db.delete(databasesTable).where(eq(databasesTable.id, "db_hub"));
    await asOwner(async () => assert.deepEqual(await listEnv("prj_hub"), []));
  });
});
