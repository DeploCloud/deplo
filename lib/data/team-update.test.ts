import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { getTeam, updateTeam } from "./teams";

/**
 * The team slug is frozen after creation: it is the API's `X-Deplo-Team` value,
 * so nothing a person edits may move it.
 */

let db: TestDb;
let pg: PGlite;

const OWNER = "owner1";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
    ],
  });
});

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: OWNER, teamId: TEAM_A }, fn);

test("renaming the team leaves the slug alone", async () => {
  const before = await as(() => getTeam());
  const after = await as(() => updateTeam({ name: "Renamed" }));
  assert.equal(after.name, "Renamed");
  assert.equal(after.slug, before.slug);
});

test("a policy toggle keeps the name, without echoing it back", async () => {
  await as(() => updateTeam({ name: "Renamed" }));
  const after = await as(() => updateTeam({ requireTwoFactor: false }));
  assert.equal(after.name, "Renamed");
  assert.equal(after.requireTwoFactor ?? false, false);
});

test("an empty name is refused, an absent one is not", async () => {
  await assert.rejects(
    as(() => updateTeam({ name: "  " })),
    /name is required/i,
  );
  const after = await as(() => updateTeam({}));
  assert.ok(after.name);
});
