import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { decryptSecret } from "../../crypto";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  appPreviewEnvVars,
  envVars as envVarsTable,
  sharedEnvVars,
} from "../../db/schema/control-plane/env-vars";
import type { DeploExportSharedVar } from "../../migration/deplo/export-shape";
import {
  deploExport,
  exportApp,
} from "../../migration/deplo/deplo-test-helpers";
import {
  closeMigrationHarness,
  openMigrationHarness,
  provisionServer1,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import { importFromDeplo } from "./deplo-import-test-helpers";

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
});

// Values a `.env` line cannot hold exactly.
const AWKWARD = {
  TRAILING_SPACE_LINE: "first   \nsecond",
  BOTH_QUOTES: "a\"\nb'\nc",
  PEM: "-----BEGIN KEY-----\nMIIBOgIBAAJBAK\n-----END KEY-----",
};

const prod = (key: string, value: string) => ({
  key,
  value,
  secret: false,
  targets: ["production" as const],
});

const valuesOf = (rows: { key: string; valueEnc: string }[]) =>
  Object.fromEntries(rows.map((r) => [r.key, decryptSecret(r.valueEnc)]));

async function appVars(
  name: string,
  table: typeof envVarsTable | typeof appPreviewEnvVars = envVarsTable,
) {
  const app = (await db.select().from(appsTable)).find((a) => a.name === name);
  assert.ok(app, `${name} landed`);
  const rows =
    table === envVarsTable
      ? await db
          .select()
          .from(envVarsTable)
          .where(eq(envVarsTable.appId, app.id))
      : await db
          .select()
          .from(appPreviewEnvVars)
          .where(eq(appPreviewEnvVars.appId, app.id));
  return valuesOf(rows);
}

function shared(
  key: string,
  value: string,
  over: Partial<DeploExportSharedVar>,
): DeploExportSharedVar {
  return {
    key,
    value,
    secret: false,
    targets: ["production", "preview"],
    teamWide: false,
    autoInject: false,
    projectIds: [],
    environmentIds: [],
    appIds: [],
    ...over,
  };
}

test("every app variable lands exactly as the old Deplo held it", async () => {
  await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          env: Object.entries(AWKWARD).map(([k, v]) => prod(k, v)),
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );
  assert.deepEqual(await appVars("web"), AWKWARD);
});

test("a preview-only variable lands exactly too", async () => {
  await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          previewEnabled: true,
          env: [
            {
              key: "PREVIEW_PEM",
              value: AWKWARD.BOTH_QUOTES,
              secret: false,
              targets: ["preview"],
            },
          ],
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );
  assert.deepEqual(await appVars("web", appPreviewEnvVars), {
    PREVIEW_PEM: AWKWARD.BOTH_QUOTES,
  });
});

test("shared variables land exactly at every level", async () => {
  await importFromDeplo(
    deploExport({
      apps: [exportApp()],
      databases: [],
      sharedVars: [
        shared("TEAM_KEY", AWKWARD.TRAILING_SPACE_LINE, { teamWide: true }),
        shared("PROJECT_KEY", AWKWARD.BOTH_QUOTES, {
          projectIds: ["prc_shop"],
        }),
        shared("ENV_KEY", AWKWARD.PEM, { environmentIds: ["environ_prod"] }),
      ],
    }),
    ["prc_shop"],
  );
  assert.deepEqual(valuesOf(await db.select().from(sharedEnvVars)), {
    TEAM_KEY: AWKWARD.TRAILING_SPACE_LINE,
    PROJECT_KEY: AWKWARD.BOTH_QUOTES,
    ENV_KEY: AWKWARD.PEM,
  });
});
