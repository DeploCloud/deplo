import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  domains as domainsTable,
  envVars as envVarsTable,
  sharedEnvVarApps as sharedLinksTable,
} from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { createApp } from "./apps";
import { saveSharedVar } from "./shared-vars";
import { loadAppGraph } from "./app-graph-load";

/**
 * What the new-app wizard can decide AT CREATION beyond the source: the extra
 * compose flags, the type of an initial variable, and which of the team's shared
 * variables the app is linked to - which has to happen before the first deploy,
 * not after it.
 */

let db: TestDb;
let pg: PGlite;

const COMPOSE = "services:\n  web:\n    image: nginx:1.27\n";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** A compose app that never deploys, so these tests never reach an agent. */
const newApp = (
  extra: Parameters<typeof createApp>[0] extends infer T ? Partial<T> : never,
) =>
  createApp({
    name: "shop",
    source: "compose",
    repo: null,
    compose: COMPOSE,
    deploy: false,
    ...extra,
  });

test("extra compose flags are stored the way the deploy edge will send them", async () => {
  const app = await asUser1(() =>
    newApp({ composeUpArgs: "  --pull   always \n --wait " }),
  );
  assert.equal(
    (await loadAppGraph(app.id))?.composeUpArgs,
    "--pull always --wait",
  );
});

test("an app is created with no extra flags by default", async () => {
  const app = await asUser1(() => newApp({}));
  assert.equal((await loadAppGraph(app.id))?.composeUpArgs, null);
});

test("a flag that would repoint the command is refused at creation", async () => {
  // The same allow-list the settings page enforces: this value also arrives from
  // the bearer API, and from there it would land in a host's argv.
  await assert.rejects(
    () => asUser1(() => newApp({ composeUpArgs: "-p other" })),
    /Deplo's to set/,
  );
});

test("an initial variable is created secret when the create says so", async () => {
  const app = await asUser1(() =>
    newApp({
      env: [
        { key: "API_URL", value: "https://acme.com", type: "plain" },
        { key: "LICENSE_CODE", value: "abc", type: "secret" },
      ],
    }),
  );
  const rows = await db
    .select({ key: envVarsTable.key, type: envVarsTable.type })
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, app.id));
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.type]));
  // Neither name would have been guessed: the heuristic reads the key, and
  // "LICENSE_CODE" is not one of the words it knows.
  assert.equal(byKey.API_URL, "plain");
  assert.equal(byKey.LICENSE_CODE, "secret");
});

test("shared variables are linked as part of the create", async () => {
  const varId = await asUser1(() =>
    saveSharedVar({
      key: "SENTRY_DSN",
      value: "https://sentry.example",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  const app = await asUser1(() => newApp({ sharedVarIds: [varId] }));
  const links = await db
    .select({ varId: sharedLinksTable.varId })
    .from(sharedLinksTable)
    .where(
      and(
        eq(sharedLinksTable.appId, app.id),
        eq(sharedLinksTable.varId, varId),
      ),
    );
  // ADR-0012: the link IS the injection, so a var picked in the wizard has to be
  // attached before the first deploy reads the app's environment.
  assert.equal(links.length, 1);
});

test("another team's shared variable is not linkable at creation", async () => {
  const foreign = await runWithIdentity(
    { userId: "user_2", teamId: TEAM_B },
    () =>
      saveSharedVar({
        key: "FOREIGN",
        value: "x",
        type: "plain",
        teamIds: [TEAM_B],
        environmentIds: [],
        projectIds: [],
      }),
  );
  await assert.rejects(
    () => asUser1(() => newApp({ sharedVarIds: [foreign] })),
    /not found/i,
  );
});

/**
 * One hostname, two services: the shape a stack with a single BASE_URL needs.
 * The extra used to be pushed onto an invented host, because its own primary had
 * just taken the name.
 */
test("an extra domain shares the primary's host when it answers on a path", async () => {
  const app = await asUser1(() =>
    newApp({
      compose:
        "services:\n" +
        "  db:\n    image: postgres:17\n" +
        "  backend:\n    image: acme/api\n" +
        "  client:\n    image: acme/web\n    depends_on:\n      - backend\n",
      extraDomains: [
        { service: "backend", port: 3001, host: "", path: "/api" },
      ],
    }),
  );
  const rows = await db
    .select({
      name: domainsTable.name,
      service: domainsTable.service,
      port: domainsTable.port,
      pathPrefix: domainsTable.pathPrefix,
      primary: domainsTable.isPrimary,
    })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));

  const primary = rows.find((r) => r.primary);
  const extra = rows.find((r) => !r.primary);
  // The database is never the front door, and the client is what nothing depends on.
  assert.equal(primary?.service, "client");
  assert.equal(extra?.service, "backend");
  assert.equal(extra?.pathPrefix, "/api");
  assert.equal(extra?.port, 3001);
  // Same address, different path - not a second invented hostname.
  assert.equal(extra?.name, primary?.name);
});

test("an extra domain with no host of its own gets one generated", async () => {
  const app = await asUser1(() =>
    newApp({
      compose:
        "services:\n  web:\n    image: nginx\n  admin:\n    image: acme/admin\n",
      extraDomains: [{ service: "admin", port: 3003, host: "" }],
    }),
  );
  const rows = await db
    .select({ name: domainsTable.name, primary: domainsTable.isPrimary })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  const extra = rows.find((r) => !r.primary);
  assert.ok(extra, "the host-less extra was dropped");
  assert.match(extra.name, /^shop-admin-/);
});
