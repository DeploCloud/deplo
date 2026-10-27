import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { and, eq, like } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { encryptSecret } from "../crypto";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { envVars as envVarsTable } from "../db/schema/control-plane/env-vars";
import { users as usersTable } from "../db/schema/control-plane/identity";
import { exactConnectionStrings } from "../deploy/database-compose";
import { appEnv } from "../deploy/build/deploy-env";
import { insertEnvVars } from "./app-graph-load";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { seedDatabase, settleProvisioning } from "./backup-test-helpers";
import { TRUNCATE } from "./databases/databases-test-helpers";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { createApp } from "./apps/create";
import {
  deleteEnv,
  importEnv,
  listEnv,
  renameEnv,
  setAppEnv,
  upsertEnv,
} from "./env";
import {
  connectDatabase,
  disconnectDatabase,
  unlinkEnv,
} from "./database-links";
import { autoLinkAllEnv } from "./database-autolink";

const HUB = "postgres://app:pw@db-ia-hub:5432/db-ia-hub";
const HUB_PUBLIC = "postgres://app:pw@203.0.113.10:15432/db-ia-hub";
const FAR = "postgres://app:pw@db-far:5432/db-far";
const PUB = "postgres://app:pw@203.0.113.10:25432/db-pub";
const THEIRS = "postgres://app:pw@db-theirs:5432/db-theirs";
const VIEWER = "user_viewer";

const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

describe("database auto-link", () => {
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
        { id: VIEWER, teamId: TEAM_A, role: "member", capabilities: ["view"] },
      ],
    });
    await seedServer(db);
    await seedServer(db, "srv_2");
    await seedApp(db, { id: "prj_hub" });
    await seedApp(db, { id: "prj_theirs", teamId: TEAM_B });
    await seedDatabase(db, { id: "db_hub", name: "ia-hub" });
    await seedDatabase(db, { id: "db_far", name: "far", serverId: "srv_2" });
    await seedDatabase(db, {
      id: "db_pub",
      name: "pub",
      serverId: "srv_2",
      exposedPublicly: true,
      exposedPort: 25432,
    });
    await stored("db_pub", PUB);
    await seedDatabase(db, { id: "db_theirs", name: "theirs", teamId: TEAM_B });
  });

  const stored = (id: string, url: string) =>
    db
      .update(databasesTable)
      .set({ connectionStringEnc: encryptSecret(url) })
      .where(eq(databasesTable.id, id));

  const row = async (appId: string, key: string) =>
    (
      await db
        .select()
        .from(envVarsTable)
        .where(and(eq(envVarsTable.appId, appId), eq(envVarsTable.key, key)))
    )[0];

  const followsLog = (key: string) =>
    db
      .select()
      .from(activitiesTable)
      .where(like(activitiesTable.message, `${key} now follows %`));

  const rawVar = (appId: string, key: string, value: string) =>
    insertEnvVars(db as unknown as Parameters<typeof insertEnvVars>[0], [
      {
        id: `env_${appId}_${key}`,
        appId,
        key,
        valueEnc: encryptSecret(value),
        targets: ["production", "preview"],
        type: "plain",
        databaseId: null,
        databaseUnlinked: false,
        createdByUserId: null,
        updatedByUserId: null,
        createdAt: "2026-10-27T00:00:00.000Z",
        updatedAt: "2026-10-27T00:00:00.000Z",
      },
    ]);

  test("the exact strings are the private one and the stored one, once each", () => {
    const pg = {
      type: "postgres" as const,
      username: "app",
      dbName: "db-ia-hub",
      host: "db-ia-hub",
      port: 5432,
    };
    assert.deepEqual(exactConnectionStrings(pg, HUB), [HUB]);
    assert.deepEqual(exactConnectionStrings(pg, HUB_PUBLIC), [HUB, HUB_PUBLIC]);
  });

  test("a saved value that is the private string is connected, keeping its type and environments", async () => {
    await asOwner(async () => {
      const linked = await upsertEnv({
        appId: "prj_hub",
        key: "DATABASE_URL",
        value: HUB,
        type: "plain",
      });
      assert.deepEqual(linked, [{ key: "DATABASE_URL", database: "ia-hub" }]);
      const [v] = await listEnv("prj_hub");
      assert.equal(v.connected, true);
      assert.equal(v.database?.id, "db_hub");
      assert.equal(v.type, "plain");
      assert.deepEqual(v.targets.sort(), ["preview", "production"]);
    });
    const [owner] = await db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, USER_1));
    const log = await followsLog("DATABASE_URL");
    assert.equal(log.length, 1);
    assert.equal(log[0].message, "DATABASE_URL now follows ia-hub");
    assert.equal(log[0].actor, owner.name);
    assert.equal(log[0].databaseId, "db_hub");
  });

  test("a secret is connected and stays a secret", async () => {
    await asOwner(async () => {
      await upsertEnv({
        appId: "prj_hub",
        key: "DATABASE_URL",
        value: `  ${HUB}\n`,
        type: "secret",
      });
      const [v] = await listEnv("prj_hub");
      assert.equal(v.connected, true);
      assert.equal(v.type, "secret");
    });
  });

  test("the public string connects too, and a deploy uses the private one when the app can", async () => {
    await db
      .update(databasesTable)
      .set({ exposedPublicly: true, exposedPort: 15432 })
      .where(eq(databasesTable.id, "db_hub"));
    await stored("db_hub", HUB_PUBLIC);
    await asOwner(async () => {
      await upsertEnv({
        appId: "prj_hub",
        key: "DATABASE_URL",
        value: HUB_PUBLIC,
        type: "plain",
      });
      await upsertEnv({
        appId: "prj_hub",
        key: "PUB_URL",
        value: PUB,
        type: "plain",
      });
      const env = await appEnv("prj_hub");
      assert.equal(env.DATABASE_URL, HUB);
      assert.equal(env.PUB_URL, PUB);
      assert.ok((await listEnv("prj_hub")).every((v) => v.connected));
    });
  });

  for (const [name, value, detected] of [
    ["extra parameters", `${HUB}?sslmode=disable`, true],
    [
      "a different password",
      "postgres://app:nope@db-ia-hub:5432/db-ia-hub",
      true,
    ],
    [
      "a different database name",
      "postgres://app:pw@db-ia-hub:5432/other",
      true,
    ],
    ["only the host", "db-ia-hub", true],
    ["the host inside a longer value", `jdbc:${HUB}`, true],
    ["another team's database", THEIRS, false],
    ["a database the app cannot reach", FAR, true],
  ] as const)
    test(`${name} is never connected`, async () => {
      await asOwner(async () => {
        const linked = await upsertEnv({
          appId: "prj_hub",
          key: "DB",
          value,
          type: "plain",
        });
        assert.deepEqual(linked, []);
        const [v] = await listEnv("prj_hub");
        assert.equal(v.connected, false);
        assert.equal(v.value, value);
        assert.equal(Boolean(v.detectedDatabase), detected);
      });
      await autoLinkAllEnv();
      assert.equal((await row("prj_hub", "DB")).databaseId, null);
    });

  test("a pasted .env connects only the lines that are a database's string", async () => {
    const res = await asOwner(() =>
      importEnv(
        "prj_hub",
        [`DATABASE_URL=${HUB}`, "DB_HOST=db-ia-hub", "PORT=3000"].join("\n"),
      ),
    );
    assert.equal(res.added, 3);
    assert.deepEqual(res.autoLinked, [
      { key: "DATABASE_URL", database: "ia-hub" },
    ]);
  });

  test("the whole-environment editor connects too", async () => {
    await asOwner(() =>
      setAppEnv("prj_hub", [
        { key: "DATABASE_URL", value: HUB },
        { key: "PORT", value: "3000" },
      ]),
    );
    assert.equal((await row("prj_hub", "DATABASE_URL")).databaseId, "db_hub");
    assert.equal((await row("prj_hub", "PORT")).databaseId, null);
  });

  test("an app created with the string is connected from the start", async () => {
    const app = await asOwner(() =>
      createApp({
        name: "worker",
        source: "compose",
        repo: null,
        compose:
          'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "80"\n',
        deploy: false,
        env: [{ key: "DATABASE_URL", value: HUB }],
      }),
    );
    assert.equal((await row(app.id, "DATABASE_URL")).databaseId, "db_hub");
  });

  test("a connected value follows a password change, in every deploy and in the list", async () => {
    await asOwner(async () => {
      await upsertEnv({
        appId: "prj_hub",
        key: "DATABASE_URL",
        value: HUB,
        type: "plain",
      });
      await stored("db_hub", "postgres://app:n3w@db-ia-hub:5432/db-ia-hub");
      const fresh = "postgres://app:n3w@db-ia-hub:5432/db-ia-hub";
      assert.equal((await appEnv("prj_hub")).DATABASE_URL, fresh);
      assert.equal((await appEnv("prj_hub", "preview")).DATABASE_URL, fresh);
      assert.equal((await listEnv("prj_hub"))[0].value, fresh);
    });
  });

  test("typing another value disconnects it, typing the string again reconnects it", async () => {
    await asOwner(async () => {
      const save = (value: string) =>
        upsertEnv({
          appId: "prj_hub",
          key: "DATABASE_URL",
          value,
          type: "plain",
        });
      await save(HUB);
      await save("postgres://someone:else@elsewhere:5432/x");
      let [v] = await listEnv("prj_hub");
      assert.equal(v.connected, false);
      assert.equal(v.value, "postgres://someone:else@elsewhere:5432/x");
      await save(HUB);
      [v] = await listEnv("prj_hub");
      assert.equal(v.connected, true);
    });
  });

  test("Unlink keeps today's value, and only an explicit Connect undoes it", async () => {
    const fresh = "postgres://app:n3w@db-ia-hub:5432/db-ia-hub";
    await asOwner(async () => {
      await upsertEnv({
        appId: "prj_hub",
        key: "DATABASE_URL",
        value: HUB,
        type: "plain",
      });
      await stored("db_hub", fresh);
      const [linked] = await listEnv("prj_hub");
      await unlinkEnv(linked.id);
      let [v] = await listEnv("prj_hub");
      assert.equal(v.connected, false);
      assert.equal(v.value, fresh);
      assert.equal((await appEnv("prj_hub")).DATABASE_URL, fresh);

      assert.deepEqual(
        await upsertEnv({
          appId: "prj_hub",
          key: "DATABASE_URL",
          value: fresh,
          type: "plain",
        }),
        [],
      );
    });
    await autoLinkAllEnv();
    assert.equal((await row("prj_hub", "DATABASE_URL")).databaseId, null);

    await asOwner(() =>
      connectDatabase({
        appId: "prj_hub",
        databaseId: "db_hub",
        key: "DATABASE_URL",
      }),
    );
    const after = await row("prj_hub", "DATABASE_URL");
    assert.equal(after.databaseId, "db_hub");
    assert.equal(after.databaseUnlinked, false);
  });

  test("unlinking needs manage_env, and a variable that is not connected refuses it", async () => {
    await asOwner(() =>
      upsertEnv({
        appId: "prj_hub",
        key: "PORT",
        value: "3000",
        type: "plain",
      }),
    );
    const port = await row("prj_hub", "PORT");
    await asOwner(() => assert.rejects(unlinkEnv(port.id), /not connected/));
    await asOwner(() =>
      upsertEnv({
        appId: "prj_hub",
        key: "DATABASE_URL",
        value: HUB,
        type: "plain",
      }),
    );
    const hub = await row("prj_hub", "DATABASE_URL");
    await runWithIdentity({ userId: VIEWER, teamId: TEAM_A }, () =>
      assert.rejects(unlinkEnv(hub.id), /permission|not found/i),
    );
    assert.equal((await row("prj_hub", "DATABASE_URL")).databaseId, "db_hub");
  });

  test("the sweep connects what was written before, in every team, once, as Deplo", async () => {
    await rawVar("prj_hub", "DATABASE_URL", HUB);
    await rawVar("prj_theirs", "DATABASE_URL", THEIRS);
    await rawVar("prj_hub", "FAR_URL", FAR);
    await autoLinkAllEnv();
    assert.equal((await row("prj_hub", "DATABASE_URL")).databaseId, "db_hub");
    assert.equal(
      (await row("prj_theirs", "DATABASE_URL")).databaseId,
      "db_theirs",
    );
    assert.equal((await row("prj_hub", "FAR_URL")).databaseId, null);
    const log = await followsLog("DATABASE_URL");
    assert.equal(log.length, 2);
    assert.ok(log.every((a) => a.actor === "Deplo"));
    assert.deepEqual(log.map((a) => a.teamId).sort(), [TEAM_A, TEAM_B]);

    await autoLinkAllEnv();
    assert.equal((await followsLog("DATABASE_URL")).length, 2);
  });

  test("renaming keeps the connection and Delete still deletes", async () => {
    await asOwner(async () => {
      await upsertEnv({
        appId: "prj_hub",
        key: "DATABASE_URL",
        value: HUB,
        type: "plain",
      });
      const [v] = await listEnv("prj_hub");
      await renameEnv(v.id, "PRIMARY_DB");
      assert.equal((await row("prj_hub", "PRIMARY_DB")).databaseId, "db_hub");
      await deleteEnv(v.id);
      assert.deepEqual(await listEnv("prj_hub"), []);
    });
  });

  test("unlinking from the database side keeps every variable of that app", async () => {
    await asOwner(async () => {
      await importEnv("prj_hub", `DATABASE_URL=${HUB}\nREPLICA_URL=${HUB}`);
      await disconnectDatabase({ appId: "prj_hub", databaseId: "db_hub" });
      const vars = await listEnv("prj_hub");
      assert.equal(vars.length, 2);
      for (const v of vars) {
        assert.equal(v.connected, false);
        assert.equal(v.value, HUB);
      }
    });
    assert.equal((await row("prj_hub", "REPLICA_URL")).databaseUnlinked, true);
  });

  test("a MongoDB string connects with its authSource", async () => {
    await seedDatabase(db, { id: "db_mongo", name: "mongo", type: "mongodb" });
    const mongo = "mongodb://app:pw@db-mongo:27017/db-mongo?authSource=admin";
    await db
      .update(databasesTable)
      .set({ port: 27017, connectionStringEnc: encryptSecret(mongo) })
      .where(eq(databasesTable.id, "db_mongo"));
    const linked = await asOwner(() =>
      upsertEnv({
        appId: "prj_hub",
        key: "MONGODB_URI",
        value: mongo,
        type: "secret",
      }),
    );
    assert.deepEqual(linked, [{ key: "MONGODB_URI", database: "mongo" }]);
  });
});
