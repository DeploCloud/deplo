import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { envVars as envVarsTable } from "../../db/schema/control-plane/env-vars";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedApp } from "../app-graph-test-helpers";
import { __setMigrationFetchForTest } from "../../migration/transport";
import { importMigrationProject } from "./project-import";
import { beginMigration } from "./run-lifecycle";
import { getMigrationRun } from "./run-queries";
import { listEnvironmentsForProject } from "../environments";
import { createProject } from "../projects/lifecycle";
import { listApps } from "../apps/listing";
import {
  URL_BASE,
  CONNECT,
  DOKPLOY_ICON,
  source,
  defaultFixtures,
  APPLICATIONS,
  routingFetch,
  asOwner,
  importProject,
  grantExposePorts,
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

test("a name the team already uses elsewhere is said out loud", async () => {
  await seedApp(db, { id: "blink-web", teamId: TEAM_A, slug: "blink-web" });
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const said = (await asOwner(() => getMigrationRun(runId)))!.items
    .filter((i) => i.sourceId === "dok-app-web")
    .map((i) => i.message ?? "")
    .join(" | ");
  assert.match(
    said,
    /already has an app called blink-web\. Both are kept; this one is \/apps\/blink-web-1\./,
  );
  const apps = await db.select().from(appsTable);
  assert.equal(apps.filter((a) => a.name === "blink-web").length, 2);
});

test("a project lands complete: project, environment, apps, variables", async () => {
  const runId = await asOwner(() =>
    beginMigration({ url: URL_BASE, orgName: "Acme Inc" }),
  );

  const result = await importProject(runId, "dok-prj-blink");

  assert.equal(result.projectName, "Blink");
  assert.ok(result.created >= 5, `created ${result.created}`);

  const apps = await db.select().from(appsTable);
  assert.deepEqual(apps.map((a) => a.name).sort(), ["blink-api", "blink-web"]);

  const web = apps.find((a) => a.name === "blink-web")!;
  assert.equal(web.status, "idle");
  assert.equal(web.source, "github");
  assert.equal(web.repoRepo, "acme/blink");
  assert.equal(web.repoBranch, "main");

  const api = apps.find((a) => a.name === "blink-api")!;
  assert.equal(api.source, "docker-image");
  assert.equal(api.dockerImage, "ghcr.io/acme/api:1.4.2");

  const env = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, web.id));
  const byKey = new Map(env.map((e) => [e.key, e]));
  assert.deepEqual([...byKey.keys()].sort(), [
    "DATABASE_URL",
    "LEGACY_TOKEN",
    "NEXT_PUBLIC_SITE",
    "NODE_ENV",
    "OLD_ADDRESS",
    "OLD_ADDRESS_URL",
    "QUEUE_DSN",
  ]);
  for (const e of byKey.values()) assert.equal(e.type, "plain", e.key);
  assert.equal(
    (await asOwner(() => getMigrationRun(runId)))!.items.some((i) =>
      (i.message ?? "").includes("came across masked"),
    ),
    false,
  );

  const report = await asOwner(() => getMigrationRun(runId));
  const dbRow = report!.items.find((i) => i.sourceKind === "postgres")!;
  assert.equal(dbRow.outcome, "failed");
  assert.match(dbRow.message!, /not provisioned yet/);
});

test("an app keeps the icon it had, and one without stays iconless", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const apps = await db.select().from(appsTable);
  assert.equal(apps.find((a) => a.name === "blink-web")!.logo, DOKPLOY_ICON);
  assert.equal(apps.find((a) => a.name === "blink-api")!.logo, null);
});

test("an icon Deplo would refuse is dropped, and the app still lands", async () => {
  source.fixtures = defaultFixtures();
  const web = { ...(APPLICATIONS["dok-app-web"] as Record<string, unknown>) };
  web.icon = "https://templates.dokploy.com/blueprints/n8n/logo.png";
  __setMigrationFetchForTest(
    routingFetch({ applications: { "dok-app-web": web } }),
  );

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const apps = await db.select().from(appsTable);
  const row = apps.find((a) => a.name === "blink-web")!;
  assert.equal(row.logo, null);
  assert.equal(row.source, "github");
});

test("preview-only variables land as the app's own preview variables", async () => {
  source.fixtures = defaultFixtures();
  const web = { ...(APPLICATIONS["dok-app-web"] as Record<string, unknown>) };
  web.isPreviewDeploymentsActive = true;
  web.previewWildcard = "*.preview.acme.test";
  web.previewEnv = "PREVIEW_ONLY=1\nPREVIEW_API_TOKEN=tok";
  __setMigrationFetchForTest(
    routingFetch({ applications: { "dok-app-web": web } }),
  );
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const app = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  const { listPreviewEnvVars } = await import("../previews");
  const vars = await asOwner(() => listPreviewEnvVars(app.id));
  assert.deepEqual(
    vars.map((v) => [v.key, v.type]),
    [
      ["PREVIEW_API_TOKEN", "plain"],
      ["PREVIEW_ONLY", "plain"],
    ],
  );
  const notes = (await db.select().from(itemsTable))
    .filter((i) => i.runId === runId && i.targetId === app.id)
    .map((i) => i.message ?? "");
  assert.ok(
    notes.some((m) =>
      /came across as this app's preview variables: PREVIEW_ONLY, PREVIEW_API_TOKEN/.test(
        m,
      ),
    ),
    notes.join("\n"),
  );
});

test("an environment Dokploy calls production reuses the one Deplo already made", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const projectId = (await db.select().from(appsTable))[0].projectId!;
  const envs = await asOwner(() => listEnvironmentsForProject(projectId));
  assert.deepEqual(envs.map((e) => e.name).sort(), [
    "Development",
    "Preview",
    "Production",
  ]);
});

test("running the same import again creates nothing", async () => {
  const first = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(first, "dok-prj-blink");
  const appsAfterFirst = (await db.select().from(appsTable)).length;

  const second = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await importProject(second, "dok-prj-blink");

  assert.equal((await db.select().from(appsTable)).length, appsAfterFirst);
  assert.equal(result.created, 0, JSON.stringify(result.items));
  assert.ok(result.skipped >= 4, `skipped ${result.skipped}`);
});

test("one service Dokploy will not return does not stop the others", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  __setMigrationFetchForTest(routingFetch({ failApplication: "dok-app-api" }));
  const result = await importProject(runId, "dok-prj-blink");

  const apps = await db.select().from(appsTable);
  assert.deepEqual(
    apps.map((a) => a.name),
    ["blink-web"],
  );
  assert.match(
    result.items.find((i) => i.sourceName === "blink-api")!.message!,
    /Dokploy request failed \(500\)/,
  );
  assert.ok(result.created >= 3, `created ${result.created}`);
  assert.ok(result.items.some((i) => i.sourceKind === "postgres"));
});

test("an engine Deplo does not have is settled without asking Dokploy about it", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  source.calls = [];
  const result = await importProject(runId, "dok-prj-other");

  const row = result.items.find((i) => i.sourceKind === "libsql")!;
  assert.equal(row.outcome, "unsupported");
  assert.match(row.message!, /no libsql engine/);
  assert.equal(source.calls.includes("libsql.one"), false);
});

test("only the picked services come over, and the rest are not even read", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  source.calls = [];
  const result = await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-api"],
    }),
  );

  const apps = await db.select().from(appsTable);
  assert.deepEqual(
    apps.map((a) => a.name),
    ["blink-api"],
  );
  assert.equal((await db.select().from(databasesTable)).length, 0);
  assert.equal(
    result.items.some(
      (i) => i.sourceName === "blink-web" || i.sourceKind === "postgres",
    ),
    false,
  );
  assert.equal(source.calls.includes("postgres.one"), false);
});

test("a project that is already here is reused, not duplicated", async () => {
  await asOwner(() => createProject("Blink"));
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await importProject(runId, "dok-prj-blink");

  const projectItem = result.items.find((i) => i.sourceKind === "project")!;
  assert.equal(projectItem.outcome, "skipped");
  assert.match(projectItem.message!, /already here/);
});

test("an app keeps the host port it published on the source", async () => {
  await grantExposePorts(db);
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const web = (await asOwner(() => listApps())).find(
    (a) => a.name === "blink-web",
  )!;
  assert.deepEqual(
    web.ports?.map((p) => `${p.published}:${p.target}/${p.protocol}`),
    ["8080:3000/tcp"],
  );
});

test("without the grant an app's port is dropped, and the report says why", async () => {
  await db.execute(
    `update users set is_instance_admin = false, can_expose_ports = false
       where id = '${USER_1}'`,
  );
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const web = (await asOwner(() => listApps())).find(
    (a) => a.name === "blink-web",
  )!;
  assert.equal(web.ports ?? null, null);
  const said = (await asOwner(() => getMigrationRun(runId)))!.items
    .map((i) => i.message ?? "")
    .join(" | ");
  assert.match(said, /It published 8080 on its host/);
});
