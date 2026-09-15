import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { passkey as passkeyTable } from "../db/schema/auth";
import { memberships as membershipsTable } from "../db/schema/control-plane/access-control";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import {
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane/identity";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { runWithIdentity } from "../auth/request-context";
import { setStoredPublicBaseUrl } from "../public-url";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  deletePasskey,
  finishPasskeyRegistration,
  listMyPasskeys,
  renamePasskey,
  startPasskeyRegistration,
} from "./passkeys";
import { resetUserPasskeys } from "./members/instance-users";

let db: TestDb;
let pg: PGlite;

const USER_2 = "user_2";
const PASSWORD = "password1";
const OTHER_PASSWORD = "password2";
const PANEL = "https://deplo.example.com";
const RP_ID = "deplo.example.com";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  setStoredPublicBaseUrl(PANEL);
});

after(async () => {
  setStoredPublicBaseUrl(null);
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table passkey, two_factor, account, session, activities, memberships, team_roles, users, teams, instance_settings, rate_limits restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", password: PASSWORD },
      { id: USER_2, teamId: TEAM_A, role: "member", password: OTHER_PASSWORD },
    ],
  });
});

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

const asToken = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity(
    {
      userId,
      teamId: TEAM_A,
      token: {
        id: "tok_1",
        capabilities: [],
        scope: null,
        instanceAdmin: true,
      },
    },
    fn,
  );

async function seedPasskey(
  userId: string,
  id = "pk-1",
  name = "Test device",
  rpId: string | null = RP_ID,
  authenticator: { backedUp?: boolean; transports?: string | null } = {},
) {
  await db.insert(passkeyTable).values({
    id,
    name,
    userId,
    publicKey: "cHVibGljLWtleQ",
    credentialID: `cred-${id}`,
    counter: 0,
    deviceType: authenticator.backedUp ? "multiDevice" : "singleDevice",
    backedUp: authenticator.backedUp ?? false,
    transports: authenticator.transports ?? "internal",
    createdAt: new Date(),
    rpId,
  });
}

test("the kind comes from the authenticator, not from the name", async () => {
  await seedPasskey(USER_1, "pk-phone", "Anything", RP_ID, {
    backedUp: true,
    transports: "internal,hybrid",
  });
  await seedPasskey(USER_1, "pk-yubi", "Anything", RP_ID, {
    transports: "usb,nfc",
  });
  await seedPasskey(USER_1, "pk-laptop", "Anything", RP_ID, {
    transports: "internal",
  });
  const byId = new Map(
    (await asUser(USER_1, listMyPasskeys)).map((p) => [p.id, p.kind]),
  );
  assert.equal(byId.get("pk-phone"), "synced");
  assert.equal(byId.get("pk-yubi"), "securityKey");
  assert.equal(byId.get("pk-laptop"), "device");
});

const passkeyRows = (userId: string) =>
  db
    .select({ id: passkeyTable.id, name: passkeyTable.name })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId));

test("every passkey function refuses a bearer token", async () => {
  await seedPasskey(USER_1);
  const calls: [string, () => Promise<unknown>][] = [
    ["listMyPasskeys", () => listMyPasskeys()],
    ["startPasskeyRegistration", () => startPasskeyRegistration(PASSWORD)],
    [
      "finishPasskeyRegistration",
      () => finishPasskeyRegistration({ response: {}, name: "x" }),
    ],
    ["renamePasskey", () => renamePasskey({ id: "pk-1", name: "x" })],
    ["deletePasskey", () => deletePasskey({ id: "pk-1", password: PASSWORD })],
  ];
  for (const [what, call] of calls) {
    await assert.rejects(
      () => asToken(USER_1, call),
      /An API token can't access/,
      `${what} must refuse a token`,
    );
  }
  assert.equal(
    (await passkeyRows(USER_1)).length,
    1,
    "and nothing was changed on the way to being refused",
  );
});

test("a wrong password reaches neither registration nor removal", async () => {
  await seedPasskey(USER_1);
  await asUser(USER_1, async () => {
    await assert.rejects(
      () => startPasskeyRegistration("not-it"),
      /password is not correct/,
    );
    await assert.rejects(
      () => deletePasskey({ id: "pk-1", password: "not-it" }),
      /password is not correct/,
    );
  });
  assert.equal((await passkeyRows(USER_1)).length, 1, "still there");
});

test("another account's password is not this account's password", async () => {
  await seedPasskey(USER_1);
  await asUser(USER_1, () =>
    assert.rejects(
      () => deletePasskey({ id: "pk-1", password: OTHER_PASSWORD }),
      /password is not correct/,
    ),
  );
});

test("six wrong passwords buy a pause, and it is the limiter that says so", async () => {
  await asUser(USER_1, async () => {
    for (let i = 0; i < 6; i++)
      await assert.rejects(
        () => startPasskeyRegistration("not-it"),
        /password is not correct/,
        `attempt ${i + 1} should still be a password error`,
      );
    await assert.rejects(
      () => startPasskeyRegistration("not-it"),
      /Too many attempts/,
      "the seventh is the limiter, not the password check",
    );
    await assert.rejects(
      () => startPasskeyRegistration(PASSWORD),
      /Too many attempts/,
      "a correct password must not walk past a tripped limiter",
    );
  });
});

test("the limiter is per account, not global", async () => {
  await asUser(USER_1, async () => {
    for (let i = 0; i < 7; i++)
      await startPasskeyRegistration("not-it").catch(() => undefined);
  });
  await asUser(USER_2, () =>
    assert.rejects(
      () => startPasskeyRegistration("not-it"),
      /password is not correct/,
      "one account's guessing must not lock another one out",
    ),
  );
});

test("the list is scoped to the caller", async () => {
  await seedPasskey(USER_1, "pk-mine", "Mine");
  await seedPasskey(USER_2, "pk-theirs", "Theirs");
  const mine = await asUser(USER_1, () => listMyPasskeys());
  assert.deepEqual(
    mine.map((p) => p.id),
    ["pk-mine"],
  );
  const theirs = await asUser(USER_2, () => listMyPasskeys());
  assert.deepEqual(
    theirs.map((p) => p.id),
    ["pk-theirs"],
    "the request-scoped cache must not answer with the previous caller's list",
  );
});

test("deleting another account's passkey is a not-found, not a delete", async () => {
  await seedPasskey(USER_2, "pk-theirs", "Theirs");
  await asUser(USER_1, () =>
    assert.rejects(
      () => deletePasskey({ id: "pk-theirs", password: PASSWORD }),
      /no longer on this account/,
    ),
  );
  assert.equal(
    (await passkeyRows(USER_2)).length,
    1,
    "the other account still has it",
  );
});

test("renaming another account's passkey changes nothing", async () => {
  await seedPasskey(USER_2, "pk-theirs", "Theirs");
  await asUser(USER_1, () =>
    assert.rejects(
      () => renamePasskey({ id: "pk-theirs", name: "Mine now" }),
      /no longer on this account/,
    ),
  );
  const [row] = await passkeyRows(USER_2);
  assert.equal(row?.name, "Theirs");
});

test("a name is trimmed, capped and never empty", async () => {
  await seedPasskey(USER_1);
  await asUser(USER_1, async () => {
    await assert.rejects(
      () => renamePasskey({ id: "pk-1", name: "   " }),
      /Give this passkey a name/,
      "whitespace is not a name",
    );
    await renamePasskey({ id: "pk-1", name: "  Trimmed  " });
    assert.equal((await listMyPasskeys())[0]!.name, "Trimmed");

    await renamePasskey({ id: "pk-1", name: "x".repeat(200) });
    const long = (await listMyPasskeys())[0]!.name;
    assert.equal(long.length, 64, "a label is capped rather than refused");
  });
});

const activityFor = (teamId: string) =>
  db
    .select({ message: activitiesTable.message, actor: activitiesTable.actor })
    .from(activitiesTable)
    .where(eq(activitiesTable.teamId, teamId));

test("removing a passkey is recorded in every team the person is in", async () => {
  await db.insert(membershipsTable).values({
    id: "mem_user_1_b",
    userId: USER_1,
    teamId: TEAM_B,
    role: "owner",
    createdAt: new Date().toISOString(),
  });
  await seedPasskey(USER_1, "pk-1", "Laptop");

  await asUser(USER_1, () => deletePasskey({ id: "pk-1", password: PASSWORD }));

  for (const team of [TEAM_A, TEAM_B]) {
    const rows = await activityFor(team);
    assert.equal(rows.length, 1, `one row in ${team}`);
    assert.match(rows[0]!.message, /Removed the Laptop passkey/);
    assert.equal(
      rows[0]!.actor,
      USER_1,
      "attributed to the person, not to Deplo",
    );
  }
});

test("a refused removal writes nothing", async () => {
  await seedPasskey(USER_1);
  await asUser(USER_1, () =>
    deletePasskey({ id: "pk-1", password: "not-it" }).catch(() => undefined),
  );
  assert.equal((await activityFor(TEAM_A)).length, 0);
});

test("the ceiling counts every passkey, usable here or not", async () => {
  for (let i = 0; i < 19; i++)
    await seedPasskey(USER_1, `pk-old-${i}`, `Old ${i}`, "old.example.com");
  await seedPasskey(USER_1, "pk-here");
  await asUser(USER_1, () =>
    assert.rejects(
      () => startPasskeyRegistration(PASSWORD),
      /already has 20 passkeys/,
    ),
  );
});

const claimOwner = (userId: string) =>
  db
    .insert(instanceSettings)
    .values({
      id: "default",
      ownerUserId: userId,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { ownerUserId: userId },
    });

test("no admin but the owner may clear the owner's passkeys", async () => {
  await claimOwner(USER_2);
  await db
    .update(usersTable)
    .set({ isInstanceAdmin: true })
    .where(eq(usersTable.id, USER_1));
  await seedPasskey(USER_2, "pk-owner", "Owner laptop");

  await asUser(USER_1, () =>
    assert.rejects(
      () => resetUserPasskeys(USER_2),
      /Only the instance owner/,
      "the crown is closed to every other admin, this hatch included",
    ),
  );
  assert.equal((await passkeyRows(USER_2)).length, 1);
});

test("clearing someone's passkeys touches nothing else", async () => {
  await db
    .update(usersTable)
    .set({ isInstanceAdmin: true, twoFactorEnabled: true })
    .where(eq(usersTable.id, USER_2));
  await seedPasskey(USER_2, "pk-a");
  await seedPasskey(USER_2, "pk-b", "Spare");

  await asUser(USER_1, () => resetUserPasskeys(USER_2));

  assert.equal((await passkeyRows(USER_2)).length, 0);
  const [u] = await db
    .select({
      tfa: usersTable.twoFactorEnabled,
      suspended: usersTable.suspended,
    })
    .from(usersTable)
    .where(eq(usersTable.id, USER_2));
  assert.equal(u?.tfa, true, "their authenticator app is not collateral");
  assert.equal(u?.suspended, false);
  const rows = await activityFor(TEAM_A);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.message, /2 passkeys/);
});

test("a passkey does not outlive its user", async () => {
  await seedPasskey(USER_2, "pk-theirs");
  await db.delete(usersTable).where(eq(usersTable.id, USER_2));
  const left = await db
    .select({ id: passkeyTable.id })
    .from(passkeyTable)
    .where(eq(passkeyTable.id, "pk-theirs"));
  assert.equal(left.length, 0, "the FK cascade is what makes this true");
});

test("finishing a registration nobody started creates nothing", async () => {
  await asUser(USER_1, async () => {
    await assert.rejects(
      () =>
        finishPasskeyRegistration({
          response: { id: "made-up", rawId: "made-up", type: "public-key" },
          name: "Forged",
        }),
      /.+/,
    );
  });
  assert.equal((await passkeyRows(USER_1)).length, 0);
});

test("with no policy in force, the last passkey goes without argument", async () => {
  await seedPasskey(USER_1);
  await asUser(USER_1, () => deletePasskey({ id: "pk-1", password: PASSWORD }));
  assert.equal((await passkeyRows(USER_1)).length, 0);
});

test("two removals racing each other cannot both win", async () => {
  await db
    .update(teamsTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamsTable.id, TEAM_A));
  await seedPasskey(USER_1, "pk-1", "One");
  await seedPasskey(USER_1, "pk-2", "Two");

  const results = await Promise.allSettled([
    asUser(USER_1, () => deletePasskey({ id: "pk-1", password: PASSWORD })),
    asUser(USER_1, () => deletePasskey({ id: "pk-2", password: PASSWORD })),
  ]);
  const kept = await passkeyRows(USER_1);
  assert.equal(
    kept.length,
    1,
    `both deletes landed (${results.map((r) => r.status).join(", ")}) - the account lost its only second factor`,
  );
});

test("no query in this module ever selects key material", async () => {
  await seedPasskey(USER_1);
  const rows = await asUser(USER_1, () => listMyPasskeys());
  const serialized = JSON.stringify(rows);
  for (const secret of ["cHVibGljLWtleQ", "cred-pk-1"])
    assert.equal(
      serialized.includes(secret),
      false,
      `${secret} must not be reachable from a DTO`,
    );
  const [raw] = await db
    .select({ pk: passkeyTable.publicKey, cid: passkeyTable.credentialID })
    .from(passkeyTable)
    .where(and(eq(passkeyTable.userId, USER_1), eq(passkeyTable.id, "pk-1")));
  assert.equal(raw?.pk, "cHVibGljLWtleQ");
  assert.equal(raw?.cid, "cred-pk-1");
});
