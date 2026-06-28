import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "./db/test-harness";
import { __setTestDb, __resetTestDb } from "./db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  registrationLinks as registrationLinksTable,
  users as usersTable,
} from "./db/schema/control-plane";
import { eq } from "drizzle-orm";
import { runWithIdentity } from "./auth/request-context";
import { createAccountWithTeam, createAccountWithTeams, login } from "./auth";
import { consumeRegistrationLink } from "./data/members";
import { changePassword } from "./data/account";
import {
  seedIdentity,
  seedRegistrationLink,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "./data/identity-test-helpers";
import { capabilitiesForRole } from "./membership-shared";

/**
 * Auth cut-set (b) tests against pglite (relational-store PLAN Step 3):
 * `createAccountWithTeam` as one `db.transaction`, the single-use registration
 * link's two-concurrent race, and the stale-password-login regression that
 * proves login reads the RELATIONAL password hash (the per-module-migration
 * hazard the cut-set boundary closes).
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
  await pg.exec(TRUNCATE_IDENTITY);
});

const ACCOUNT = {
  username: "newowner",
  name: "New Owner",
  email: "new@owner.io",
  password: "password1",
  teamName: "New Team",
};

test("createAccountWithTeam writes user + team + owner membership with caps", async () => {
  const { user, team } = await createAccountWithTeam(ACCOUNT);
  assert.equal(user.username, "newowner");
  assert.equal(team.name, "New Team");

  const urow = (
    await db.select().from(usersTable).where(eq(usersTable.id, user.id))
  )[0]!;
  assert.equal(urow.email, "new@owner.io");
  assert.equal(urow.role, "owner");
  // The password is stored hashed, never plaintext.
  assert.notEqual(urow.passwordHash, "password1");

  const mrows = await db
    .select()
    .from(membershipsTable)
    .where(eq(membershipsTable.teamId, team.id));
  assert.equal(mrows.length, 1);
  assert.equal(mrows[0]!.userId, user.id);
  assert.equal(mrows[0]!.role, "owner");

  const caps = await db
    .select({ c: membershipCapabilitiesTable.capability })
    .from(membershipCapabilitiesTable)
    .where(eq(membershipCapabilitiesTable.membershipId, mrows[0]!.id));
  assert.deepEqual(
    new Set(caps.map((r) => r.c)),
    new Set(capabilitiesForRole("owner")),
  );
});

test("createAccountWithTeam rejects a duplicate username / email / team name", async () => {
  await createAccountWithTeam(ACCOUNT);
  await assert.rejects(
    () => createAccountWithTeam({ ...ACCOUNT, email: "other@x.io", teamName: "Other" }),
    /username is taken/,
  );
  await assert.rejects(
    () =>
      createAccountWithTeam({
        ...ACCOUNT,
        username: "different",
        teamName: "Other",
      }),
    /email already exists/,
  );
  await assert.rejects(
    () =>
      createAccountWithTeam({
        ...ACCOUNT,
        username: "different",
        email: "other@x.io",
      }),
    /team name is taken/,
  );
});

test("createAccountWithTeams joins existing teams with per-team roles + caps, owning none", async () => {
  await seedIdentity(db); // TEAM_A (alpha) + TEAM_B (beta) exist
  const { user, activeTeamId } = await createAccountWithTeams(
    { username: "joiner", name: "Joiner", email: "joiner@x.io", password: "password1" },
    [
      { teamId: TEAM_A, role: "member", capabilities: capabilitiesForRole("member") },
      { teamId: TEAM_B, role: "viewer", capabilities: ["view"] },
    ],
  );
  // Active team is the first assignment; the user owns no team (legacy role).
  assert.equal(activeTeamId, TEAM_A);
  const urow = (
    await db.select().from(usersTable).where(eq(usersTable.id, user.id))
  )[0]!;
  assert.equal(urow.role, "member");

  const mems = await db
    .select()
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, user.id));
  assert.equal(mems.length, 2);
  const roleByTeam = Object.fromEntries(mems.map((m) => [m.teamId, m.role]));
  assert.equal(roleByTeam[TEAM_A], "member");
  assert.equal(roleByTeam[TEAM_B], "viewer");

  // The viewer membership's caps are exactly what was passed (always incl. view).
  const memB = mems.find((m) => m.teamId === TEAM_B)!;
  const capsB = await db
    .select({ c: membershipCapabilitiesTable.capability })
    .from(membershipCapabilitiesTable)
    .where(eq(membershipCapabilitiesTable.membershipId, memB.id));
  assert.deepEqual(new Set(capsB.map((r) => r.c)), new Set(["view"]));
});

test("createAccountWithTeams skips teams deleted before use, and fails if none remain", async () => {
  await seedIdentity(db);
  // One real team + one already-gone team → user joins only the survivor.
  const { user } = await createAccountWithTeams(
    { username: "partial", name: "Partial", email: "p@x.io", password: "password1" },
    [
      { teamId: TEAM_A, role: "member", capabilities: capabilitiesForRole("member") },
      { teamId: "team_gone", role: "member", capabilities: [] },
    ],
  );
  const mems = await db
    .select()
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, user.id));
  assert.equal(mems.length, 1);
  assert.equal(mems[0]!.teamId, TEAM_A);

  // All assigned teams gone → throws and creates NOTHING (tx rolls back).
  await assert.rejects(
    () =>
      createAccountWithTeams(
        { username: "ghost", name: "Ghost", email: "g@x.io", password: "password1" },
        [{ teamId: "team_gone", role: "member", capabilities: [] }],
      ),
    /no longer exist/,
  );
  const ghost = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, "ghost"));
  assert.equal(ghost.length, 0);
});

test("createAccountWithTeams consumes the registration link (single-use); a spent link rolls back", async () => {
  await seedIdentity(db);
  const rawToken = await seedRegistrationLink(db);
  const join = (username: string) =>
    createAccountWithTeams(
      { username, name: username, email: `${username}@reg.io`, password: "password1" },
      [{ teamId: TEAM_A, role: "member", capabilities: capabilitiesForRole("member") }],
      { guard: (tx) => consumeRegistrationLink(tx, rawToken, username) },
    );
  await join("first"); // consumes the link
  await assert.rejects(() => join("second"), /no longer valid/);
  // Only the first account exists beyond the seeded owner (USER_1).
  const names = (await db.select().from(usersTable)).map((u) => u.username);
  assert.ok(names.includes("first"));
  assert.ok(!names.includes("second"));
});

test("registration link is single-use: two concurrent registrations, exactly one wins", async () => {
  const rawToken = await seedRegistrationLink(db);

  const register = (username: string) =>
    createAccountWithTeam(
      {
        username,
        name: username,
        email: `${username}@reg.io`,
        password: "password1",
        teamName: `${username}-team`,
      },
      { guard: (tx) => consumeRegistrationLink(tx, rawToken, username) },
    );

  const results = await Promise.allSettled([
    register("racer_a"),
    register("racer_b"),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one registration succeeds");
  assert.equal(rejected.length, 1, "exactly one registration is rejected");
  assert.match(
    (rejected[0] as PromiseRejectedResult).reason.message,
    /no longer valid/,
  );

  // Exactly one account was minted, and the link is marked used.
  const userCount = (await db.select().from(usersTable)).length;
  assert.equal(userCount, 1, "one account total from the single-use link");
  const link = (
    await db
      .select()
      .from(registrationLinksTable)
      .where(eq(registrationLinksTable.id, "reg_1"))
  )[0]!;
  assert.equal(link.status, "used");
  assert.ok(link.usedByUsername === "racer_a" || link.usedByUsername === "racer_b");
});

test("registration link consume rejects an expired link", async () => {
  const rawToken = await seedRegistrationLink(db, {
    id: "reg_exp",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  await assert.rejects(
    () =>
      createAccountWithTeam(
        {
          username: "late",
          name: "late",
          email: "late@reg.io",
          password: "password1",
          teamName: "late-team",
        },
        { guard: (tx) => consumeRegistrationLink(tx, rawToken, "late") },
      ),
    /no longer valid/,
  );
  // Nothing was minted (the whole tx rolled back).
  assert.equal((await db.select().from(usersTable)).length, 0);
});

test("login reads the RELATIONAL password — a relational password change is seen immediately (stale-password regression)", async () => {
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner", password: "oldpass1" }],
  });
  const email = `${USER_1}@example.io`;

  // The OLD password authenticates before any change.
  assert.equal((await login(email, "wrongpass")).ok, false, "wrong password rejected");
  await assertLoginAccepts(email, "oldpass1");

  // Change the password through the relational data layer.
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, async () => {
    await changePassword({ currentPassword: "oldpass1", newPassword: "newpass2" });
  });

  // The OLD password must now FAIL and the NEW one succeed — proving login reads
  // the relational row, not a stale JSONB cache (the cut-set boundary hazard).
  assert.equal(
    (await login(email, "oldpass1")).ok,
    false,
    "old password no longer works after a relational change",
  );
  await assertLoginAccepts(email, "newpass2");
});

test("login refuses a suspended account", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", password: "password1", suspended: true },
    ],
  });
  const res = await login(`${USER_1}@example.io`, "password1");
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /suspended/);
});

/**
 * A successful `login` writes the session cookie via `cookies()`, which throws
 * "outside a request scope" under `node --test`. So "password accepted" is proven
 * by login getting PAST the credential check and reaching the cookie write — i.e.
 * it does NOT return `{ ok:false, error:"Invalid email or password" }`; instead
 * it throws the cookie-scope error. (A wrong password returns ok:false before any
 * cookie write and never throws.)
 */
async function assertLoginAccepts(email: string, password: string): Promise<void> {
  try {
    const res = await login(email, password);
    // If it returned without throwing, it must NOT be the invalid-credentials path.
    assert.notEqual(res.ok, false, `login should accept ${password}`);
  } catch (e) {
    assert.match(
      (e as Error).message,
      /request scope/,
      "login reached the cookie write (credentials accepted)",
    );
  }
}
