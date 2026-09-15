import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  membershipCapabilities,
  memberships,
} from "../db/schema/control-plane/access-control";
import { teams as teamsTable } from "../db/schema/control-plane/identity";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/leaf-test-helpers";
import { getMcpSettings, setMcpSettings } from "../data/mcp-settings";

let db: TestDb;
let pg: PGlite;

const TRUNCATE = `truncate table teams, users restart identity cascade;`;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

async function revoke(capability: string) {
  const m = (
    await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.teamId, TEAM_A))
      .limit(1)
  )[0];
  await db
    .delete(membershipCapabilities)
    .where(eq(membershipCapabilities.membershipId, m.id));
  const { ALL_CAPABILITIES } = await import("../types/identity");
  await db.insert(membershipCapabilities).values(
    ALL_CAPABILITIES.filter((c) => c !== capability).map((c) => ({
      membershipId: m.id,
      capability: c,
    })),
  );
}

test("a NEW team starts with MCP on", async () => {
  await db.insert(teamsTable).values({
    id: "team_fresh",
    name: "Fresh",
    slug: "fresh",
    plan: "pro",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const [fresh] = await db
    .select({ enabled: teamsTable.mcpEnabled })
    .from(teamsTable)
    .where(eq(teamsTable.id, "team_fresh"));
  assert.equal(fresh.enabled, true);

  assert.deepEqual(await asUser1(() => getMcpSettings()), { enabled: true });
});

test("setMcpSettings turns it off and back on", async () => {
  await asUser1(async () => {
    assert.deepEqual(await setMcpSettings({ enabled: false }), {
      enabled: false,
    });
    assert.deepEqual(await setMcpSettings({ enabled: true }), {
      enabled: true,
    });
    await setMcpSettings({ enabled: false });
  });

  const row = (
    await db
      .select({ enabled: teamsTable.mcpEnabled })
      .from(teamsTable)
      .where(eq(teamsTable.id, TEAM_A))
      .limit(1)
  )[0];
  assert.deepEqual(row, { enabled: false }, "persisted");
});

test("changing the policy needs manage_team, not manage_mcp", async () => {
  await revoke("manage_team");
  await assert.rejects(
    () => asUser1(() => setMcpSettings({ enabled: false })),
    /manage_team|permission|not allowed|capability/i,
    "a member without manage_team must be refused",
  );
  const still = await asUser1(() => getMcpSettings());
  assert.equal(still.enabled, true, "and the switch did not move");
});

test("the switch is per team, not per instance", async () => {
  await asUser1(() => setMcpSettings({ enabled: false }));

  const rows = await db
    .select({ id: teamsTable.id, enabled: teamsTable.mcpEnabled })
    .from(teamsTable);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.enabled]));
  assert.equal(byId[TEAM_A], false, "the team that turned it off is off");
  assert.equal(
    byId[TEAM_B],
    true,
    "turning MCP off in one team must not touch another",
  );
});
