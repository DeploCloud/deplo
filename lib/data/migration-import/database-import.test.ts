import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import { decryptSecret } from "../../crypto";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { envVars as envVarsTable } from "../../db/schema/control-plane/env-vars";
import { USER_1 } from "../identity-test-helpers";
import { SERVER_1 } from "../app-graph-test-helpers";
import { settleProvisioning } from "../backup-test-helpers";
import { importMigrationProject } from "./project-import";
import { beginMigration } from "./run-lifecycle";
import { scanMigrationSource } from "./scan";
import {
  URL_BASE,
  CONNECT,
  source,
  asOwner,
  importProject,
  provisionServer1,
  grantExposePorts,
  dbRowOf,
  notesOf,
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

test("a database keeps the host port it published on Dokploy", async () => {
  await provisionServer1(db);
  await grantExposePorts(db);
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  const row = await dbRowOf(db, "blink-db");
  assert.equal(row?.exposedPublicly, true);
  assert.equal(row?.exposedPort, 5432);
  assert.ok(row!.connectionStringEnc.length > 0);
});

test("a database is renamed whether the app named it by host or by id", async () => {
  await provisionServer1(db);
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  const host = (await dbRowOf(db, "blink-db"))!.host;
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  const vars = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, web.id));
  const value = (key: string) =>
    decryptSecret(vars.find((v) => v.key === key)!.valueEnc);

  assert.equal(value("DATABASE_URL"), `postgres://blink:pw@${host}:5432/blink`);
  assert.equal(value("QUEUE_DSN"), `postgres://blink:pw@${host}:5432/blink`);
});

test("the review can move that port, or refuse to publish it at all", async () => {
  await provisionServer1(db);
  await grantExposePorts(db);

  const runA = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId: runA,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-pg-1"],
      placements: [
        { serviceId: "dok-pg-1", serverId: SERVER_1, exposedPort: 25432 },
      ],
    }),
  );
  await settleProvisioning(db);
  const moved = await dbRowOf(db, "blink-db");
  assert.equal(moved?.exposedPort, 25432);
  assert.match(await notesOf(runA), /instead of 5432/);

  await db.execute("truncate table databases cascade;");
  const runB = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId: runB,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-pg-1"],
      placements: [
        { serviceId: "dok-pg-1", serverId: SERVER_1, exposedPort: null },
      ],
    }),
  );
  await settleProvisioning(db);
  const quiet = await dbRowOf(db, "blink-db");
  assert.equal(quiet?.exposedPublicly, false);
  assert.equal(quiet?.exposedPort, null);
  assert.match(await notesOf(runB), /not published, as chosen/);
});

test("the source holding the port is not a reason to drop it - it is stopped", async () => {
  const { servers: serversTable } =
    await import("../../db/schema/control-plane/servers");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({ ip: "dokploy.acme.test", host: "dokploy.acme.test" })
    .where(eq(serversTable.id, SERVER_1));
  await provisionServer1(db, [5432]);
  await grantExposePorts(db);

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  await settleProvisioning(db);
  assert.equal(
    source.calls.filter((p) => p === "postgres.stop").length,
    1,
    "the source was stopped, once",
  );
  const row = await dbRowOf(db, "blink-db");
  assert.equal(row?.exposedPublicly, true, "and the port came over anyway");
  assert.equal(row?.exposedPort, 5432);
});

test("without the publish-ports grant the port is dropped, and the report says why", async () => {
  await provisionServer1(db);
  await db.execute(
    `update users set is_instance_admin = false, can_expose_ports = false
       where id = '${USER_1}'`,
  );
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const planned = plan.projects
    .flatMap((p) => p.environments.flatMap((e) => e.services))
    .find((s) => s.sourceId === "dok-pg-1")!;
  assert.equal(planned.exposedPort, 5432);

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);
  const row = await dbRowOf(db, "blink-db");
  assert.equal(row?.exposedPublicly, false);
  assert.match(await notesOf(runId), /permission to publish ports/);
});

test("an imported database lands in the Environment its apps did", async () => {
  await provisionServer1(db);
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  const row = await dbRowOf(db, "blink-db");
  const app = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  );
  assert.ok(app?.environmentId);
  // Same Environment means the same network (ADR-0028) - `db-blink-db` resolves from the app.
  assert.equal(row?.environmentId, app!.environmentId);
});
