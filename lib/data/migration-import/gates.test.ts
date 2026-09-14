import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { runWithIdentity } from "../../auth/request-context";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapsTable,
} from "../../db/schema/control-plane/access-control";
import { TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { listMigrationTargetTeams } from "./gates";
import { beginMigration } from "./run-lifecycle";
import { identifyMigrationSource, scanMigrationSource } from "./scan";
import { abandonMigration } from "./source-agents";
import {
  URL_BASE,
  CONNECT,
  USER_3,
  asOwner,
  asMember,
  asViewerAdmin,
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

test("a private panel address is instance-admin only, and needs no flag", async () => {
  const PRIVATE = { url: "http://172.17.0.1:3000", apiKey: CONNECT.apiKey };
  for (const url of [PRIVATE.url, "http://127.0.0.1:3000"])
    await assert.rejects(
      () => asMember(() => scanMigrationSource({ ...PRIVATE, url })),
      /instance admin/i,
    );
  const plan = await asOwner(() => scanMigrationSource(PRIVATE));
  assert.equal(plan.platform, "dokploy");
});

test("the teams offered are the ones that person may migrate INTO", async () => {
  await db.insert(membershipsTable).values([
    {
      id: "mem_1_b",
      userId: USER_1,
      teamId: TEAM_B,
      role: "member",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "mem_3_b",
      userId: USER_3,
      teamId: TEAM_B,
      role: "member",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  await db.insert(membershipCapsTable).values([
    { membershipId: "mem_1_b", capability: "view" },
    { membershipId: "mem_1_b", capability: "create_projects" },
    { membershipId: "mem_3_b", capability: "view" },
  ]);

  assert.deepEqual(
    (await asOwner(() => listMigrationTargetTeams())).map((t) => t.id),
    [TEAM_A, TEAM_B],
  );
  assert.deepEqual(
    (
      await runWithIdentity({ userId: USER_3, teamId: TEAM_A }, () =>
        listMigrationTargetTeams(),
      )
    ).map((t) => t.id),
    [TEAM_A],
  );
});

test("an instance admin reads the panel from a team they cannot import into", async () => {
  const who = await asViewerAdmin(() => identifyMigrationSource(CONNECT));
  assert.equal(who.teamName, "Acme Inc");
  assert.equal(await asViewerAdmin(() => abandonMigration()), 0);
  await assert.rejects(
    () => asViewerAdmin(() => scanMigrationSource(CONNECT)),
    /permission/i,
  );
  await assert.rejects(
    () => asViewerAdmin(() => beginMigration({ url: URL_BASE })),
    /permission/i,
  );
});
