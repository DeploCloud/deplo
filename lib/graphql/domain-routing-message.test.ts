import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { seedApp, seedServer } from "../data/app-graph-test-helpers";
import { runGraphql } from "../mcp/execute";
import type { GraphQLContext } from "./context";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_dom", teamId: TEAM_A });
  await db.insert(domainsTable).values({
    id: "dom_gone",
    appId: "prj_dom",
    name: "gone.example.com",
    isPrimary: false,
    ssl: false,
    status: "valid",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

test("a removal that cannot reach the server says removed, not saved", async () => {
  const identity: RequestIdentity = { userId: USER_1, teamId: TEAM_A };
  const ctx = await runWithIdentity(
    identity,
    async (): Promise<GraphQLContext> => ({
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity,
    }),
  );
  const r = await runGraphql(
    `mutation { removeDomain(id: "dom_gone") }`,
    {},
    ctx,
  );
  assert.match(r.error ?? "", /^The domain was removed, but the routing/);
  const left = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.id, "dom_gone"));
  assert.equal(left.length, 0, "and it really is gone");
});
