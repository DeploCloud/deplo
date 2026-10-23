import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { appVolumes } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  envVars as envVarsTable,
  envVarTargets,
} from "../../db/schema/control-plane/env-vars";
import { __setMigrationFetchForTest } from "../../migration/transport";
import { settleProvisioning } from "../backup-test-helpers";
import { beginMigration } from "./run-lifecycle";
import {
  URL_BASE,
  APPLICATIONS,
  source,
  asOwner,
  importProject,
  provisionServer1,
  routingFetch,
  dbRowOf,
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

const web = APPLICATIONS["dok-app-web"] as Record<string, unknown>;

async function importWeb(over: Record<string, unknown>) {
  __setMigrationFetchForTest(
    routingFetch({ applications: { "dok-app-web": { ...web, ...over } } }),
  );
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  return (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
}

test("the domain the source marked primary stays primary", async () => {
  const app = await importWeb({
    domains: [
      { domainId: "d-1", host: "blink.acme.test", port: 3000 },
      {
        domainId: "d-2",
        host: "www.blink.acme.test",
        port: 3000,
        primary: true,
      },
    ],
  });
  const rows = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  assert.equal(rows.find((d) => d.isPrimary)?.name, "www.blink.acme.test");
});

test("a read-only mount stays read-only", async () => {
  const app = await importWeb({
    mounts: [
      {
        mountId: "m-2",
        type: "volume",
        volumeName: "uploads",
        mountPath: "/app/uploads",
        readOnly: true,
      },
      {
        mountId: "m-3",
        type: "volume",
        volumeName: "cache",
        mountPath: "/app/cache",
      },
    ],
  });
  const vols = await db
    .select()
    .from(appVolumes)
    .where(eq(appVolumes.appId, app.id));
  assert.deepEqual(vols.map((v) => [v.mountPath, v.readOnly]).sort(), [
    ["/app/cache", false],
    ["/app/uploads", true],
  ]);
});

test("a production-only variable does not reach previews", async () => {
  const app = await importWeb({ productionOnlyEnvKeys: ["NODE_ENV"] });
  const rows = await db
    .select({ key: envVarsTable.key, target: envVarTargets.target })
    .from(envVarsTable)
    .innerJoin(envVarTargets, eq(envVarTargets.envVarId, envVarsTable.id))
    .where(eq(envVarsTable.appId, app.id));
  const targets = (key: string) =>
    rows
      .filter((r) => r.key === key)
      .map((r) => r.target)
      .sort();
  assert.deepEqual(targets("NODE_ENV"), ["production"]);
  assert.deepEqual(targets("DATABASE_URL"), ["preview", "production"]);
});

test("a database keeps every limit it had, not only memory and CPU", async () => {
  await provisionServer1(db);
  source.fixtures["postgres.one"] = {
    ...(source.fixtures["postgres.one"] as object),
    nativeResources: { memoryMb: 256, pidsLimit: 100 },
  };
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);
  const row = await dbRowOf(db, "blink-db");
  assert.equal(row?.resourcePidsLimit, 100);
  assert.equal(row?.resourceMemLimitMb, 256);
});
