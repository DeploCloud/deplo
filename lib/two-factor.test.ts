import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "./db/test-harness";
import { __setTestDb, __resetTestDb } from "./db/client";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
} from "./db/schema/control-plane/access-control";
import {
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane/identity";
import { runWithIdentity } from "./auth/request-context";
import { requireAuth } from "./auth/better-auth";
import { login, verifyTwoFactorCode } from "./auth/sign-in";
import {
  requireActiveTeamId,
  requireCapability,
  TwoFactorRequiredError,
  twoFactorMandateForCurrentUser,
} from "./membership";
import { buildContext } from "./graphql/context";
import { authenticateToken } from "./data/tokens/authenticate";
import { createToken } from "./data/tokens/mint";
import { ensureTeamRoles } from "./data/roles/builtin-roles";
import { seedIdentity, TEAM_A, USER_1 } from "./data/identity-test-helpers";
import { ALL_CAPABILITIES } from "./types/identity";

const SOME_CAPABILITY = ALL_CAPABILITIES.find((c) => c !== "view")!;

const USER_2 = "user_2";

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

async function signIn(email: string, password: string): Promise<string> {
  const res = await requireAuth().api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  assert.equal(res.status, 200, "sign-in should succeed");
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function codeFor(totpURI: string): Promise<string> {
  const encoded = new URL(totpURI).searchParams.get("secret")!;
  const { base32 } = await import("@better-auth/utils/base32");
  const { createOTP } = await import("@better-auth/utils/otp");
  const secret = new TextDecoder().decode(base32.decode(encoded));
  return createOTP(secret, { digits: 6, period: 30 }).totp();
}

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

const requireForTeam = () =>
  db
    .update(teamsTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamsTable.id, TEAM_A));

test("enable + verify turns 2FA on; the flag is not set until a code is proved", async () => {
  const auth = requireAuth();
  const cookie = await signIn(EMAIL_1, PASSWORD);
  const headers = new Headers({ cookie });

  const enabled = await enableTotp(headers);
  assert.match(enabled.totpURI, /^otpauth:\/\/totp\//);
  assert.equal(enabled.backupCodes.length, 10);

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

test("a team mandate blocks mutations, reads AND the bearer API", async () => {
  const raw = await asUser(
    USER_1,
    async () => (await createToken({ name: "CI" })).raw,
  );
  await requireForTeam();

  await asUser(USER_2, async () => {
    await assert.rejects(
      () => requireCapability(SOME_CAPABILITY),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "requireCapability must refuse",
    );
  });

  await asUser(USER_2, async () => {
    await assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "requireActiveTeamId must refuse",
    );
  });

  await assert.rejects(
    () => authenticateToken(raw),
    (e: unknown) => e instanceof TwoFactorRequiredError,
    "a bearer token must die with its principal's mandate",
  );
});

test("the mandate never blocks the way out", async () => {
  await requireForTeam();
  await asUser(USER_2, async () => {
    await assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "the gate itself stays shut",
    );
    const ctx = await buildContext(new Request("http://localhost/api/graphql"));
    assert.equal(ctx.viewer?.id, USER_2);
    assert.equal(ctx.teamId, null, "the team stays unresolved");
    assert.deepEqual(ctx.capabilities, [], "and grants nothing");
  });
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

test("a role mandate blocks only the members who hold that role", async () => {
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
  await db
    .update(membershipsTable)
    .set({ roleId: memberRole.id })
    .where(eq(membershipsTable.userId, USER_2));
  await db
    .update(membershipsTable)
    .set({ roleId: ownerRole.id })
    .where(eq(membershipsTable.userId, USER_1));

  await asUser(USER_2, async () => {
    await assert.rejects(
      () => requireCapability(SOME_CAPABILITY),
      (e: unknown) => e instanceof TwoFactorRequiredError,
    );
  });

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
