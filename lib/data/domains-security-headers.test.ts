import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { addDomain, updateDomain, listDomains } from "./domains/crud";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains/dns-check";
import { routableRoutes } from "./domains/routes";

const SERVER_IP = "10.0.0.1";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  __resetDnsResolve4ForTest();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", status: "active" });
  __setDnsResolve4ForTest(async () => [SERVER_IP]);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const byName = async (name: string) =>
  (await asUser1(() => listDomains("prj_1"))).find((d) => d.name === name);

test("a new domain sends the security headers, and its route carries them", async () => {
  await asUser1(() => addDomain("prj_1", "example.com", { port: 3000 }));
  assert.equal((await byName("example.com"))!.securityHeaders, true);
  const [route] = await asUser1(() => routableRoutes("prj_1"));
  assert.equal(route.securityHeaders, true);
  assert.deepEqual(route.corsOrigins, []);
});

test("allowed origins are cleaned on the way in and come back in order", async () => {
  await asUser1(() =>
    addDomain("prj_1", "api.example.com", {
      port: 3000,
      securityHeaders: false,
      corsOrigins: [
        " https://App.acme.com/ ",
        "https://app.acme.com",
        "http://localhost:5173",
      ],
    }),
  );
  const d = (await byName("api.example.com"))!;
  assert.equal(d.securityHeaders, false);
  assert.deepEqual(d.corsOrigins, [
    "https://app.acme.com",
    "http://localhost:5173",
  ]);
});

test("an origin with a path, or a list that is not origins, is refused", async () => {
  for (const bad of [
    "https://acme.com/app",
    "acme.com",
    "https://a.com,https://b.com",
  ])
    await assert.rejects(
      asUser1(() =>
        addDomain("prj_1", "example.com", { port: 3000, corsOrigins: [bad] }),
      ),
      /is not an origin/,
      bad,
    );
});

test("an edit turns the headers off and clears the origins", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000, corsOrigins: ["*"] }),
  );
  await asUser1(() =>
    updateDomain(d.id, { securityHeaders: false, corsOrigins: [] }),
  );
  const after = (await byName("example.com"))!;
  assert.equal(after.securityHeaders, false);
  assert.equal(after.corsOrigins, undefined);
  await asUser1(() => updateDomain(d.id, { port: 8080 }));
  assert.equal(
    (await byName("example.com"))!.securityHeaders,
    false,
    "an unrelated edit keeps the choice",
  );
});

test("the www host that takes over serving keeps the same headers and origins", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", {
      port: 3000,
      securityHeaders: false,
      corsOrigins: ["https://app.acme.com"],
    }),
  );
  await asUser1(() => updateDomain(d.id, { www: "toCounterpart" }));
  const www = (await byName("www.example.com"))!;
  assert.equal(www.securityHeaders, false);
  assert.deepEqual(www.corsOrigins, ["https://app.acme.com"]);
});
