import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { appBuild, apps } from "../../db/schema/control-plane/apps";
import { domains } from "../../db/schema/control-plane/domains";
import { seedApp, seedServer } from "../app-graph-test-helpers";
import { seedIdentity } from "../identity-test-helpers";
import {
  adoptObservedPort,
  recordResolvedMethod,
  recordSourceCompose,
  routeDomainsToService,
} from "./build-outcome";

describe("what a deploy learns about its app", () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await makeTestDb();
    db = t.db;
    close = () => t.pg.close();
    __setTestDb(db);
    await seedIdentity(db);
    await seedServer(db);
    await seedApp(db, { id: "app_1" });
  });
  afterEach(async () => {
    __resetTestDb();
    await close();
  });

  const domain = (id: string, port: number | null, service: string | null) =>
    db.insert(domains).values({
      id,
      appId: "app_1",
      name: `${id}.example.com`,
      port,
      service,
      status: "valid",
      isPrimary: id === "d1",
      ssl: false,
      createdAt: "2026-10-24T00:00:00.000Z",
    });

  test("a resolved method is recorded only for an app on Detect automatically", async () => {
    await recordResolvedMethod("app_1", "dockerfile");
    let row = (
      await db.select().from(appBuild).where(eq(appBuild.appId, "app_1"))
    )[0];
    assert.equal(
      row.buildMethod,
      "railpack",
      "an explicit pick is never rewritten",
    );

    await db
      .update(appBuild)
      .set({ buildMethodAuto: true })
      .where(eq(appBuild.appId, "app_1"));
    await recordResolvedMethod("app_1", "dockerfile");
    row = (
      await db.select().from(appBuild).where(eq(appBuild.appId, "app_1"))
    )[0];
    assert.equal(row.buildMethod, "dockerfile");
  });

  test("the source's compose file is kept as the app's stack, and cleared again", async () => {
    await recordSourceCompose("app_1", "services:\n  web:\n    image: nginx\n");
    assert.match(
      (await db.select().from(apps).where(eq(apps.id, "app_1")))[0].compose ??
        "",
      /nginx/,
    );
    await recordSourceCompose("app_1", null);
    assert.equal(
      (await db.select().from(apps).where(eq(apps.id, "app_1")))[0].compose,
      null,
    );
  });

  test("domains with no service follow the stack's web service; a chosen one stays", async () => {
    await domain("d1", null, null);
    await domain("d2", 9000, "admin");
    await routeDomainsToService("app_1", "web", 8000);
    const rows = Object.fromEntries(
      (await db.select().from(domains)).map((d) => [d.id, [d.service, d.port]]),
    );
    assert.deepEqual(rows.d1, ["web", 8000]);
    assert.deepEqual(rows.d2, ["admin", 9000]);
  });

  test("an observed port moves the app and the domains that pointed at the old one", async () => {
    await domain("d1", 3000, null);
    await domain("d2", null, null);
    await domain("d3", 4000, null);
    await adoptObservedPort("app_1", { from: 3000, to: 8080 });
    const build = (
      await db.select().from(appBuild).where(eq(appBuild.appId, "app_1"))
    )[0];
    assert.equal(build.port, 8080);
    const rows = Object.fromEntries(
      (await db.select().from(domains)).map((d) => [d.id, d.port]),
    );
    assert.deepEqual(rows, { d1: 8080, d2: 8080, d3: 4000 });
  });

  test("in a stack only the routed service's domains move, the app port stays", async () => {
    await domain("d1", 3000, "web");
    await domain("d2", 3000, "api");
    await adoptObservedPort("app_1", { from: 3000, to: 8080, service: "web" });
    const build = (
      await db.select().from(appBuild).where(eq(appBuild.appId, "app_1"))
    )[0];
    assert.equal(build.port, 3000);
    const rows = Object.fromEntries(
      (await db.select().from(domains)).map((d) => [d.id, d.port]),
    );
    assert.deepEqual(rows, { d1: 8080, d2: 3000 });
  });
});
