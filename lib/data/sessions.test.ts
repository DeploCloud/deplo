// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { session as sessionTable } from "../db/schema/auth";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { requireAuth } from "../auth/better-auth";
import { authRequestHeaders } from "../auth/request-headers";
import { listMySessions, revokeOtherSessions, revokeSession } from "./sessions";

/**
 * The signed-in-devices list, and the two ways it could leak. And every revoke is
 * addressed by an id supplied by the client, so a missing `userId` in the WHERE
 * clause would let anyone sign anyone else out.
 */

let db: TestDb;
let pg: PGlite;

const USER_2 = "user_2";

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
    `truncate table session, account, memberships, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_A, role: "member" },
    ],
  });
});

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

const HOUR = 60 * 60 * 1000;

async function seedSession(opts: {
  id: string;
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
  expiresInMs?: number;
  seenAgoMs?: number;
}) {
  const now = Date.now();
  await db.insert(sessionTable).values({
    id: opts.id,
    userId: opts.userId,
    // Unique per row: the column is UNIQUE, and this value must never surface.
    token: `tok-${opts.id}`,
    userAgent: opts.userAgent ?? null,
    ipAddress: opts.ip ?? null,
    createdAt: new Date(now - 48 * HOUR),
    updatedAt: new Date(now - (opts.seenAgoMs ?? HOUR)),
    expiresAt: new Date(now + (opts.expiresInMs ?? 24 * HOUR)),
  });
}

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

test("the DTO never carries the session token", async () => {
  await seedSession({ id: "s1", userId: USER_1, userAgent: CHROME_MAC });
  const [row] = await asUser(USER_1, listMySessions);
  assert.ok(row);
  // Both directions: the field is absent, and the secret is nowhere in the
  // serialized shape either (a nested or renamed copy would still leak).
  assert.equal("token" in row, false, "no `token` field");
  assert.doesNotMatch(
    JSON.stringify(row),
    /tok-s1/,
    "the token value appears nowhere in the DTO",
  );
});

test("only the caller's own sessions are listed", async () => {
  await seedSession({ id: "mine", userId: USER_1 });
  await seedSession({ id: "theirs", userId: USER_2 });
  const rows = await asUser(USER_1, listMySessions);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["mine"],
    "another user's session is not visible",
  );
});

test("expired sessions are left out - a revoke button for them would be theatre", async () => {
  await seedSession({ id: "live", userId: USER_1 });
  await seedSession({ id: "dead", userId: USER_1, expiresInMs: -HOUR });
  const rows = await asUser(USER_1, listMySessions);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["live"],
  );
});

test("rows are most recently seen first, and describe the device", async () => {
  await seedSession({ id: "old", userId: USER_1, seenAgoMs: 10 * HOUR });
  await seedSession({
    id: "recent",
    userId: USER_1,
    userAgent: CHROME_MAC,
    ip: "203.0.113.7",
    seenAgoMs: HOUR,
  });
  const rows = await asUser(USER_1, listMySessions);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["recent", "old"],
  );
  assert.equal(rows[0]!.label, "Chrome on macOS");
  assert.equal(rows[0]!.device, "desktop");
  assert.equal(rows[0]!.ipAddress, "203.0.113.7");
  // A session with no user agent still renders as a row rather than blowing up.
  assert.equal(rows[1]!.label, "Unknown device");
  assert.equal(rows[1]!.ipAddress, null);
});

test("a bearer request has no `current` session to mark", async () => {
  // `runWithIdentity` IS the bearer path: no cookie, so nothing is "this device".
  await seedSession({ id: "s1", userId: USER_1 });
  const rows = await asUser(USER_1, listMySessions);
  assert.equal(rows[0]!.current, false);
});

/* ------------------------------------------------------------------ */
/* Revoking                                                            */
/* ------------------------------------------------------------------ */

test("revoking one session deletes exactly that row", async () => {
  await seedSession({ id: "keep", userId: USER_1 });
  await seedSession({ id: "kill", userId: USER_1 });
  await asUser(USER_1, () => revokeSession("kill"));
  const left = await db
    .select({ id: sessionTable.id })
    .from(sessionTable)
    .where(eq(sessionTable.userId, USER_1));
  assert.deepEqual(
    left.map((r) => r.id),
    ["keep"],
  );
});

test("another user's session id cannot be revoked, and reveals nothing", async () => {
  await seedSession({ id: "theirs", userId: USER_2 });
  await assert.rejects(
    () => asUser(USER_1, () => revokeSession("theirs")),
    // The SAME message a nonexistent id gets: the caller learns nothing about
    // whether that id exists on someone else's account.
    /no longer signed in/,
  );
  const survived = await db
    .select({ id: sessionTable.id })
    .from(sessionTable)
    .where(eq(sessionTable.userId, USER_2));
  assert.equal(survived.length, 1, "the other user is still signed in");
});

test("an unknown session id is refused the same way", async () => {
  await assert.rejects(
    () => asUser(USER_1, () => revokeSession("does-not-exist")),
    /no longer signed in/,
  );
});

test("revokeOtherSessions never touches another account", async () => {
  await seedSession({ id: "mine-1", userId: USER_1 });
  await seedSession({ id: "mine-2", userId: USER_1 });
  await seedSession({ id: "theirs", userId: USER_2 });

  const ended = await asUser(USER_1, revokeOtherSessions);
  assert.equal(ended, 2, "both of the caller's sessions ended");

  const others = await db
    .select({ id: sessionTable.id })
    .from(sessionTable)
    .where(eq(sessionTable.userId, USER_2));
  assert.deepEqual(
    others.map((r) => r.id),
    ["theirs"],
  );
});

test("revokeOtherSessions on an account with none is a no-op returning 0", async () => {
  assert.equal(await asUser(USER_1, revokeOtherSessions), 0);
});

/* ------------------------------------------------------------------ */
/* Session metadata capture                                            */
/* ------------------------------------------------------------------ */

async function signInWith(headers: Headers) {
  const res = await requireAuth().api.signInEmail({
    body: { email: `${USER_1}@example.io`, password: "password1" },
    headers,
    asResponse: true,
  });
  assert.equal(res.status, 200, "sign-in should succeed");
  const [row] = await asUser(USER_1, listMySessions);
  assert.ok(row, "the sign-in created a session");
  return row;
}

test("a real sign-in stamps the device onto the session row", async () => {
  // The regression this guards: `login()` used to hand Better Auth a Headers object
  // containing ONLY the cookie, so `createSession` stamped userAgent "" and ipAddress
  // "" on every row.
  const row = await signInWith(
    authRequestHeaders(
      new Headers({
        "user-agent": CHROME_MAC,
        "x-forwarded-for": "203.0.113.9",
        // Would break sign-in on any host that is not DEPLO_PUBLIC_URL if it
        // were forwarded; asserted here so both concerns stay tested together.
        origin: "https://somewhere-else.example",
      }),
      "",
    ),
  );
  assert.equal(
    row.label,
    "Chrome on macOS",
    "the device is named, not Unknown",
  );
  assert.equal(row.device, "desktop");
  assert.equal(row.ipAddress, "203.0.113.9");
});

test("the client address survives a Cloudflare-in-front-of-Traefik chain", async () => {
  // deplo's real shape. `cf-connecting-ip` is single-valued and is why the address
  // still resolves; it is listed first for that reason.
  const row = await signInWith(
    authRequestHeaders(
      new Headers({
        "user-agent": CHROME_MAC,
        "cf-connecting-ip": "198.51.100.4",
        "x-forwarded-for": "198.51.100.4, 172.68.0.9",
      }),
      "",
    ),
  );
  assert.equal(row.ipAddress, "198.51.100.4", "the client, not the edge");
});

test("a multi-hop chain with no single-valued header degrades to no address", async () => {
  // Documented limitation rather than a bug to chase: Better Auth will not guess
  // which hop of an untrusted chain is the client. The row is still useful - it
  // names the device - it just cannot name the network.
  const row = await signInWith(
    authRequestHeaders(
      new Headers({
        "user-agent": CHROME_MAC,
        "x-forwarded-for": "198.51.100.4, 172.68.0.9",
      }),
      "",
    ),
  );
  assert.equal(row.label, "Chrome on macOS");
  assert.equal(row.ipAddress, null);
});
