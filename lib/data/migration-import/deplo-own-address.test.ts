import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { decryptSecret } from "../../crypto";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  envVars as envVarsTable,
  sharedEnvVars,
} from "../../db/schema/control-plane/env-vars";
import type {
  DeploExportDomain,
  DeploExportSharedVar,
} from "../../migration/deplo/export-shape";
import {
  deploExport,
  exportApp,
} from "../../migration/deplo/deplo-test-helpers";
import { TEAM_A, TEAM_B } from "../identity-test-helpers";
import { seedApp } from "../app-graph-test-helpers";
import { saveSharedVar } from "../shared-vars/authoring";
import {
  asOwner,
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
});

const OLD = "web-k3x9.deplo.site";

const temporary = (
  host: string,
  over: Partial<DeploExportDomain> = {},
): DeploExportDomain => ({
  host,
  port: 3000,
  pathPrefix: "",
  stripPrefix: false,
  service: null,
  https: true,
  certProvider: "letsencrypt",
  primary: true,
  redirectTo: null,
  generated: true,
  ...over,
});

const prod = (key: string, value: string) => ({
  key,
  value,
  secret: false,
  targets: ["production" as const, "preview" as const],
});

function teamShared(
  key: string,
  value: string,
  over: Partial<DeploExportSharedVar> = {},
): DeploExportSharedVar {
  return {
    key,
    value,
    secret: false,
    targets: ["production", "preview"],
    teamWide: true,
    autoInject: false,
    projectIds: [],
    environmentIds: [],
    appIds: ["prj_web"],
    ...over,
  };
}

async function landed(name = "web") {
  const app = (await db.select().from(appsTable)).find((a) => a.name === name);
  assert.ok(app, `${name} landed`);
  const primary = (
    await db.select().from(domainsTable).where(eq(domainsTable.appId, app.id))
  ).find((d) => d.isPrimary);
  const vars = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, app.id));
  return {
    host: primary?.name ?? "",
    vars: Object.fromEntries(
      vars.map((v) => [v.key, decryptSecret(v.valueEnc)]),
    ),
  };
}

async function sharedValue(key: string) {
  const row = (await db.select().from(sharedEnvVars)).find(
    (v) => v.key === key,
  );
  assert.ok(row, `${key} landed`);
  return decryptSecret(row.valueEnc);
}

test("a variable holding the old temporary address, alone or as a URL's host, names the new one", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          domains: [temporary(OLD)],
          env: [
            prod("DASHBOARD_HOST", OLD),
            prod("PUBLIC_URL", `https://${OLD.toUpperCase()}/login`),
            prod("CALLBACK", `https://bot:pw@${OLD}:443/hook?x=1`),
            prod("OTHER_APP", `https://my${OLD}`),
            prod("LONGER_HOST", `${OLD}.example.com`),
            prod("MENTION", `see ${OLD} for help`),
          ],
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );
  const { host, vars } = await landed();
  assert.notEqual(host, OLD);
  assert.match(host, /\.deplo\.site$/);
  assert.deepEqual(vars, {
    DASHBOARD_HOST: host,
    PUBLIC_URL: `https://${host}/login`,
    CALLBACK: `https://bot:pw@${host}:443/hook?x=1`,
    OTHER_APP: `https://my${OLD}`,
    LONGER_HOST: `${OLD}.example.com`,
    MENTION: `see ${OLD} for help`,
  });
  const lines = await reportLines(runId);
  assert.ok(
    lines.some((l) =>
      /DASHBOARD_HOST, PUBLIC_URL, CALLBACK named the old address/.test(l),
    ),
    lines.join("\n"),
  );
  assert.deepEqual(await blockingLines(runId), []);
});

test("a shared variable this migration brought, holding the old address, names the new one and stays linked", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [exportApp({ domains: [temporary(OLD)] })],
      databases: [],
      sharedVars: [teamShared("DASHBOARD_HOST", OLD)],
    }),
    ["prc_shop"],
  );
  const { host, vars } = await landed();
  assert.equal(await sharedValue("DASHBOARD_HOST"), host);
  assert.equal(vars.DASHBOARD_HOST, undefined, "still read through the link");
  const lines = await reportLines(runId);
  assert.ok(
    lines.some((l) => /shared variable DASHBOARD_HOST named/.test(l)),
    lines.join("\n"),
  );
  assert.deepEqual(await blockingLines(runId), []);
});

test("a shared variable already in this team is left alone, and the app reading it is a blocker", async () => {
  await asOwner(() =>
    saveSharedVar({
      key: "DASHBOARD_HOST",
      value: OLD,
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  const runId = await importFromDeplo(
    deploExport({
      apps: [exportApp({ domains: [temporary(OLD)] })],
      databases: [],
      sharedVars: [teamShared("DASHBOARD_HOST", OLD)],
    }),
    ["prc_shop"],
  );
  assert.equal(await sharedValue("DASHBOARD_HOST"), OLD);
  const lines = await blockingLines(runId);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /DASHBOARD_HOST.*old address/);
});

test("a shared variable whose value clashes here becomes the app's own, on the new address", async () => {
  await asOwner(() =>
    saveSharedVar({
      key: "DASHBOARD_HOST",
      value: "elsewhere.example.com",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  await importFromDeplo(
    deploExport({
      apps: [exportApp({ domains: [temporary(OLD)] })],
      databases: [],
      sharedVars: [teamShared("DASHBOARD_HOST", OLD)],
    }),
    ["prc_shop"],
  );
  const { host, vars } = await landed();
  assert.equal(vars.DASHBOARD_HOST, host);
  assert.equal(await sharedValue("DASHBOARD_HOST"), "elsewhere.example.com");
});

test("an old address that still answers here, for another app of this team, is only named", async () => {
  await seedApp(db, { id: "prj_theirs", teamId: TEAM_A, slug: "theirs" });
  await db.insert(domainsTable).values({
    id: "dom_theirs",
    appId: "prj_theirs",
    name: "dash.example.com",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    entrypoint: "websecure",
    certProvider: "letsencrypt",
    stripPrefix: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          domains: [temporary("dash.example.com", { generated: false })],
          env: [prod("DASHBOARD_HOST", "dash.example.com")],
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );
  const { host, vars } = await landed();
  assert.notEqual(host, "dash.example.com");
  assert.equal(vars.DASHBOARD_HOST, "dash.example.com");
  const lines = await reportLines(runId);
  assert.ok(
    lines.some((l) =>
      new RegExp(`DASHBOARD_HOST names dash\\.example\\.com.*${host}`).test(l),
    ),
    lines.join("\n"),
  );
  assert.deepEqual(await blockingLines(runId), []);
});

test("an old address another team holds here is left alone without naming it", async () => {
  await seedApp(db, { id: "prj_theirs", teamId: TEAM_B, slug: "theirs" });
  await db.insert(domainsTable).values({
    id: "dom_theirs",
    appId: "prj_theirs",
    name: "dash.example.com",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    entrypoint: "websecure",
    certProvider: "letsencrypt",
    stripPrefix: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          domains: [temporary("dash.example.com", { generated: false })],
          env: [prod("DASHBOARD_HOST", "dash.example.com")],
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );
  const { host, vars } = await landed();
  assert.notEqual(host, "dash.example.com");
  assert.equal(vars.DASHBOARD_HOST, "dash.example.com");
  const lines = await reportLines(runId);
  const line = lines.find((l) => /^DASHBOARD_HOST /.test(l));
  assert.ok(line, lines.join("\n"));
  assert.match(line, new RegExp(host.replace(/\./g, "\\.")));
  assert.doesNotMatch(line, /dash\.example\.com/);
  assert.deepEqual(await blockingLines(runId), []);
});
