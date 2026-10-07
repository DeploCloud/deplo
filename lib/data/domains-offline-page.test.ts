import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { GET } from "@/app/api/offline/route";
import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { nowIso } from "../ids";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";

let db: TestDb;
let pg: PGlite;

const answer = (host: string) =>
  GET(new Request("http://deplo:3000/api/offline", { headers: { host } }));

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
    truncate table membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: "u_1", teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db, "srv_1");
  await seedApp(db, { id: "prj_web", teamId: TEAM_A, slug: "web" });
  await db.insert(domainsTable).values({
    id: "dom_1",
    appId: "prj_web",
    name: "web.acme.com",
    status: "valid",
    isPrimary: true,
    ssl: true,
    createdAt: nowIso(),
  });
  await db
    .update(appsTable)
    .set({ previewBaseDomain: "previews.acme.com" })
    .where(eq(appsTable.id, "prj_web"));
});

test("an address an app serves says it is down, not that it does not exist", async () => {
  const res = await answer("web.acme.com");
  assert.equal(res.status, 503);
  assert.match(await res.text(), /not running/i);
});

test("the port a visitor connected on is not part of the hostname", async () => {
  assert.equal((await answer("WEB.acme.com:443")).status, 503);
});

test("a preview address is served here too, though no domain row holds it", async () => {
  assert.equal((await answer("web-pr-7.previews.acme.com")).status, 503);
});

test("an address nothing here claims still answers 404, and says so", async () => {
  const res = await answer("stranger.example.com");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Nothing is served here/i);
});
