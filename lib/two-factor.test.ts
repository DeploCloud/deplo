import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "./db/test-harness";
import { __setTestDb, __resetTestDb } from "./db/client";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane";
import { runWithIdentity } from "./auth/request-context";
import { requireAuth } from "./auth/better-auth";
import { login, verifyTwoFactorCode } from "./auth";
import {
  requireActiveTeamId,
  requireCapability,
  TwoFactorRequiredError,
  twoFactorMandateForCurrentUser,
} from "./membership";
import { authenticateToken, createToken } from "./data/tokens";
import { ensureTeamRoles } from "./data/roles";
import { seedIdentity, TEAM_A, USER_1 } from "./data/identity-test-helpers";
import { ALL_CAPABILITIES } from "./types";

/**
 * Any real capability, resolved from the canonical list rather than named.
 */
const SOME_CAPABILITY = ALL_CAPABILITIES.find((c) => c !== "view")!;

/** A second member of TEAM_A, seeded alongside USER_1 for the policy tests. */
const USER_2 = "user_2";

/**
 * Two-factor authentication end to end: enrolment through Better Auth's plugin,
 * the login challenge, and the team/role policy gate.
 */

let db: TestDb;
let pg: PGlite;

const PASSWORD = "password1";
const EMAIL_1 = `${USER_1}@example.io`;

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
    `truncate table api_tokens, two_factor, account, session, memberships, team_roles, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", password: PASSWORD },
      { id: USER_2, teamId: TEAM_A, role: "member", password: PASSWORD },
    ],
  });
});

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Drive the plugin's endpoints directly with an explicit cookie header.
 *
 * `login()` and friends read cookies through `next/headers`, which does not
 * exist under `node --test`; the endpoints themselves take headers as an
 * argument, so the enrolment flow is exercised for real without a request scope.
 */
async function signIn(email: string, password: string): Promise<string> {
  const res = await requireAuth().api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  assert.equal(res.status, 200, "sign-in should succeed");
  // getSetCookie(), not get(): a 2FA sign-in sets more than one cookie and
  // `get("set-cookie")` would flatten them into one unparseable string.
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** A code the authenticator would show right now for this enrolment. */
async function codeFor(totpURI: string): Promise<string> {
  const encoded = new URL(totpURI).searchParams.get("secret")!;
  const { base32 } = await import("@better-auth/utils/base32");
  const { createOTP } = await import("@better-auth/utils/otp");
  const secret = new TextDecoder().decode(base32.decode(encoded));
  return createOTP(secret, { digits: 6, period: 30 }).totp();
}

/**
 * `enableTwoFactor`, narrowed to the shape Deplo enrols.
 *
 * Since Better Auth 1.7.0 the endpoint answers a DISCRIMINATED union: an OTP
 * enrolment is `{ method: "otp" }` and carries no secret at all, because the
 * code is delivered rather than shown. Deplo enrols an authenticator app, so it
 * asks for TOTP by name (`lib/data/two-factor.ts` does the same) and this throws
 * on anything else - which is also what narrows the type for every reader below.
 */
async function enableTotp(
  headers: Headers,
): Promise<{ totpURI: string; backupCodes: string[] }> {
  const res = await requireAuth().api.enableTwoFactor({
    body: { password: PASSWORD, method: "totp" },
    headers,
  });
  if (res.method !== "totp")
    throw new Error(`expected a TOTP enrolment, got ${res.method}`);
  return res;
}

/** Enrol `USER_1` fully (enable + verify) and return their backup codes. */
async function enrolUser1(): Promise<{
  cookie: string;
  backupCodes: string[];
}> {
  const auth = requireAuth();
  const cookie = await signIn(EMAIL_1, PASSWORD);
  const headers = new Headers({ cookie });
  const enabled = await enableTotp(headers);
  await auth.api.verifyTOTP({
    body: { code: await codeFor(enabled.totpURI) },
    headers,
  });
  return { cookie, backupCodes: enabled.backupCodes };
}

/** Turn the team-wide mandate on. */
const requireForTeam = () =>
  db
    .update(teamsTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamsTable.id, TEAM_A));

/* ------------------------------------------------------------------ */
/* Enrolment                                                           */
/* ------------------------------------------------------------------ */

test("enable + verify turns 2FA on; the flag is not set until a code is proved", async () => {
  const auth = requireAuth();
  const cookie = await signIn(EMAIL_1, PASSWORD);
  const headers = new Headers({ cookie });

  const enabled = await enableTotp(headers);
  assert.match(enabled.totpURI, /^otpauth:\/\/totp\//);
  assert.equal(enabled.backupCodes.length, 10);

  // Enrolment alone must NOT flip the flag: an authenticator that was scanned
  // wrong would otherwise lock the account out at the next sign-in.
  const before = await db
    .select({ on: usersTable.twoFactorEnabled })
    .from(usersTable)
    .where(eq(usersTable.id, USER_1));
  assert.equal(before[0]!.on, false, "not enabled before a code is verified");

  await auth.api.verifyTOTP({
    body: { code: await codeFor(enabled.totpURI) },
    headers,
  });

  const after = await db
    .select({ on: usersTable.twoFactorEnabled })
    .from(usersTable)
    .where(eq(usersTable.id, USER_1));
  assert.equal(after[0]!.on, true, "enabled once a code is verified");
});

test("a wrong TOTP code is rejected", async () => {
  const auth = requireAuth();
  const cookie = await signIn(EMAIL_1, PASSWORD);
  const headers = new Headers({ cookie });
  await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });

  await assert.rejects(
    () => auth.api.verifyTOTP({ body: { code: "000000" }, headers }),
    /Invalid code/i,
  );
});

test("enrolment refuses a wrong password", async () => {
  const auth = requireAuth();
  const cookie = await signIn(EMAIL_1, PASSWORD);
  await assert.rejects(() =>
    auth.api.enableTwoFactor({
      body: { password: "not-the-password" },
      headers: new Headers({ cookie }),
    }),
  );
});

/* ------------------------------------------------------------------ */
/* The login challenge                                                 */
/* ------------------------------------------------------------------ */

test("with 2FA on, login stops at the challenge and mints no session", async () => {
  await enrolUser1();
  const sessionsBefore = (
    await pg.query<{ n: number }>(`select count(*)::int as n from session`)
  ).rows[0]!.n;

  const res = await login(EMAIL_1, PASSWORD);
  assert.equal(res.ok, false, "not signed in yet");
  assert.equal(res.requiresTwoFactor, true);
  assert.equal(res.error, undefined, "a challenge is not an error");

  const sessionsAfter = (
    await pg.query<{ n: number }>(`select count(*)::int as n from session`)
  ).rows[0]!.n;
  assert.equal(
    sessionsAfter,
    sessionsBefore,
    "the password alone must not create a session",
  );
});

test("a wrong password still reads as a wrong password, not as a challenge", async () => {
  await enrolUser1();
  const res = await login(EMAIL_1, "not-the-password");
  assert.equal(res.ok, false);
  assert.equal(res.requiresTwoFactor, undefined);
  assert.match(res.error ?? "", /Invalid email or password/);
});

test("a backup code works exactly once", async () => {
  const auth = requireAuth();
  const { backupCodes } = await enrolUser1();
  const code = backupCodes[0]!;

  // A backup code answers the LOGIN challenge, so it needs the short-lived
  // two-factor cookie that the password step hands back, not a session cookie.
  const challenge = async () =>
    new Headers({ cookie: await signIn(EMAIL_1, PASSWORD) });

  await auth.api.verifyBackupCode({
    body: { code },
    headers: await challenge(),
  });
  await assert.rejects(
    async () =>
      auth.api.verifyBackupCode({ body: { code }, headers: await challenge() }),
    "the same backup code must not work twice",
  );
});

test("verifyTwoFactorCode reports the plugin's own message on a bad code", async () => {
  await enrolUser1();
  const res = await verifyTwoFactorCode("000000", "totp");
  assert.equal(res.ok, false);
  assert.ok(
    (res.error ?? "").length > 0,
    "the reason is surfaced, not swallowed",
  );
});

/* ------------------------------------------------------------------ */
/* The team policy gate                                                */
/* ------------------------------------------------------------------ */

test("a team mandate blocks mutations, reads AND the bearer API", async () => {
  // Mint the token BEFORE the mandate exists: the point is that an already-issued
  // token stops working, not that minting one is blocked (it is, but that is just
  // requireCapability again).
  const raw = await asUser(
    USER_1,
    async () => (await createToken({ name: "CI" })).raw,
  );
  await requireForTeam();

  // Mutations.
  await asUser(USER_2, async () => {
    await assert.rejects(
      () => requireCapability(SOME_CAPABILITY),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "requireCapability must refuse",
    );
  });

  // Reads. This is the one a gate on membershipFor alone would miss: every
  // read in lib/data scopes itself here and never touches membershipFor.
  await asUser(USER_2, async () => {
    await assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "requireActiveTeamId must refuse",
    );
  });

  // The bearer API, whose principal is the token's creator.
  await assert.rejects(
    () => authenticateToken(raw),
    (e: unknown) => e instanceof TwoFactorRequiredError,
    "a bearer token must die with its principal's mandate",
  );
});

test("the same member passes every gate once enrolled", async () => {
  await requireForTeam();
  await enrolUser1();

  await asUser(USER_1, async () => {
    assert.equal(await requireActiveTeamId(), TEAM_A);
    const ctx = await requireCapability(SOME_CAPABILITY);
    assert.equal(ctx.userId, USER_1);
  });

  const raw = await asUser(
    USER_1,
    async () => (await createToken({ name: "CI" })).raw,
  );
  const principal = await authenticateToken(raw);
  assert.equal(principal?.userId, USER_1);
  assert.equal(principal?.teamId, TEAM_A);
  // The token's own grant rides along; what it holds is tokens.test.ts's business.
  assert.ok(principal?.token);
});

test("the mandate names the team, and only that team", async () => {
  await requireForTeam();
  await asUser(USER_2, async () => {
    const err = await requireCapability(SOME_CAPABILITY).catch((e) => e);
    assert.ok(err instanceof TwoFactorRequiredError);
    assert.equal(err.teamId, TEAM_A);
    assert.match(err.message, /two-factor/i);
  });
});

/* ------------------------------------------------------------------ */
/* The role policy gate                                                */
/* ------------------------------------------------------------------ */

test("a role mandate blocks only the members who hold that role", async () => {
  // Seed the team's built-in roles, then mandate 2FA on `member` alone.
  await ensureTeamRoles(db as never, TEAM_A);
  const roles = await db
    .select({ id: teamRolesTable.id, key: teamRolesTable.builtinKey })
    .from(teamRolesTable)
    .where(eq(teamRolesTable.teamId, TEAM_A));
  const memberRole = roles.find((r) => r.key === "member")!;
  const ownerRole = roles.find((r) => r.key === "owner")!;
  await db
    .update(teamRolesTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamRolesTable.id, memberRole.id));
  // Pin each member to a role explicitly (ensureTeamRoles only adopts exact
  // capability matches, which is not what this test is asserting).
  await db
    .update(membershipsTable)
    .set({ roleId: memberRole.id })
    .where(eq(membershipsTable.userId, USER_2));
  await db
    .update(membershipsTable)
    .set({ roleId: ownerRole.id })
    .where(eq(membershipsTable.userId, USER_1));

  // The holder of the mandated role is stopped.
  await asUser(USER_2, async () => {
    await assert.rejects(
      () => requireCapability(SOME_CAPABILITY),
      (e: unknown) => e instanceof TwoFactorRequiredError,
    );
  });

  // Everyone else carries on: a role mandate is not a team mandate.
  await asUser(USER_1, async () => {
    assert.equal(await requireActiveTeamId(), TEAM_A);
  });
});

test("twoFactorMandateForCurrentUser explains why 2FA cannot be turned off", async () => {
  await asUser(USER_2, async () => {
    assert.equal(await twoFactorMandateForCurrentUser(), null);
  });
  await requireForTeam();
  await asUser(USER_2, async () => {
    const reason = await twoFactorMandateForCurrentUser();
    assert.ok(reason, "a mandate is reported");
  });
});
