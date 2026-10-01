import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "./db/test-harness";
import { __setTestDb, __resetTestDb } from "./db/client";
import {
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane/identity";
import { instanceSettings as instanceSettingsTable } from "./db/schema/control-plane/instance";
import { account as accountTable } from "./db/schema/auth";
import { verifyPassword } from "./crypto";
import { runWithIdentity } from "./auth/request-context";
import {
  createAccountWithTeam,
  createOwnerWithTemporaryPassword,
} from "./auth/create-account";
import { finishSetup } from "./auth/setup";
import {
  PasswordChangeRequiredError,
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
} from "./membership";
import { buildContext } from "./graphql/context";
import { TRUNCATE_IDENTITY } from "./data/identity-test-helpers";

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
  await pg.exec(TRUNCATE_IDENTITY);
});

const EMAIL = "ada@acme.io";
// What a host generates: no symbol, so it would fail the policy a person's password meets.
const TEMPORARY = "x7Kq2mPa9";
const MINE = "Passw0rd!1";

const FINISH = {
  name: "Ada Lovelace",
  password: MINE,
  teamName: "Acme",
};

async function owner() {
  const user = await createOwnerWithTemporaryPassword(EMAIL, TEMPORARY);
  const team = (await db.select().from(teamsTable))[0]!;
  return { user, team };
}

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId }, fn);

// finishSetup re-signs in after its transaction; outside a request that step has no cookie jar.
async function finish(input: Parameters<typeof finishSetup>[0]) {
  try {
    return await finishSetup(input);
  } catch (e) {
    assert.match(String(e), /cookies|headers/);
    return { ok: true };
  }
}

async function storedPassword(userId: string): Promise<string> {
  const [row] = await db
    .select({ password: accountTable.password })
    .from(accountTable)
    .where(eq(accountTable.userId, userId));
  return row!.password!;
}

test("the installer's owner holds the crown, a team, and a password to replace", async () => {
  const { user, team } = await owner();
  const [row] = await db.select().from(usersTable);
  assert.equal(row!.mustChangePassword, true);
  assert.equal(row!.isInstanceAdmin, true);
  assert.equal(team.name, "Workspace");
  const [settings] = await db.select().from(instanceSettingsTable);
  assert.equal(settings!.ownerUserId, user.id);
  assert.ok(await verifyPassword(TEMPORARY, await storedPassword(user.id)));
});

test("the installer's owner is refused once any account exists", async () => {
  await createAccountWithTeam(
    {
      name: "Grace",
      email: "grace@acme.io",
      password: MINE,
      teamName: "Navy",
    },
    {},
  );
  await assert.rejects(owner(), /already has an account/);
  assert.equal((await db.select().from(usersTable)).length, 1);
});

test("a temporary password shorter than 8 characters is refused", async () => {
  await assert.rejects(
    createOwnerWithTemporaryPassword(EMAIL, "short"),
    /at least 8/,
  );
  assert.equal((await db.select().from(usersTable)).length, 0);
});

test("until it is finished, the account reaches no team and no admin power", async () => {
  const { user, team } = await owner();
  await as(user.id, team.id, async () => {
    await assert.rejects(requireActiveTeamId(), PasswordChangeRequiredError);
    await assert.rejects(
      requireCapability("deploy_apps"),
      PasswordChangeRequiredError,
    );
    await assert.rejects(requireInstanceAdmin(), /instance admin/);
    const ctx = await buildContext(new Request("http://localhost/api/graphql"));
    assert.equal(ctx.viewer?.id, user.id, "the wizard still knows who it is");
    assert.equal(ctx.teamId, null);
    assert.deepEqual(ctx.capabilities, []);
  });
});

test("finishing replaces the password, renames the team, and opens the gate", async () => {
  const { user, team } = await owner();
  const res = await as(user.id, team.id, () => finish(FINISH));
  assert.equal(res.ok, true);

  const [row] = await db.select().from(usersTable);
  assert.equal(row!.mustChangePassword, false);
  assert.equal(row!.name, "Ada Lovelace");
  assert.equal(row!.username, "ada-lovelace");
  assert.equal(row!.email, EMAIL, "the email stays the host's");
  const [renamed] = await db.select().from(teamsTable);
  assert.equal(renamed!.name, "Acme");
  assert.equal(renamed!.slug, "acme");

  const stored = await storedPassword(user.id);
  assert.ok(await verifyPassword(MINE, stored));
  assert.equal(await verifyPassword(TEMPORARY, stored), false);

  await as(user.id, team.id, async () => {
    assert.equal(await requireActiveTeamId(), team.id);
    assert.deepEqual(await requireInstanceAdmin(), { userId: user.id });
  });
});

test("finishing twice, or an account that never had a temporary password, is refused", async () => {
  const { user, team } = await owner();
  await as(user.id, team.id, () => finish(FINISH));
  const again = await as(user.id, team.id, () =>
    finishSetup({ ...FINISH, password: "An0ther!pass" }),
  );
  assert.equal(again.ok, false);
  assert.match(again.error ?? "", /already set up/);
  assert.ok(await verifyPassword(MINE, await storedPassword(user.id)));
});

test("the new password meets the policy, and a refusal changes nothing", async () => {
  const { user, team } = await owner();
  const res = await as(user.id, team.id, () =>
    finishSetup({ ...FINISH, password: "weak" }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.field, "password");
  const [row] = await db.select().from(usersTable);
  assert.equal(row!.mustChangePassword, true);
  assert.ok(await verifyPassword(TEMPORARY, await storedPassword(user.id)));
});

test("another team's name is refused and the account stays unfinished", async () => {
  const { user, team } = await owner();
  await db.insert(teamsTable).values({
    id: "team_other",
    name: "Acme",
    slug: "acme",
    plan: "pro",
    createdAt: new Date().toISOString(),
  });
  const res = await as(user.id, team.id, () => finishSetup(FINISH));
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /team name is taken/);
  const [row] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, user.id));
  assert.equal(row!.mustChangePassword, true);
});
