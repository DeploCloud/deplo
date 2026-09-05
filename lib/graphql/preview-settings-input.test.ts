import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { graphql } from "graphql";
import { eq } from "drizzle-orm";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { apps as appsTable } from "../db/schema/control-plane";
import { schema } from "./schema";
import type { GraphQLContext } from "./context";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
  USER_1,
} from "../data/identity-test-helpers";

/**
 * `setAppPreviewSettings` through the API, where a nullable field arrives as an
 * explicit null. The data layer already reads null as "clear it"; the resolver
 * used to fold null into undefined, which made "back to the app's port" a save
 * that changed nothing - through the form as much as through the API.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_IDENTITY + TRUNCATE_PROJECT_GRAPH);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", slug: "blog", source: "github" });
});

async function call(doc: string, variables: Record<string, unknown>) {
  return runWithIdentity({ userId: USER_1, teamId: TEAM_A }, async () => {
    const ctx: GraphQLContext = {
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity: null,
    };
    const res = await graphql({
      schema,
      source: doc,
      variableValues: variables,
      contextValue: ctx,
    });
    assert.equal(res.errors, undefined, JSON.stringify(res.errors));
  });
}

const SET = /* GraphQL */ `
  mutation ($appId: ID!, $input: AppPreviewSettingsInput!) {
    setAppPreviewSettings(appId: $appId, input: $input)
  }
`;

async function stored() {
  return (
    await db
      .select({
        port: appsTable.previewPort,
        base: appsTable.previewBaseDomain,
        labels: appsTable.previewRequiredLabels,
        max: appsTable.previewMaxActive,
      })
      .from(appsTable)
      .where(eq(appsTable.id, "prj_1"))
  )[0]!;
}

test("an explicit null clears a nullable preview setting; an omitted one is kept", async () => {
  await call(SET, {
    appId: "prj_1",
    input: {
      port: 3001,
      baseDomain: "preview.example.com",
      requiredLabels: "preview",
      maxActive: 5,
    },
  });
  assert.deepEqual(await stored(), {
    port: 3001,
    base: "preview.example.com",
    labels: "preview",
    max: 5,
  });

  // The form's "back to the app's port" is exactly this shape.
  await call(SET, { appId: "prj_1", input: { port: null } });
  assert.equal((await stored()).port, null);
  assert.equal((await stored()).base, "preview.example.com", "untouched");

  await call(SET, {
    appId: "prj_1",
    input: { maxActive: null, requiredLabels: "" },
  });
  const after = await stored();
  assert.equal(after.max, null);
  assert.equal(after.labels, null);
  assert.equal(after.base, "preview.example.com", "still untouched");
});
