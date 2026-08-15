import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "./db/test-harness";
import { __setTestDb, __resetTestDb } from "./db/client";
import { passkey as passkeyTable } from "./db/schema/auth";
import {
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane";
import { runWithIdentity } from "./auth/request-context";
import { requireAuth } from "./auth/better-auth";
import { login } from "./auth";
import {
  requireActiveTeamId,
  requireCapability,
  TwoFactorRequiredError,
} from "./membership";
import { passkeyLoginRequired, userHasPasskey } from "./passkey-policy";
import {
  deletePasskey,
  listMyPasskeys,
  renamePasskey,
  startPasskeyRegistration,
} from "./data/passkeys";
import { resetUserPasskeys } from "./data/members";
import { seedIdentity, TEAM_A, USER_1 } from "./data/identity-test-helpers";
import { setStoredPublicBaseUrl } from "./public-url";
import { ALL_CAPABILITIES } from "./types";

/**
 * A passkey as a SECOND FACTOR - the three things about it that are true only by
 * construction, and would stop being true silently (ADR-0024).
 *
 * 1. `/api/auth/passkey/*` cannot be reached over the network. The plugin
 *    registers a permanent, password-replacing credential on a session alone,
 *    which is a notch below the bar `lib/data/passkeys.ts` holds.
 * 2. Holding a passkey satisfies a team's two-factor mandate - the whole reason
 *    a team can turn the policy on without making everyone install an app.
 * 3. Because of (2), the password ALONE must stop creating a session for such an
 *    account. Get this wrong and one factor clears a two-factor policy, which is
 *    worse than not having shipped the feature.
 *
 * The WebAuthn ceremony itself is not exercised: driving it needs a virtual
 * authenticator (Chrome DevTools Protocol) that this harness does not have, so
 * the credential is seeded as a row. That is deliberate - everything asserted
 * here is about what deplo does with a passkey, not about whether
 * `@simplewebauthn/server` verifies signatures.
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

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

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
  // Proves the matcher is scoped to /passkey/ rather than having quietly closed
  // the whole auth surface.
  const res = await requireAuth().handler(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "nope" }),
    }),
  );
  assert.notEqual(res.status, 403, "sign-in still reaches its own handler");
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
/* 3. The password alone stops being enough                            */
/* ------------------------------------------------------------------ */

test("under a mandate met by a passkey, the password mints no session", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  const before = await sessionCount();

  const res = await login(EMAIL_1, PASSWORD);
  assert.equal(res.ok, false, "not signed in yet");
  assert.equal(res.requiresPasskey, true);
  assert.equal(res.error, undefined, "a challenge is not an error");
  // The assertion that matters: one factor must not buy a session on an account
  // whose policy is being satisfied by the other one.
  assert.equal(
    await sessionCount(),
    before,
    "the password alone must not create a session",
  );
});

test("a wrong password still reads as a wrong password, not as a challenge", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);

  const res = await login(EMAIL_1, "not-the-password");
  assert.equal(res.ok, false);
  assert.equal(
    res.requiresPasskey,
    undefined,
    "the flag after a wrong password would be an enumeration oracle",
  );
  assert.match(res.error ?? "", /Invalid email or password/);
});

test("no mandate, or a TOTP already enrolled, leaves the password path alone", async () => {
  await seedPasskey(USER_1);
  assert.equal(
    await passkeyLoginRequired(USER_1),
    false,
    "a passkey is a convenience until a policy is resting on it",
  );

  await requireForTeam();
  assert.equal(await passkeyLoginRequired(USER_1), true);

  await enableTotp();
  assert.equal(
    await passkeyLoginRequired(USER_1),
    false,
    "with an authenticator app the ordinary two-factor challenge applies",
  );
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
 * The lockout this section exists to stop: a passkey satisfies the mandate, so
 * `login()` refuses the password - and if the credential cannot be used on this
 * panel any more, the ceremony that was supposed to finish the sign-in cannot
 * happen either. The way out is that an unusable passkey stops counting, which
 * puts the account back on the ordinary "add a second factor" path.
 */

test("a passkey minted for another address counts for nothing", async () => {
  await requireForTeam();
  await seedPasskey(USER_1, "pk-old", "Old address", "old.example.com");

  assert.equal(await userHasPasskey(USER_1), false);
  assert.equal(
    await passkeyLoginRequired(USER_1),
    false,
    "refusing the password here would be a lockout: the browser has nothing to offer",
  );
  await asUser(USER_1, async () => {
    await assert.rejects(
      () => requireActiveTeamId(),
      (e: unknown) => e instanceof TwoFactorRequiredError,
      "the mandate is unmet, which is recoverable - unlike a refused sign-in",
    );
  });
});

test("a row from before rp_id existed counts for nothing either", async () => {
  await requireForTeam();
  await seedPasskey(USER_1, "pk-legacy", "Legacy", null);
  assert.equal(await userHasPasskey(USER_1), false);
  assert.equal(await passkeyLoginRequired(USER_1), false);
});

test("turning the panel's https off makes every passkey stop counting", async () => {
  await requireForTeam();
  await seedPasskey(USER_1);
  assert.equal(await passkeyLoginRequired(USER_1), true, "fixture");

  // What `setPanelHttps(false)` does to the rest of the process.
  setStoredPublicBaseUrl("http://deplo.example.com");
  try {
    assert.equal(await userHasPasskey(USER_1), false);
    assert.equal(
      await passkeyLoginRequired(USER_1),
      false,
      "no relying party means no ceremony, so the password must still work",
    );
    const res = await login(EMAIL_1, PASSWORD);
    assert.notEqual(res.requiresPasskey, true);
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
    assert.equal(rows.length, 2, "a dead credential must not vanish from the list");
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
  // names are the plugin's field list verbatim. Nothing else here exercises them
  // - the ceremony cannot run headless - and the first sign of a mismatch would
  // otherwise be a real registration failing in a browser.
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
  assert.equal(found?.userId, USER_1, "the authentication path resolves by credentialID");

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
