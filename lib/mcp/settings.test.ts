import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  teams as teamsTable,
  membershipCapabilities,
  memberships,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/leaf-test-helpers";
import { getMcpSettings, setMcpSettings } from "../data/mcp-settings";

/**
 * The MCP kill switch and its Capability.
 */

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

/** Drop one capability from USER_1's membership in TEAM_A. */
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
  // Re-seed everything except the one under test, so the caller still reaches
  // the team (the `view` floor) and only this decision is missing.
  const { ALL_CAPABILITIES } = await import("../types");
  await db.insert(membershipCapabilities).values(
    ALL_CAPABILITIES.filter((c) => c !== capability).map((c) => ({
      membershipId: m.id,
      capability: c,
    })),
  );
}

test("a NEW team starts with MCP on", async () => {
  // The COLUMN default is the whole test: no creation path writes this field, so what
  // the migration says is what a team created today gets.
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

  // And the read path answers what the ROW says, not what the default is.
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

test("changing the policy needs manage_mcp, not merely membership", async () => {
  await revoke("manage_mcp");
  await assert.rejects(
    () => asUser1(() => setMcpSettings({ enabled: false })),
    /manage_mcp|permission|not allowed|capability/i,
    "a member without manage_mcp must be refused",
  );
  // Reading is deliberately ungated: /api/mcp has to read its own kill switch
  // as whatever principal the token carries.
  const still = await asUser1(() => getMcpSettings());
  assert.equal(still.enabled, true, "and the switch did not move");
});

test("the switch is per team, not per instance", async () => {
  await asUser1(() => setMcpSettings({ enabled: false }));

  // Asserted on the row rather than through `getMcpSettings`, which is
  // `cache()`d for the request: this is a claim about the COLUMN, and reading
  // it directly is the only way to make it one.
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
