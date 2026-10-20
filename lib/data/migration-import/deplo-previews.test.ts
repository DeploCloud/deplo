import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { decryptSecret } from "../../crypto";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { appPreviewEnvVars } from "../../db/schema/control-plane/env-vars";
import type { DeploExportPreview } from "../../migration/deplo/export-shape";
import {
  deploExport,
  exportApp,
} from "../../migration/deplo/deplo-test-helpers";
import { seedServer } from "../app-graph-test-helpers";
import {
  closeMigrationHarness,
  openMigrationHarness,
  provisionServer1,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import {
  blockingLines,
  importFromDeplo,
  reportLines,
} from "./deplo-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(async () => {
  await resetMigrationHarness(db);
  await provisionServer1(db);
  await seedServer(db, "srv_2");
});

const PREVIEW: DeploExportPreview = {
  baseDomain: "pr.example.com",
  maxActive: 7,
  ttlDays: 14,
  forkPolicy: "deny",
  serverId: "srv_old_previews",
  https: true,
  autoDeploy: false,
  port: 8080,
  buildDrafts: true,
  comment: false,
  requiredLabels: "preview\nqa",
};

async function landed(name = "web") {
  const app = (await db.select().from(appsTable)).find((a) => a.name === name);
  assert.ok(app, `${name} landed`);
  return app;
}

const settingsOf = (a: typeof appsTable.$inferSelect) => ({
  enabled: a.previewEnabled,
  baseDomain: a.previewBaseDomain,
  maxActive: a.previewMaxActive,
  ttlDays: a.previewTtlDays,
  forkPolicy: a.previewForkPolicy,
  serverId: a.previewServerId,
  https: a.previewHttps,
  autoDeploy: a.previewAutoDeploy,
  port: a.previewPort,
  buildDrafts: a.previewBuildDrafts,
  comment: a.previewComment,
  requiredLabels: a.previewRequiredLabels,
});

test("an app's preview settings land exactly as they were, even with previews off", async () => {
  await importFromDeplo(
    deploExport({
      apps: [exportApp({ previewEnabled: false, preview: PREVIEW })],
      databases: [],
    }),
    ["prc_shop"],
    { servers: [{ from: "srv_old_previews", to: "srv_2" }] },
  );
  assert.deepEqual(settingsOf(await landed()), {
    ...PREVIEW,
    enabled: false,
    serverId: "srv_2",
  });
});

test("a preview server with no counterpart here leaves previews on the app's server, and says so", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [exportApp({ previewEnabled: true, preview: PREVIEW })],
      databases: [],
    }),
    ["prc_shop"],
  );
  const app = await landed();
  assert.equal(app.previewEnabled, true);
  assert.equal(app.previewServerId, null);
  assert.equal(app.previewBaseDomain, "pr.example.com");
  assert.ok(
    (await reportLines(runId)).some((l) =>
      /previews ran on a server of their own/.test(l),
    ),
  );
  assert.deepEqual(await blockingLines(runId), [], "previews never block");
});

test("preview overrides land with their type", async () => {
  await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          previewEnabled: true,
          preview: { ...PREVIEW, serverId: null },
          previewEnv: [
            {
              key: "API_URL",
              value: "https://staging.example.com",
              secret: false,
            },
            { key: "STRIPE_KEY", value: "sk_test", secret: true },
          ],
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );
  const app = await landed();
  const rows = await db
    .select()
    .from(appPreviewEnvVars)
    .where(eq(appPreviewEnvVars.appId, app.id));
  assert.deepEqual(
    rows
      .map((r) => [r.key, decryptSecret(r.valueEnc), r.type])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["API_URL", "https://staging.example.com", "plain"],
      ["STRIPE_KEY", "sk_test", "secret"],
    ],
  );
});
