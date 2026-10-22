import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import { decryptSecret } from "../../crypto";
import { loadSharedVarsForApp } from "../shared-vars/deploy-entries";
import { resolveEnvEntries } from "../../deploy/env-resolve";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  envVars as envVarsTable,
  sharedEnvVars as sharedVarsTable,
  sharedEnvVarApps as sharedVarAppsTable,
} from "../../db/schema/control-plane/env-vars";
import { __setMigrationFetchForTest } from "../../migration/transport";
import { beginMigration } from "./run-lifecycle";
import {
  URL_BASE,
  APPLICATIONS,
  routingFetch,
  source,
  asOwner,
  importProject,
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import { getMigrationRun } from "./run-queries";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

test("a project's and an environment's own variables become shared variables", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const shared = await db.select().from(sharedVarsTable);
  assert.deepEqual(shared.map((s) => s.key).sort(), [
    "ENV_LEVEL",
    "SHARED_TOKEN",
  ]);
  assert.equal(shared.find((s) => s.key === "SHARED_TOKEN")!.type, "plain");
  assert.equal(shared.find((s) => s.key === "ENV_LEVEL")!.type, "plain");
});

test("only the app that referenced a shared variable is linked to it", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const links = await db
    .select({
      key: sharedVarsTable.key,
      appName: appsTable.name,
    })
    .from(sharedVarAppsTable)
    .innerJoin(
      sharedVarsTable,
      eq(sharedVarsTable.id, sharedVarAppsTable.varId),
    )
    .innerJoin(appsTable, eq(appsTable.id, sharedVarAppsTable.appId));
  assert.deepEqual(
    links.map((l) => [l.key, l.appName]),
    [["SHARED_TOKEN", "blink-api"]],
  );

  const api = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-api",
  )!;
  const own = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, api.id));
  const keys = own.map((v) => v.key).sort();
  assert.equal(keys.includes("SHARED_TOKEN"), false);
  assert.equal(
    decryptSecret(own.find((v) => v.key === "TOKEN_COPY")!.valueEnc),
    "project-level",
  );
});

test("a second project links to the shared variable already here when the value matches", async () => {
  const other = (source.fixtures["project.all"] as { env: string }[])[1];
  other.env = "SHARED_TOKEN=project-level\n";
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await importProject(runId, "dok-prj-other");

  const rows = await db
    .select({ key: sharedVarsTable.key })
    .from(sharedVarsTable)
    .where(eq(sharedVarsTable.key, "SHARED_TOKEN"));
  assert.equal(rows.length, 1, "one row per team and name");

  const links = await db
    .select({ appName: appsTable.name })
    .from(sharedVarAppsTable)
    .innerJoin(
      sharedVarsTable,
      eq(sharedVarsTable.id, sharedVarAppsTable.varId),
    )
    .innerJoin(appsTable, eq(appsTable.id, sharedVarAppsTable.appId))
    .where(eq(sharedVarsTable.key, "SHARED_TOKEN"));
  assert.deepEqual(
    links.map((l) => l.appName).sort(),
    ["blink-api", "other-stack"],
    "both projects' referencing apps are linked to the one row",
  );
});

test("a second project keeps its own value when the shared variable here holds another", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await importProject(runId, "dok-prj-other");

  const rows = await db
    .select()
    .from(sharedVarsTable)
    .where(eq(sharedVarsTable.key, "SHARED_TOKEN"));
  assert.deepEqual(
    rows.map((r) => decryptSecret(r.valueEnc)),
    ["project-level"],
    "the variable already here is left as it is",
  );

  const links = await db
    .select({ appName: appsTable.name })
    .from(sharedVarAppsTable)
    .innerJoin(appsTable, eq(appsTable.id, sharedVarAppsTable.appId));
  assert.deepEqual(
    links.map((l) => l.appName),
    ["blink-api"],
  );

  const stack = (await db.select().from(appsTable)).find(
    (a) => a.name === "other-stack",
  )!;
  const own = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, stack.id));
  assert.equal(
    decryptSecret(own.find((v) => v.key === "SHARED_TOKEN")!.valueEnc),
    "other-level",
    "the app runs with the value it had on the source",
  );

  const items = (await asOwner(() => getMigrationRun(runId)))!.items;
  const clash = items.filter(
    (i) =>
      i.sourceName === "SHARED_TOKEN" && i.message?.includes("different value"),
  );
  assert.equal(clash.length, 1, "one line names the clash");
  assert.equal(clash[0].sourceKind, "shared-var");
  assert.doesNotMatch(clash[0].message!, /other-level|project-level/);
  assert.equal(clash[0].blocking, false, "the app keeps the value it ran with");
});

test("a shared variable never clobbers an app's own value of the same name", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  const own = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, web.id));
  assert.deepEqual(await loadSharedVarsForApp(web.id), []);
  const resolved = resolveEnvEntries(
    "production",
    web.id,
    own.map((v) => ({
      appId: web.id,
      key: v.key,
      valueEnc: v.valueEnc,
      targets: ["production" as const, "preview" as const],
      type: v.type as "plain" | "secret",
    })),
    [],
  );
  assert.equal(
    decryptSecret(resolved.find((e) => e.key === "NODE_ENV")!.valueEnc),
    "production",
  );
});

test("the same name at two levels stays two shared variables", async () => {
  const blink = (
    source.fixtures["project.all"] as { environments: { env: string }[] }[]
  )[0];
  blink.environments[0].env = "ENV_LEVEL=yes\nSHARED_TOKEN=env-level\n";
  __setMigrationFetchForTest(
    routingFetch({
      applications: {
        "dok-app-api": {
          ...(APPLICATIONS["dok-app-api"] as object),
          env:
            "SHARED_TOKEN=${{environment.SHARED_TOKEN}}\n" +
            "TOKEN_COPY=${{project.SHARED_TOKEN}}\n",
        },
      },
    }),
  );
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const rows = await db
    .select()
    .from(sharedVarsTable)
    .where(eq(sharedVarsTable.key, "SHARED_TOKEN"));
  assert.deepEqual(rows.map((r) => decryptSecret(r.valueEnc)).sort(), [
    "env-level",
    "project-level",
  ]);

  const linked = await db
    .select({ valueEnc: sharedVarsTable.valueEnc })
    .from(sharedVarAppsTable)
    .innerJoin(
      sharedVarsTable,
      eq(sharedVarsTable.id, sharedVarAppsTable.varId),
    );
  assert.deepEqual(
    linked.map((l) => decryptSecret(l.valueEnc)),
    ["env-level"],
    "the app is linked to the level it named",
  );
  const api = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-api",
  )!;
  const own = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, api.id));
  assert.equal(
    decryptSecret(own.find((v) => v.key === "TOKEN_COPY")!.valueEnc),
    "project-level",
  );
});
