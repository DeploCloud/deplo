import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { seedServer, SERVER_1 } from "../app-graph-test-helpers";
import { importMigrationProject } from "./project-import";
import { beginMigration } from "./run-lifecycle";
import {
  URL_BASE,
  CONNECT,
  asOwner,
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

test("a placement naming a migration source is refused, on both axes", async () => {
  const { servers: serversTable } =
    await import("../../db/schema/control-plane/servers");
  const { eq } = await import("drizzle-orm");
  const SOURCE = "srv_source";
  await seedServer(db, SOURCE);
  await db
    .update(serversTable)
    .set({ importOnly: true })
    .where(eq(serversTable.id, SOURCE));

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-web", "dok-app-api"],
      placements: [
        { serviceId: "dok-app-web", serverId: SOURCE },
        { serviceId: "dok-app-api", serverId: SERVER_1, buildServerId: SOURCE },
      ],
    }),
  );

  const apps = await db.select().from(appsTable);
  const byName = new Map(apps.map((a) => [a.name, a]));
  assert.equal(byName.get("blink-web")?.serverId, SERVER_1);
  assert.equal(byName.get("blink-api")?.buildServerId, null);
  assert.equal(
    result.items.filter(
      (i) => i.sourceKind === "server" && i.outcome === "manual",
    ).length,
    2,
    "one line per dropped pick",
  );
});

test("each app lands on the server it was placed on, and builds where it was told", async () => {
  const SERVER_2 = "srv_2";
  await seedServer(db, SERVER_2);
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-web", "dok-app-api"],
      placements: [
        { serviceId: "dok-app-web", serverId: SERVER_1 },
        {
          serviceId: "dok-app-api",
          serverId: SERVER_2,
          buildServerId: SERVER_1,
        },
      ],
    }),
  );

  const apps = await db.select().from(appsTable);
  const byName = new Map(apps.map((a) => [a.name, a]));
  assert.equal(byName.get("blink-web")?.serverId, SERVER_1);
  assert.equal(byName.get("blink-api")?.serverId, SERVER_2);
  assert.equal(byName.get("blink-web")?.buildServerId, null);
  assert.equal(byName.get("blink-api")?.buildServerId, SERVER_1);
});

test("a placement naming a server this team cannot reach is refused, not used", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-web"],
      placements: [
        { serviceId: "dok-app-web", serverId: "srv_from_another_team" },
      ],
    }),
  );

  const apps = await db.select().from(appsTable);
  assert.deepEqual(
    apps.map((a) => a.serverId),
    [SERVER_1],
  );
  const line = result.items.find((i) => i.sourceKind === "server")!;
  assert.equal(line.outcome, "manual");
  assert.match(line.message!, /not one this team can deploy to/);
});

test("a build server this team cannot reach falls back to Automatic", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-web"],
      placements: [
        {
          serviceId: "dok-app-web",
          serverId: SERVER_1,
          buildServerId: "srv_from_another_team",
        },
      ],
    }),
  );

  const apps = await db.select().from(appsTable);
  assert.equal(apps[0].serverId, SERVER_1);
  assert.equal(apps[0].buildServerId, null);
  assert.match(
    result.items.find((i) => i.sourceKind === "server")!.message!,
    /not one this team can build on/,
  );
});
