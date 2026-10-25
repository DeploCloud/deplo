import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { runWithIdentity } from "../../auth/request-context";
import { __resetTestDb, __setTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { seedIdentity, TEAM_A } from "../identity-test-helpers";
import { securityUpdatesStatus, setSecurityUpdatesEnabled } from "./settings";

let db: TestDb;
let pg: PGlite;

const ADMIN = "u_admin";
const MEMBER = "u_member";
const as = <T>(userId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table activities, membership_capabilities, memberships, users, teams, instance_settings restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
});

test("checks are on by default, and only an instance admin turns them off", async () => {
  assert.equal((await as(ADMIN, () => securityUpdatesStatus())).enabled, true);
  await assert.rejects(as(MEMBER, () => setSecurityUpdatesEnabled(false)));
  await assert.rejects(as(MEMBER, () => securityUpdatesStatus()));
  const s = await as(ADMIN, () => setSecurityUpdatesEnabled(false));
  assert.equal(s.enabled, false);
  const acts = await db.select().from(activities);
  assert.deepEqual(
    acts.map((a) => a.message),
    ["Turned off security updates"],
  );
});
