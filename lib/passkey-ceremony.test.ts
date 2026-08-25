import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "./db/test-harness";
import { __setTestDb, __resetTestDb } from "./db/client";
import { passkey as passkeyTable } from "./db/schema/auth";
import { requireAuth } from "./auth/better-auth";
import { setStoredPublicBaseUrl } from "./public-url";
import { seedIdentity, TEAM_A, USER_1 } from "./data/identity-test-helpers";
import { FLAG, makeAuthenticator } from "./webauthn-test-helpers";
import { userHasPasskey } from "./passkey-policy";

/**
 * The ceremony, end to end, against a software authenticator that produces real
 * signatures over the server's real challenges.
 */

let db: TestDb;
let pg: PGlite;

const PASSWORD = "password1";
const EMAIL_1 = `${USER_1}@example.io`;
const PANEL = "https://deplo.example.com";
const ORIGIN = "https://deplo.example.com";
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
    `truncate table passkey, two_factor, account, session, verification, memberships, team_roles, users, teams, instance_settings, rate_limits restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner", password: PASSWORD }],
  });
});

/** Cookies from a response, flattened into a request `Cookie` header. */
const jar = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Sign in with the password and keep the session cookie. */
async function signIn(): Promise<string> {
  const res = await requireAuth().api.signInEmail({
    body: { email: EMAIL_1, password: PASSWORD },
    asResponse: true,
  });
  assert.equal(res.status, 200, "fixture: the password sign-in should work");
  return jar(res);
}

async function registrationOptions(cookie: string) {
  const res = await requireAuth().api.generatePasskeyRegistrationOptions({
    query: {},
    headers: new Headers({ cookie }),
    asResponse: true,
  });
  assert.equal(res.status, 200, await res.clone().text());
  const options = (await res.json()) as {
    challenge: string;
    rp: { id: string };
  };
  // Both cookies travel on: the session says who, the challenge says which.
  return { options, cookie: `${cookie}; ${jar(res)}` };
}

async function authenticationOptions(cookie?: string) {
  const res = await requireAuth().api.generatePasskeyAuthenticationOptions({
    headers: new Headers(cookie ? { cookie } : {}),
    asResponse: true,
  });
  assert.equal(res.status, 200, await res.clone().text());
  const options = (await res.json()) as {
    challenge: string;
    rpId: string;
    allowCredentials?: unknown[];
  };
  return { options, cookie: jar(res) };
}

/** Register a fresh credential and return the authenticator holding it. */
async function enrol(name = "Test device") {
  const sessionCookie = await signIn();
  const auth = makeAuthenticator();
  const { options, cookie } = await registrationOptions(sessionCookie);
  const attestation = auth.register({
    challenge: options.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  });
  const row = await requireAuth().api.verifyPasskeyRegistration({
    body: { response: attestation, name },
    headers: new Headers({ cookie }),
  });
  return { auth, sessionCookie, row: row as { id: string; userId: string } };
}

/* ------------------------------------------------------------------ */
/* 1. Registration                                                     */
/* ------------------------------------------------------------------ */

test("a real credential registers, and lands on the right account", async () => {
  const { auth, row } = await enrol("Laptop");

  assert.equal(row.userId, USER_1);
  const [stored] = await db
    .select({
      name: passkeyTable.name,
      credentialID: passkeyTable.credentialID,
      counter: passkeyTable.counter,
      deviceType: passkeyTable.deviceType,
      backedUp: passkeyTable.backedUp,
      transports: passkeyTable.transports,
    })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, USER_1));
  assert.equal(stored?.name, "Laptop");
  assert.equal(
    stored?.credentialID,
    auth.credentialId.toString("base64url"),
    "the row is keyed by the credential the authenticator actually made",
  );
  assert.equal(stored?.counter, 0);
  assert.equal(stored?.transports, "internal");
});

test("the options name THIS panel, and nothing else", async () => {
  const cookie = await signIn();
  const { options } = await registrationOptions(cookie);
  assert.equal(
    options.rp.id,
    RP_ID,
    "rpID comes from the panel address, so a credential is welded to it",
  );
});

/**
 * The guard deplo adds on top of the plugin, which hardcodes
 * `requireUserVerification: false`. Without it a key that never asked for a PIN
 * would satisfy a team's two-factor mandate as a single factor.
 */
test("a ceremony with no user verification is refused at registration", async () => {
  const sessionCookie = await signIn();
  const auth = makeAuthenticator();
  const { options, cookie } = await registrationOptions(sessionCookie);
  const attestation = auth.register({
    challenge: options.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
    // Present, but not verified: touched, not identified.
    flags: FLAG.up | FLAG.at,
  });
  await assert.rejects(
    () =>
      requireAuth().api.verifyPasskeyRegistration({
        body: { response: attestation, name: "No PIN" },
        headers: new Headers({ cookie }),
      }),
    /did not verify it was you/,
  );
  assert.equal(
    (await db.select({ id: passkeyTable.id }).from(passkeyTable)).length,
    0,
    "and nothing was written",
  );
});

test("an attestation for another origin is refused", async () => {
  const sessionCookie = await signIn();
  const auth = makeAuthenticator();
  const { options, cookie } = await registrationOptions(sessionCookie);
  const attestation = auth.register({
    challenge: options.challenge,
    origin: "https://evil.example.com",
    rpId: RP_ID,
  });
  await assert.rejects(() =>
    requireAuth().api.verifyPasskeyRegistration({
      body: { response: attestation, name: "Elsewhere" },
      headers: new Headers({ cookie }),
    }),
  );
});

test("an attestation for another rpID is refused", async () => {
  const sessionCookie = await signIn();
  const auth = makeAuthenticator();
  const { options, cookie } = await registrationOptions(sessionCookie);
  const attestation = auth.register({
    challenge: options.challenge,
    origin: ORIGIN,
    rpId: "other.example.com",
  });
  await assert.rejects(() =>
    requireAuth().api.verifyPasskeyRegistration({
      body: { response: attestation, name: "Wrong RP" },
      headers: new Headers({ cookie }),
    }),
  );
});

test("a challenge the server never issued is refused", async () => {
  const sessionCookie = await signIn();
  const auth = makeAuthenticator();
  const { cookie } = await registrationOptions(sessionCookie);
  const attestation = auth.register({
    challenge: Buffer.from("i-made-this-up").toString("base64url"),
    origin: ORIGIN,
    rpId: RP_ID,
  });
  await assert.rejects(() =>
    requireAuth().api.verifyPasskeyRegistration({
      body: { response: attestation, name: "Forged" },
      headers: new Headers({ cookie }),
    }),
  );
});

test("a challenge is single-use", async () => {
  const sessionCookie = await signIn();
  const authA = makeAuthenticator();
  const authB = makeAuthenticator();
  const { options, cookie } = await registrationOptions(sessionCookie);

  await requireAuth().api.verifyPasskeyRegistration({
    body: {
      response: authA.register({
        challenge: options.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
      }),
      name: "First",
    },
    headers: new Headers({ cookie }),
  });
  // Same cookie, same challenge, a different credential: the row backing it was
  // consumed, so there is nothing left to answer.
  await assert.rejects(
    () =>
      requireAuth().api.verifyPasskeyRegistration({
        body: {
          response: authB.register({
            challenge: options.challenge,
            origin: ORIGIN,
            rpId: RP_ID,
          }),
          name: "Second",
        },
        headers: new Headers({ cookie }),
      }),
    /Challenge not found/,
  );
});

test("a registration challenge cannot be spent on a sign-in", async () => {
  const sessionCookie = await signIn();
  const auth = makeAuthenticator();
  const { options, cookie } = await registrationOptions(sessionCookie);
  const assertion = auth.authenticate({
    challenge: options.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  });
  await assert.rejects(
    () =>
      requireAuth().api.verifyPasskeyAuthentication({
        body: { response: assertion },
        headers: new Headers({ cookie }),
      }),
    /Challenge not found/,
    "the two ceremonies are typed apart on purpose",
  );
});

/* ------------------------------------------------------------------ */
/* 2. Signing in                                                       */
/* ------------------------------------------------------------------ */

test("a registered credential signs in, with no password anywhere", async () => {
  const { auth } = await enrol();
  await pg.exec(`delete from session;`);

  const { options, cookie } = await authenticationOptions();
  assert.equal(
    options.allowCredentials,
    undefined,
    "no session, no list: the browser picks a discoverable credential",
  );
  const assertion = auth.authenticate({
    challenge: options.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  });
  const res = await requireAuth().api.verifyPasskeyAuthentication({
    body: { response: assertion },
    headers: new Headers({ cookie }),
    asResponse: true,
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { user: { id: string } };
  assert.equal(body.user.id, USER_1);
  const sessions = await pg.query<{ n: number }>(
    `select count(*)::int as n from session`,
  );
  assert.equal(sessions.rows[0]?.n, 1, "a session was minted for that account");
});

test("the replay counter is written back after every assertion", async () => {
  const { auth } = await enrol();
  const counterNow = async () =>
    (
      await db
        .select({ counter: passkeyTable.counter })
        .from(passkeyTable)
        .where(eq(passkeyTable.userId, USER_1))
    )[0]?.counter;
  assert.equal(await counterNow(), 0);

  for (const expected of [1, 2]) {
    const { options, cookie } = await authenticationOptions();
    await requireAuth().api.verifyPasskeyAuthentication({
      body: {
        response: auth.authenticate({
          challenge: options.challenge,
          origin: ORIGIN,
          rpId: RP_ID,
        }),
      },
      headers: new Headers({ cookie }),
    });
    assert.equal(
      await counterNow(),
      expected,
      "a stored counter that never moves cannot detect a cloned authenticator",
    );
  }
});

test("an authenticator whose counter went backwards is refused", async () => {
  // What a CLONED authenticator looks like from the server's side: a valid signature
  // over a fresh challenge, from a credential whose counter has already been seen.
  const { auth } = await enrol();
  const useOnce = async () => {
    const { options, cookie } = await authenticationOptions();
    return requireAuth().api.verifyPasskeyAuthentication({
      body: {
        response: auth.authenticate({
          challenge: options.challenge,
          origin: ORIGIN,
          rpId: RP_ID,
        }),
      },
      headers: new Headers({ cookie }),
    });
  };
  await useOnce();
  auth.counter = 0; // the clone, still at the count it was copied at
  await assert.rejects(useOnce());
});

test("a sign-in with no user verification is refused", async () => {
  const { auth } = await enrol();
  const { options, cookie } = await authenticationOptions();
  await assert.rejects(
    () =>
      requireAuth().api.verifyPasskeyAuthentication({
        body: {
          response: auth.authenticate({
            challenge: options.challenge,
            origin: ORIGIN,
            rpId: RP_ID,
            flags: FLAG.up,
          }),
        },
        headers: new Headers({ cookie }),
      }),
    /did not verify it was you/,
    "the guard has to hold on the sign-in path too, not just registration",
  );
});

test("a replayed assertion is refused", async () => {
  const { auth } = await enrol();
  const { options, cookie } = await authenticationOptions();
  const assertion = auth.authenticate({
    challenge: options.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  });
  await requireAuth().api.verifyPasskeyAuthentication({
    body: { response: assertion },
    headers: new Headers({ cookie }),
  });
  await assert.rejects(
    () =>
      requireAuth().api.verifyPasskeyAuthentication({
        body: { response: assertion },
        headers: new Headers({ cookie }),
      }),
    /Challenge not found/,
    "the same signature must not open a second session",
  );
});

test("a signature from a credential nobody registered is refused", async () => {
  await enrol();
  const stranger = makeAuthenticator();
  const { options, cookie } = await authenticationOptions();
  await assert.rejects(
    () =>
      requireAuth().api.verifyPasskeyAuthentication({
        body: {
          response: stranger.authenticate({
            challenge: options.challenge,
            origin: ORIGIN,
            rpId: RP_ID,
          }),
        },
        headers: new Headers({ cookie }),
      }),
    /Passkey not found/,
  );
});

test("a valid assertion for the wrong origin is refused", async () => {
  const { auth } = await enrol();
  const { options, cookie } = await authenticationOptions();
  await assert.rejects(() =>
    requireAuth().api.verifyPasskeyAuthentication({
      body: {
        response: auth.authenticate({
          challenge: options.challenge,
          origin: "https://evil.example.com",
          rpId: RP_ID,
        }),
      },
      headers: new Headers({ cookie }),
    }),
  );
});

test("a tampered signature is refused", async () => {
  const { auth } = await enrol();
  const { options, cookie } = await authenticationOptions();
  const assertion = auth.authenticate({
    challenge: options.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  });
  const bytes = Buffer.from(assertion.response.signature, "base64url");
  bytes[bytes.length - 1] ^= 0xff;
  assertion.response.signature = bytes.toString("base64url");
  await assert.rejects(() =>
    requireAuth().api.verifyPasskeyAuthentication({
      body: { response: assertion },
      headers: new Headers({ cookie }),
    }),
  );
});

/* ------------------------------------------------------------------ */
/* 3. Registering a second one                                         */
/* ------------------------------------------------------------------ */

test("the same authenticator is not offered a second registration", async () => {
  const { auth, sessionCookie } = await enrol();
  const { options } = await registrationOptions(sessionCookie);
  const excluded = (
    options as unknown as { excludeCredentials: { id: string }[] }
  ).excludeCredentials;
  assert.deepEqual(
    excluded.map((c) => c.id),
    [auth.credentialId.toString("base64url")],
    "excludeCredentials is what stops one device holding two keys for one account",
  );
});

test("a second device registers alongside the first", async () => {
  await enrol("First");
  await enrol("Second");
  const rows = await db
    .select({ name: passkeyTable.name })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, USER_1));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.name).sort(), ["First", "Second"]);
});

/* ------------------------------------------------------------------ */
/* 4. What the plugin alone does NOT do                                */
/* ------------------------------------------------------------------ */

test("a row the plugin writes on its own is not usable until deplo stamps it", async () => {
  // `enrol()` drives the endpoints directly, which is everything the plugin knows how
  // to do - and it does not know about rpIDs.
  await enrol();
  const [row] = await db
    .select({ rpId: passkeyTable.rpId })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, USER_1));
  assert.equal(row?.rpId, null, "the plugin leaves it to deplo");
  assert.equal(
    await userHasPasskey(USER_1),
    false,
    "and until deplo fills it in, the credential counts for nothing",
  );
});
