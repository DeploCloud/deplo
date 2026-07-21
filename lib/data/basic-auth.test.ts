import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { appBasicAuthUsers } from "../db/schema/control-plane";
import {
  addBasicAuthUser,
  listBasicAuthUsers,
  updateBasicAuthUserPassword,
  removeBasicAuthUser,
  revealBasicAuthPassword,
  basicAuthUsersValue,
  appHasBasicAuth,
} from "./basic-auth";

/**
 * HTTP Basic Auth credentials — the rows the deploy/reroute renderers turn into a
 * Traefik `basicauth` middleware in front of every one of an app's domains.
 *
 * Four contracts are locked here, because the feature is only as good as they are:
 *
 *  - **Every mutation hands back the owning app.** The API edge re-applies the
 *    app's routing right after each write (that is what makes a credential live
 *    seconds after it is saved instead of at the next deploy), and it takes the
 *    app id from these return values. Drop `appId` from the DTO and the reroute
 *    silently targets `undefined` — the labels never change and the app stays
 *    open while the UI lists a credential.
 *  - **The rendered value fails CLOSED.** `basicAuthUsersValue` is what the
 *    renderers embed; a credential it cannot decrypt must abort the render, never
 *    quietly hash the empty string into a middleware that accepts a blank
 *    password.
 *  - **The password reveal is the ONLY way back to a plaintext, and it is gated.**
 *    The Access page shows a credential's password on demand (a basic-auth login
 *    is handed to a person). It must stay out of every list DTO, refuse another
 *    team, and — like the render — fail loudly rather than hand back the empty
 *    string a failed decrypt produces.
 *  - **Authorship is recorded and never fabricated.** The page answers "who set
 *    this login up, and who last rotated it": add stamps both columns, a password
 *    change moves `updatedBy` only, and nothing back-fills a name onto a row that
 *    predates the tracking.
 *
 * `DEPLO_SECRET` is read lazily by lib/crypto, so setting it after the (hoisted)
 * imports is fine.
 */

process.env.DEPLO_SECRET = "test-secret-for-basic-auth-aaaaaaaaaaaaaaaa";

let db: TestDb;
let pg: PGlite;

const OWNER_A = "u_owner_a";
const OWNER_B = "u_owner_b";
/** A second manage_domains holder in TEAM_A — "who added it" and "who changed it
 *  last" can only be told apart when two different people did them. */
const MATE_A = "u_mate_a";
/** A TEAM_A member with `view` only: the Access page is hidden from them, and the
 *  password reveal has to refuse them even on a direct call. */
const VIEWER_A = "u_viewer_a";
const APP_A = "app_a";
const APP_B = "app_b";

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId }, fn);

/** `user:$apr1$<8-char salt>$<22-char digest>` — the htpasswd line Traefik parses. */
const HTPASSWD_LINE = /^[^\s:,]+:\$apr1\$[./0-9A-Za-z]{8}\$[./0-9A-Za-z]{22}$/;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table activities, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: OWNER_A, teamId: TEAM_A, role: "owner" },
      { id: MATE_A, teamId: TEAM_A, role: "owner" },
      { id: VIEWER_A, teamId: TEAM_A, role: "viewer" },
      { id: OWNER_B, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP_A, slug: "alpha-app", teamId: TEAM_A });
  await seedApp(db, { id: APP_B, slug: "beta-app", teamId: TEAM_B });
});

test("every mutation returns the owning app, so the edge can re-apply routing", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    const added = await addBasicAuthUser(APP_A, "alice", "hunter2");
    assert.equal(added.appId, APP_A, "add must name the app to reroute");

    const updated = await updateBasicAuthUserPassword(added.id, "hunter3");
    assert.equal(
      updated.appId,
      APP_A,
      "the update edge only knows the credential id — the app must come back with it",
    );

    const appId = await removeBasicAuthUser(added.id);
    assert.equal(appId, APP_A, "remove must name the app to reroute");
  });
});

test("the rendered value is one htpasswd line per user, alphabetical, comma-joined", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    assert.equal(await basicAuthUsersValue(APP_A), "", "no users ⇒ no middleware");
    assert.equal(await appHasBasicAuth(APP_A), false);

    await addBasicAuthUser(APP_A, "zoe", "pw-zoe");
    await addBasicAuthUser(APP_A, "alice", "pw-alice");

    const value = await basicAuthUsersValue(APP_A);
    const lines = value.split(",");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("alice:"), `alphabetical, got ${value}`);
    assert.ok(lines[1].startsWith("zoe:"));
    for (const line of lines) assert.match(line, HTPASSWD_LINE);
    assert.equal(await appHasBasicAuth(APP_A), true);
  });
});

test("only this app's credentials are rendered — never another app's", async () => {
  await as(OWNER_A, TEAM_A, () => addBasicAuthUser(APP_A, "alice", "pw"));
  await as(OWNER_B, TEAM_B, () => addBasicAuthUser(APP_B, "bob", "pw"));

  const a = await as(OWNER_A, TEAM_A, () => basicAuthUsersValue(APP_A));
  const b = await as(OWNER_B, TEAM_B, () => basicAuthUsersValue(APP_B));
  assert.ok(a.startsWith("alice:") && !a.includes("bob"));
  assert.ok(b.startsWith("bob:") && !b.includes("alice"));
});

test("a password that cannot be decrypted fails the render (never fails open)", async () => {
  const id = await as(OWNER_A, TEAM_A, async () => {
    const u = await addBasicAuthUser(APP_A, "alice", "hunter2");
    return u.id;
  });
  // Simulate a rotated DEPLO_SECRET / restored dump: the ciphertext no longer
  // decrypts. decryptSecret fails closed to "", which would otherwise hash into a
  // perfectly valid apr1 hash OF THE EMPTY STRING — a middleware that lets anyone
  // in with a blank password. The render must abort instead.
  await db
    .update(appBasicAuthUsers)
    .set({ passwordEnc: "not-a-valid-ciphertext" })
    .where(eq(appBasicAuthUsers.id, id));

  await assert.rejects(
    () => as(OWNER_A, TEAM_A, () => basicAuthUsersValue(APP_A)),
    /could not be decrypted/i,
  );
});

test("changing a password replaces the rendered credential", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    const u = await addBasicAuthUser(APP_A, "alice", "hunter2");
    const before = await basicAuthUsersValue(APP_A);
    await updateBasicAuthUserPassword(u.id, "hunter3");
    const after = await basicAuthUsersValue(APP_A);
    assert.notEqual(before, after, "the htpasswd hash must change with the password");
    assert.match(after, HTPASSWD_LINE);
  });
});

test("removing the last user renders nothing — the login prompt disappears", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    const u = await addBasicAuthUser(APP_A, "alice", "hunter2");
    await removeBasicAuthUser(u.id);
    assert.equal(await basicAuthUsersValue(APP_A), "");
    assert.equal(await appHasBasicAuth(APP_A), false);
  });
});

test("usernames that would corrupt the label or the users= list are rejected", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    for (const bad of ["ali ce", "ali:ce", "ali,ce", 'ali"ce', "ali`ce", ""]) {
      await assert.rejects(
        () => addBasicAuthUser(APP_A, bad, "pw"),
        /username/i,
        `"${bad}" must be rejected`,
      );
    }
    await assert.rejects(
      () => addBasicAuthUser(APP_A, "alice", ""),
      /password is required/i,
    );
    await addBasicAuthUser(APP_A, "alice", "pw");
    await assert.rejects(
      () => addBasicAuthUser(APP_A, "alice", "other"),
      /already exists/i,
    );
  });
});

test("another team's credentials are invisible and untouchable", async () => {
  const foreign = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "hunter2"),
  );

  await as(OWNER_B, TEAM_B, async () => {
    assert.deepEqual(
      await listBasicAuthUsers(APP_A),
      [],
      "an out-of-team app lists nothing (the tab is hidden)",
    );
    await assert.rejects(
      () => addBasicAuthUser(APP_A, "mallory", "pw"),
      /not found/i,
    );
    await assert.rejects(
      () => updateBasicAuthUserPassword(foreign.id, "pw"),
      /not found/i,
    );
    await assert.rejects(() => removeBasicAuthUser(foreign.id), /not found/i);
  });

  // Still exactly one credential, still the original password.
  const after = await as(OWNER_A, TEAM_A, () => listBasicAuthUsers(APP_A));
  assert.equal(after.length, 1);
  assert.equal(after[0].username, "alice");
});

/* ------------------------------------------------------------------ */
/* Authorship — "who set this login up, and who last rotated it"       */
/* ------------------------------------------------------------------ */

test("add names the creator; a password change moves only “modified by”", async () => {
  const added = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "hunter2"),
  );
  assert.equal(added.createdBy?.id, OWNER_A);
  assert.equal(
    added.updatedBy?.id,
    OWNER_A,
    "a brand-new credential was last touched by whoever added it",
  );
  // The DTO carries the display identity, not just an id — the card renders it.
  assert.equal(added.createdBy?.username, OWNER_A);
  assert.equal(added.createdBy?.avatarColor, "#abc");

  const rotated = await as(MATE_A, TEAM_A, () =>
    updateBasicAuthUserPassword(added.id, "hunter3"),
  );
  assert.equal(
    rotated.createdBy?.id,
    OWNER_A,
    "who ADDED the credential never changes",
  );
  assert.equal(rotated.updatedBy?.id, MATE_A);

  // What a mutation returns and what the next page render reads must agree.
  const [listed] = await as(OWNER_A, TEAM_A, () => listBasicAuthUsers(APP_A));
  assert.equal(listed.createdBy?.id, OWNER_A);
  assert.equal(listed.updatedBy?.id, MATE_A);
});

test("a credential from before authorship tracking is never attributed to anyone", async () => {
  const added = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "hunter2"),
  );
  // Exactly what migration 0045 leaves behind: it does NOT backfill, because
  // naming someone as the author of a credential they may never have touched is
  // a fabricated audit claim.
  await db
    .update(appBasicAuthUsers)
    .set({ createdByUserId: null, updatedByUserId: null })
    .where(eq(appBasicAuthUsers.id, added.id));

  const [row] = await as(OWNER_A, TEAM_A, () => listBasicAuthUsers(APP_A));
  assert.equal(row.createdBy, null, "the UI renders “—”, not a guess");
  assert.equal(row.updatedBy, null);
});

/* ------------------------------------------------------------------ */
/* Reveal — the one way back to a plaintext password                   */
/* ------------------------------------------------------------------ */

test("no DTO ever carries the password — the reveal is the only way to it", async () => {
  const u = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "hunter2"),
  );
  const [listed] = await as(OWNER_A, TEAM_A, () => listBasicAuthUsers(APP_A));
  // A field-by-field assertion, not a substring scan: this is the contract the
  // GraphQL object type mirrors, and a new column must not join it by accident.
  const EXPECTED = [
    "appId",
    "createdAt",
    "createdBy",
    "id",
    "updatedAt",
    "updatedBy",
    "username",
  ];
  assert.deepEqual(Object.keys(u).sort(), EXPECTED);
  assert.deepEqual(Object.keys(listed).sort(), EXPECTED);
});

test("the reveal returns the current password, and follows a rotation", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    const u = await addBasicAuthUser(APP_A, "alice", "hunter2");
    assert.equal(await revealBasicAuthPassword(u.id), "hunter2");
    await updateBasicAuthUserPassword(u.id, "hunter3");
    assert.equal(
      await revealBasicAuthPassword(u.id),
      "hunter3",
      "the reveal reads the stored credential, never a cached one",
    );
  });
});

test("the reveal refuses another team, and a member without manage_domains", async () => {
  const u = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "hunter2"),
  );
  await assert.rejects(
    () => as(OWNER_B, TEAM_B, () => revealBasicAuthPassword(u.id)),
    /not found/i,
    "a cross-team id must not even confirm the credential exists",
  );
  await assert.rejects(
    () => as(VIEWER_A, TEAM_A, () => revealBasicAuthPassword(u.id)),
    /manage_domains|permission|capability/i,
    "reading a password back is gated exactly like changing it",
  );
});

test("a password that cannot be decrypted fails the reveal (never returns empty)", async () => {
  const u = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "hunter2"),
  );
  // Rotated DEPLO_SECRET / restored dump. decryptSecret fails closed to "" —
  // showing that as "the password" would send someone off to try a login that
  // cannot work, so the reveal must say what actually happened.
  await db
    .update(appBasicAuthUsers)
    .set({ passwordEnc: "not-a-valid-ciphertext" })
    .where(eq(appBasicAuthUsers.id, u.id));

  await assert.rejects(
    () => as(OWNER_A, TEAM_A, () => revealBasicAuthPassword(u.id)),
    /could not be decrypted/i,
  );
});
