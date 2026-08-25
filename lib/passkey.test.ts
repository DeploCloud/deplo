import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { desc, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "./db/test-harness";
import { __setTestDb, __resetTestDb } from "./db/client";
import {
  passkey as passkeyTable,
  session as sessionTable,
} from "./db/schema/auth";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane";
import { runWithIdentity } from "./auth/request-context";
import { requireAuth } from "./auth/better-auth";
import {
  getCurrentUser,
  login,
  markSessionAuthMethod,
  passkeyChallenge,
  verifyPasskeyLogin,
} from "./auth";
import {
  requireActiveTeamId,
  requireCapability,
  TwoFactorRequiredError,
} from "./membership";
import { userHasPasskey } from "./passkey-policy";
import {
  deletePasskey,
  listMyPasskeys,
  renamePasskey,
  startPasskeyRegistration,
} from "./data/passkeys";
import { resetUserPasskeys } from "./data/members";
import { changePassword } from "./data/account";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "./data/identity-test-helpers";
import { setStoredPublicBaseUrl } from "./public-url";
import { ALL_CAPABILITIES } from "./types";

/**
 * A passkey as a SECOND FACTOR - the three things about it that are true only by
 * construction, and would stop being true silently (ADR-0024). 1.
 * `/api/auth/passkey/*` cannot be reached over the network.
 */

const SOME_CAPABILITY = ALL_CAPABILITIES.find((c) => c !== "view")!;

let db: TestDb;
let pg: PGlite;

const PASSWORD = "password1";
const EMAIL_1 = `${USER_1}@example.io`;
const USER_2 = "user_2";
/** The panel address every test runs against, and the rpID derived from it. */
const PANEL = "https://deplo.example.com";
const RP_ID = "deplo.example.com";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // Without an address there is no relying party, and a passkey satisfies
  // nothing - which is a behaviour with its own tests further down.
  setStoredPublicBaseUrl(PANEL);
});

after(async () => {
  setStoredPublicBaseUrl(null);
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table passkey, two_factor, account, session, memberships, team_roles, users, teams, instance_settings, rate_limits restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", password: PASSWORD },
      { id: USER_2, teamId: TEAM_A, role: "member", password: PASSWORD },
    ],
  });
});

/**
 * A request with an identity but NO session - which is what a bearer token looks
 * like, and what every pre-existing test in the repo means by "as this user".
 */
const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

/** The id of the newest session belonging to `userId`. */
async function newestSession(userId: string): Promise<string> {
  const rows = await db
    .select({ id: sessionTable.id })
    .from(sessionTable)
    .where(eq(sessionTable.userId, userId))
    .orderBy(desc(sessionTable.createdAt))
    .limit(1);
  assert.ok(rows[0], "fixture: expected a session to exist");
  return rows[0].id;
}

/** A browser request riding on that account's newest session. */
async function runWithSession<T>(
  userId: string,
  teamId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const sessionId = await newestSession(userId);
  return runWithIdentity({ userId, teamId, sessionId }, fn);
}

const asSession = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithSession(userId, TEAM_A, fn);

/** Stamp the newest session the way a passkey sign-in would. */
async function markCurrentSession(method: "passkey"): Promise<void> {
  await markSessionAuthMethod(await newestSession(USER_1), USER_1, method);
}

/**
 * Put a credential on the account without running a ceremony.
 *
 * `rpId` defaults to this panel's; pass another to model a credential minted
 * before the address moved, or null to model a row from migration 0102.
 */
async function seedPasskey(
  userId: string,
  id = "pk-1",
  name = "Test device",
  rpId: string | null = RP_ID,
) {
  await db.insert(passkeyTable).values({
    id,
    name,
    userId,
    publicKey: "cHVibGljLWtleQ",
    credentialID: `cred-${id}`,
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    transports: "internal",
    createdAt: new Date(),
    rpId,
  });
}

const requireForTeam = () =>
  db
    .update(teamsTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamsTable.id, TEAM_A));

const enableTotp = () =>
  db
    .update(usersTable)
    .set({ twoFactorEnabled: true })
    .where(eq(usersTable.id, USER_1));

const sessionCount = async () =>
  (await pg.query<{ n: number }>(`select count(*)::int as n from session`))
    .rows[0]!.n;

/* ------------------------------------------------------------------ */
/* 1. The gate on the plugin's own endpoints                           */
/* ------------------------------------------------------------------ */

/**
 * The METHOD matters: better-call answers 404 when the verb does not match, and
 * a 404 would pass a "not 200" assertion while proving nothing about the gate.
 * Each endpoint is called the way it is actually declared.
 */
async function overHttp(path: string, method: "GET" | "POST") {
  return requireAuth().handler(
    new Request(
      `http://localhost/api/auth${path}`,
      method === "GET"
        ? { method }
        : {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
    ),
  );
}

for (const [path, method] of [
  ["/passkey/generate-register-options", "GET"],
  ["/passkey/generate-authenticate-options", "GET"],
  ["/passkey/list-user-passkeys", "GET"],
  ["/passkey/verify-registration", "POST"],
  ["/passkey/verify-authentication", "POST"],
  ["/passkey/delete-passkey", "POST"],
  ["/passkey/update-passkey", "POST"],
] as const) {
  test(`${path} is refused over HTTP`, async () => {
    const res = await overHttp(path, method);
    assert.equal(
      res.status,
      403,
      "the plugin's own endpoints must not be reachable from a browser",
    );
  });
}

test("the passkey gate leaves the rest of Better Auth alone", async () => {
  // Proves the matcher is scoped to /passkey/ rather than having quietly closed the
  // whole auth surface. Not `/sign-in/email` any more: `deploOwnedGate` closes that
  // one on its own merits, so a 403 there would say nothing about THIS matcher.
  const res = await overHttp("/get-session", "GET");
  assert.notEqual(res.status, 403, "get-session still reaches its own handler");
});

/* ------------------------------------------------------------------ */
/* 2. A passkey satisfies the mandate                                  */
/* ------------------------------------------------------------------ */

test("a passkey satisfies a team's two-factor mandate", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);

  await asUser(USER_1, async () => {
    assert.equal(await requireActiveTeamId(), TEAM_A);
    const ctx = await requireCapability(SOME_CAPABILITY);
    assert.equal(ctx.userId, USER_1);
  });
});

test("removing the passkey puts the account back under the mandate", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  await db.delete(passkeyTable).where(eq(passkeyTable.userId, USER_1));

  await asUser(USER_1, async () => {
    // Both gates, because each is reached by a different path: reads never touch
    // membershipFor, so closing only one of them is the bug this catches.
    await assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
    );
    await assert.rejects(
      () => requireCapability(SOME_CAPABILITY),
      (e: unknown) => e instanceof TwoFactorRequiredError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 3. Owning a passkey is not the same as having used one              */
/* ------------------------------------------------------------------ */

/**
 * The hole, and the thing that closes it without becoming a lockout.
 *
 * A passkey satisfies a mandate, so an account that merely OWNS one must not
 * clear a two-factor policy by typing a password - that would be one factor
 * doing the work of two. But refusing the sign-in outright would take away what
 * ADR-0014 §4 promises: a blocked member keeps their own account settings, which
 * is what lets them unblock themselves. So the password always opens a session,
 * and the session carries what it actually proved.
 */

test("a password session does not inherit the account's passkey", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);

  const res = await login(EMAIL_1, PASSWORD);
  assert.equal(res.ok, true, "the password still signs people in");
  assert.equal(await sessionCount(), 1);

  await asSession(USER_1, async () => {
    await assert.rejects(
      () => requireCapability(SOME_CAPABILITY),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "one factor must not clear a two-factor policy",
    );
    await assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
    );
  });
});

test("a session the passkey opened does satisfy the mandate", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  await login(EMAIL_1, PASSWORD);
  await markCurrentSession("passkey");

  await asSession(USER_1, async () => {
    assert.equal(await requireActiveTeamId(), TEAM_A);
    const ctx = await requireCapability(SOME_CAPABILITY);
    assert.equal(ctx.userId, USER_1);
  });
});

test("a bearer token still inherits the ACCOUNT's standing", async () => {
  // A token presents no factors at all, so the session question does not apply
  // to it - and `identityForTokenRow` asks this before any identity exists,
  // which is the branch that would break token authentication outright.
  await requireForTeam();
  await seedPasskey(USER_1);
  await asUser(USER_1, async () => {
    assert.equal(await requireActiveTeamId(), TEAM_A);
  });
});

test("a wrong password is still just a wrong password", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  const res = await login(EMAIL_1, "not-the-password");
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /Invalid email or password/);
  assert.equal(await sessionCount(), 0);
});

/* ------------------------------------------------------------------ */
/* 10. The login path, in the shapes that are easy to get wrong        */
/* ------------------------------------------------------------------ */

test("a suspended account is refused before anything about passkeys is decided", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  await db
    .update(usersTable)
    .set({ suspended: true })
    .where(eq(usersTable.id, USER_1));

  const res = await login(EMAIL_1, PASSWORD);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /suspended/);
  assert.equal(await sessionCount(), 0);
});

test("an authenticator app wins over a passkey at the login fork", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  await enableTotp();
  const res = await login(EMAIL_1, PASSWORD);
  assert.equal(
    res.requiresTwoFactor,
    true,
    "an enrolled app is still the challenge the password leads to",
  );
  assert.equal(await sessionCount(), 0, "and no session until the code lands");
});

test("a role's mandate blocks a password session too, not just the team's", async () => {
  // The role half of the policy is a separate column and a separate join; a
  // predicate that only read `teams.require_two_factor` would pass every other
  // test in this file.
  await db.insert(teamRolesTable).values({
    id: "role_locked",
    teamId: TEAM_A,
    name: "Locked",
    builtinKey: null,
    requireTwoFactor: true,
    createdAt: new Date().toISOString(),
  });
  await db
    .update(membershipsTable)
    .set({ roleId: "role_locked" })
    .where(eq(membershipsTable.userId, USER_1));
  await seedPasskey(USER_1);

  await login(EMAIL_1, PASSWORD);
  await asSession(USER_1, () =>
    assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
    ),
  );
});

test("a garbage assertion signs nobody in and says nothing useful about why", async () => {
  const before = await sessionCount();
  const res = await verifyPasskeyLogin({
    id: "made-up",
    rawId: "made-up",
    type: "public-key",
    response: {},
    clientExtensionResults: {},
  });
  assert.equal(res.ok, false);
  assert.equal(await sessionCount(), before, "no session was minted");
  // The message must still come from the auth layer rather than being swallowed
  // by the sanitizer that keeps database errors off the sign-in page.
  assert.notEqual(
    res.error,
    undefined,
    "an anonymous caller still deserves to know the attempt failed",
  );
  assert.equal(
    /password|postgres|relation|connect|ECONN/i.test(res.error ?? ""),
    false,
    `the message must not describe the inside of the instance: "${res.error}"`,
  );
});

test("the challenge is refused outright when this panel cannot have passkeys", async () => {
  setStoredPublicBaseUrl("http://deplo.example.com");
  try {
    await assert.rejects(() => passkeyChallenge(), /https address/);
  } finally {
    setStoredPublicBaseUrl(PANEL);
  }
});

/* ------------------------------------------------------------------ */
/* 10b. The stamp itself                                               */
/* ------------------------------------------------------------------ */

test("a session refresh does not wash the stamp off", async () => {
  // Better Auth extends a session in place every `updateAge` (15 minutes here) by
  // UPDATEing `expires_at`/`updated_at` on the same row.
  await requireForTeam();
  await seedPasskey(USER_1);
  await login(EMAIL_1, PASSWORD);
  await markCurrentSession("passkey");

  const id = await newestSession(USER_1);
  const [row] = await db
    .select({ token: sessionTable.token })
    .from(sessionTable)
    .where(eq(sessionTable.id, id));
  await (
    await requireAuth().$context
  ).internalAdapter.updateSession(row!.token, {
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    updatedAt: new Date(),
  });

  assert.equal(await newestSession(USER_1), id, "the row is the same row");
  await asSession(USER_1, async () => {
    assert.equal(await requireActiveTeamId(), TEAM_A);
  });
});

test("the stamp cannot be put on somebody else's session", async () => {
  await login(EMAIL_1, PASSWORD);
  const victim = await newestSession(USER_1);
  // A caller that knows an id but not whose it is must change nothing. Nothing
  // passes a caller-supplied id today; this is what keeps that safe if one does.
  await markSessionAuthMethod(victim, USER_2, "passkey");
  const [row] = await db
    .select({ method: sessionTable.authMethod })
    .from(sessionTable)
    .where(eq(sessionTable.id, victim));
  assert.equal(row?.method, null, "the owner mismatch hit zero rows");
});

test("stamping a session that no longer exists is a no-op, not a crash", async () => {
  await markSessionAuthMethod("ses_gone", USER_1, "passkey");
});

test("changing the password keeps a passkey session's standing", async () => {
  // `changePassword` revokes every session and mints a replacement from the new
  // password.
  await requireForTeam();
  await seedPasskey(USER_1);
  await login(EMAIL_1, PASSWORD);
  await markCurrentSession("passkey");

  await asSession(USER_1, () =>
    changePassword({
      currentPassword: PASSWORD,
      newPassword: "Nq7-Zx4wPl2rTv",
    }),
  );

  const [row] = await db
    .select({ method: sessionTable.authMethod })
    .from(sessionTable)
    .where(eq(sessionTable.userId, USER_1));
  assert.equal(row?.method, "passkey", "the replacement session carries it");
  await asSession(USER_1, async () => {
    assert.equal(await requireActiveTeamId(), TEAM_A);
  });
});

test("changing the password does not INVENT a standing", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  await login(EMAIL_1, PASSWORD); // password session, never stamped

  await asSession(USER_1, () =>
    changePassword({
      currentPassword: PASSWORD,
      newPassword: "Nq7-Zx4wPl2rTv",
    }),
  );

  const [row] = await db
    .select({ method: sessionTable.authMethod })
    .from(sessionTable)
    .where(eq(sessionTable.userId, USER_1));
  assert.equal(
    row?.method,
    null,
    "a password session stays a password session",
  );
});

test("signing out and back in with the password loses the standing", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  await login(EMAIL_1, PASSWORD);
  await markCurrentSession("passkey");
  await asSession(USER_1, async () => {
    assert.equal(await requireActiveTeamId(), TEAM_A, "fixture");
  });

  await pg.exec(`delete from session;`);
  await login(EMAIL_1, PASSWORD);
  await asSession(USER_1, () =>
    assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "a fresh password session starts with nothing to its name",
    ),
  );
});

test("deleting the passkey ends the standing of a session that used it", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  await login(EMAIL_1, PASSWORD);
  await markCurrentSession("passkey");
  await db.delete(passkeyTable).where(eq(passkeyTable.userId, USER_1));

  await asSession(USER_1, () =>
    assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "both halves are required, and the credential is one of them",
    ),
  );
});

/* ------------------------------------------------------------------ */
/* 11. Blocked, but never locked out                                   */
/* ------------------------------------------------------------------ */

/**
 * The property ADR-0014 §4 exists for, now that a passkey can be the thing a
 * mandate rests on: a member who cannot satisfy the policy is stopped INSIDE the
 * team and nowhere else, so the screen that fixes it is reachable.
 */
test("a blocked password session can still reach its own account", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  await login(EMAIL_1, PASSWORD);

  await asSession(USER_1, async () => {
    await assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "the team is blocked",
    );
    // …and the account is not. These are exactly what Settings -> Security
    // reads, and they are what makes the block recoverable rather than a wall.
    const me = await getCurrentUser();
    assert.equal(me?.id, USER_1);
    assert.equal((await listMyPasskeys()).length, 1);
  });
});

test("a mandate in one team leaves the others alone", async () => {
  await db.insert(membershipsTable).values({
    id: "mem_user_1_b",
    userId: USER_1,
    teamId: TEAM_B,
    role: "owner",
    createdAt: new Date().toISOString(),
  });
  await requireForTeam();
  await seedPasskey(USER_1);
  await login(EMAIL_1, PASSWORD);

  await runWithSession(USER_1, TEAM_B, async () => {
    assert.equal(
      await requireActiveTeamId(),
      TEAM_B,
      "a policy TEAM_B never set must not reach into it",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. Removing the last one cannot lock you out                        */
/* ------------------------------------------------------------------ */

test("the last passkey cannot be removed while a policy rests on it", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);

  await asUser(USER_1, () =>
    assert.rejects(
      () => deletePasskey({ id: "pk-1", password: PASSWORD }),
      /requires two-factor authentication/,
      "one click would otherwise lock the person out of their own team",
    ),
  );

  // With an authenticator app on, the policy no longer depends on the passkey,
  // so the guard must stand aside. (The delete itself needs a live Better Auth
  // session, which this harness has no request scope for - what is asserted is
  // that the refusal is no longer the mandate.)
  await enableTotp();
  await asUser(USER_1, async () => {
    const err = await deletePasskey({ id: "pk-1", password: PASSWORD }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.doesNotMatch(
      err instanceof Error ? err.message : "",
      /requires two-factor authentication/,
    );
  });
});

test("a passkey that is not the last one is removable under a policy", async () => {
  await requireForTeam();
  await seedPasskey(USER_1, "pk-1");
  await seedPasskey(USER_1, "pk-2", "Spare");

  await asUser(USER_1, async () => {
    const err = await deletePasskey({ id: "pk-1", password: PASSWORD }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.doesNotMatch(
      err instanceof Error ? err.message : "",
      /requires two-factor authentication/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5. A passkey only counts where it can be used                       */
/* ------------------------------------------------------------------ */

/**
 * A credential the browser will not offer here is not a second factor here. The
 * account falls back to "no second factor", which is the ordinary blocked-but-
 * recoverable state - rather than looking protected by something nobody can
 * present.
 */

test("a passkey minted for another address counts for nothing", async () => {
  await requireForTeam();
  await seedPasskey(USER_1, "pk-old", "Old address", "old.example.com");

  assert.equal(await userHasPasskey(USER_1), false);
  await login(EMAIL_1, PASSWORD);
  await markCurrentSession("passkey");
  await asSession(USER_1, async () => {
    await assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "even a passkey-stamped session cannot lean on a credential for another address",
    );
  });
});

test("a row from before rp_id existed counts for nothing either", async () => {
  await requireForTeam();
  await seedPasskey(USER_1, "pk-legacy", "Legacy", null);
  assert.equal(await userHasPasskey(USER_1), false);
});

test("turning the panel's https off makes every passkey stop counting", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  assert.equal(await userHasPasskey(USER_1), true, "fixture");
  await login(EMAIL_1, PASSWORD);
  await markCurrentSession("passkey");

  // What `setPanelHttps(false)` does to the rest of the process.
  setStoredPublicBaseUrl("http://deplo.example.com");
  try {
    assert.equal(await userHasPasskey(USER_1), false);
    await asSession(USER_1, () =>
      assert.rejects(
        () => requireActiveTeamId(),
        (e: unknown) => e instanceof TwoFactorRequiredError,
        "no relying party, no second factor - and the account is asked for one",
      ),
    );
  } finally {
    setStoredPublicBaseUrl(PANEL);
  }
});

test("an unusable passkey is still listed, flagged, and removable", async () => {
  await requireForTeam();
  await seedPasskey(USER_1, "pk-here");
  await seedPasskey(USER_1, "pk-old", "Old address", "old.example.com");

  await asUser(USER_1, async () => {
    const rows = await listMyPasskeys();
    assert.equal(
      rows.length,
      2,
      "a dead credential must not vanish from the list",
    );
    assert.equal(rows.find((r) => r.id === "pk-here")?.usableHere, true);
    assert.equal(rows.find((r) => r.id === "pk-old")?.usableHere, false);
    // The guard counts only the usable ones, so the stale row is never what
    // stands between the person and removing it.
    await deletePasskey({ id: "pk-old", password: PASSWORD });
  });
});

/* ------------------------------------------------------------------ */
/* 6. Registration guards                                              */
/* ------------------------------------------------------------------ */

test("registration is refused when the instance has no relying party", async () => {
  setStoredPublicBaseUrl("http://deplo.example.com");
  try {
    await asUser(USER_1, () =>
      assert.rejects(
        () => startPasskeyRegistration(PASSWORD),
        /https address/,
        "better a clear refusal than a ceremony that dies inside the browser",
      ),
    );
  } finally {
    setStoredPublicBaseUrl(PANEL);
  }
});

test("an account tops out at twenty passkeys", async () => {
  for (let i = 0; i < 20; i++) await seedPasskey(USER_1, `pk-${i}`, `Key ${i}`);
  await asUser(USER_1, () =>
    assert.rejects(
      () => startPasskeyRegistration(PASSWORD),
      /already has 20 passkeys/,
    ),
  );
});

/* ------------------------------------------------------------------ */
/* 7. Renaming                                                         */
/* ------------------------------------------------------------------ */

test("renaming is scoped to your own passkeys", async () => {
  await seedPasskey(USER_2, "pk-theirs", "Theirs");
  await asUser(USER_1, () =>
    assert.rejects(
      () => renamePasskey({ id: "pk-theirs", name: "Mine now" }),
      /no longer on this account/,
    ),
  );
  const [row] = await db
    .select({ name: passkeyTable.name })
    .from(passkeyTable)
    .where(eq(passkeyTable.id, "pk-theirs"));
  assert.equal(row?.name, "Theirs", "and it really did not move");
});

/* ------------------------------------------------------------------ */
/* 8. The plugin's own view of deplo's hand-written table              */
/* ------------------------------------------------------------------ */

test("the plugin's adapter can write, find and update a passkey row", async () => {
  // The one thing a rename in lib/db/schema/auth.ts breaks SILENTLY: the Drizzle
  // adapter resolves a model field as `schema.passkey[field]`, so the JS property
  // names are the plugin's field list verbatim.
  const adapter = (await requireAuth().$context).adapter;
  const created = (await adapter.create({
    model: "passkey",
    data: {
      name: "Probe",
      publicKey: "cHVi",
      userId: USER_1,
      credentialID: "cred-probe",
      counter: 3,
      deviceType: "singleDevice",
      backedUp: true,
      transports: "internal,hybrid",
      createdAt: new Date(),
      aaguid: "aa-guid",
    },
  })) as { id: string };
  assert.match(created.id, /^bas_/, "ids come from deplo's own generator");

  const found = (await adapter.findOne({
    model: "passkey",
    where: [{ field: "credentialID", value: "cred-probe" }],
  })) as { userId: string } | null;
  assert.equal(
    found?.userId,
    USER_1,
    "the authentication path resolves by credentialID",
  );

  await adapter.update({
    model: "passkey",
    where: [{ field: "id", value: created.id }],
    update: { counter: 9 },
  });
  const bumped = (await adapter.findOne({
    model: "passkey",
    where: [{ field: "id", value: created.id }],
  })) as { counter: number } | null;
  assert.equal(bumped?.counter, 9, "the replay counter is written back");
});

/* ------------------------------------------------------------------ */
/* 9. The admin escape hatch                                           */
/* ------------------------------------------------------------------ */

const makeAdmin = (userId: string) =>
  db
    .update(usersTable)
    .set({ isInstanceAdmin: true })
    .where(eq(usersTable.id, userId));

test("an admin clears someone else's passkeys", async () => {
  await makeAdmin(USER_1);
  await seedPasskey(USER_2, "pk-a");
  await seedPasskey(USER_2, "pk-b", "Spare");

  await asUser(USER_1, () => resetUserPasskeys(USER_2));
  assert.equal(
    await userHasPasskey(USER_2),
    false,
    "a device that is gone must stop satisfying the policy",
  );
});

test("an admin cannot clear their own passkeys here", async () => {
  await makeAdmin(USER_1);
  await seedPasskey(USER_1);
  await assert.rejects(
    () => asUser(USER_1, () => resetUserPasskeys(USER_1)),
    /your own passkeys/,
    "that is the password-free removal Settings → Security refuses",
  );
});

test("clearing an account with no passkeys is refused, not a silent no-op", async () => {
  await makeAdmin(USER_1);
  await assert.rejects(
    () => asUser(USER_1, () => resetUserPasskeys(USER_2)),
    /no passkeys/,
  );
});

test("a non-admin cannot clear anyone's passkeys", async () => {
  await seedPasskey(USER_1);
  await assert.rejects(() => asUser(USER_2, () => resetUserPasskeys(USER_1)));
});

/* ------------------------------------------------------------------ */
/* The DTO carries no credential                                       */
/* ------------------------------------------------------------------ */

test("the list never projects key material", async () => {
  await seedPasskey(USER_1);
  const rows = await asUser(USER_1, () => listMyPasskeys());
  assert.equal(rows.length, 1);
  assert.deepEqual(
    Object.keys(rows[0]!).sort(),
    ["createdAt", "id", "name", "usableHere"],
    "publicKey and credentialID must never leave the data layer",
  );
  assert.equal(rows[0]!.name, "Test device");
  assert.equal(await userHasPasskey(USER_1), true);
});
