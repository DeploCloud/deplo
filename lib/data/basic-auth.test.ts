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
import { appBasicAuthUsers } from "../db/schema/control-plane/domains";
import {
  addBasicAuthUser,
  listBasicAuthUsers,
  updateBasicAuthUserPassword,
  removeBasicAuthUser,
  revealBasicAuthPassword,
  basicAuthUsersValue,
  appHasBasicAuth,
} from "./basic-auth";

process.env.DEPLO_SECRET = "test-secret-for-basic-auth-aaaaaaaaaaaaaaaa";

let db: TestDb;
let pg: PGlite;

const OWNER_A = "u_owner_a";
const OWNER_B = "u_owner_b";
const MATE_A = "u_mate_a";
const VIEWER_A = "u_viewer_a";
const APP_A = "app_a";
const APP_B = "app_b";

const as = <T>(
  userId: string,
  teamId: string,
  fn: () => Promise<T>,
): Promise<T> => runWithIdentity({ userId, teamId }, fn);

// `user:$2b$<cost>$<salt+digest>` - the bcrypt htpasswd line Traefik parses.
const HTPASSWD_LINE = /^[^\s:,]+:\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

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
    const added = await addBasicAuthUser(APP_A, "alice", "Hunter2!x");
    assert.equal(added.appId, APP_A, "add must name the app to reroute");

    const updated = await updateBasicAuthUserPassword(added.id, "Hunter3!x");
    assert.equal(
      updated.appId,
      APP_A,
      "the update edge only knows the credential id - the app must come back with it",
    );

    const appId = await removeBasicAuthUser(added.id);
    assert.equal(appId, APP_A, "remove must name the app to reroute");
  });
});

test("the rendered value is one htpasswd line per user, alphabetical, comma-joined", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    assert.equal(
      await basicAuthUsersValue(APP_A),
      "",
      "no users ⇒ no middleware",
    );
    assert.equal(await appHasBasicAuth(APP_A), false);

    await addBasicAuthUser(APP_A, "zoe", "Pw-Zoe1!x");
    await addBasicAuthUser(APP_A, "alice", "Pw-Alice1!");

    const value = await basicAuthUsersValue(APP_A);
    const lines = value.split(",");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("alice:"), `alphabetical, got ${value}`);
    assert.ok(lines[1].startsWith("zoe:"));
    for (const line of lines) assert.match(line, HTPASSWD_LINE);
    assert.equal(await appHasBasicAuth(APP_A), true);
  });
});

test("only this app's credentials are rendered, never another app's", async () => {
  await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "Pw1!xxxxx"),
  );
  await as(OWNER_B, TEAM_B, () => addBasicAuthUser(APP_B, "bob", "Pw1!xxxxx"));

  const a = await as(OWNER_A, TEAM_A, () => basicAuthUsersValue(APP_A));
  const b = await as(OWNER_B, TEAM_B, () => basicAuthUsersValue(APP_B));
  assert.ok(a.startsWith("alice:") && !a.includes("bob"));
  assert.ok(b.startsWith("bob:") && !b.includes("alice"));
});

test("a password that cannot be decrypted fails the render (never fails open)", async () => {
  const id = await as(OWNER_A, TEAM_A, async () => {
    const u = await addBasicAuthUser(APP_A, "alice", "Hunter2!x");
    return u.id;
  });
  // A rotated DEPLO_SECRET: decryptSecret's "" would hash into a valid EMPTY password.
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
    const u = await addBasicAuthUser(APP_A, "alice", "Hunter2!x");
    const before = await basicAuthUsersValue(APP_A);
    await updateBasicAuthUserPassword(u.id, "Hunter3!x");
    const after = await basicAuthUsersValue(APP_A);
    assert.notEqual(
      before,
      after,
      "the htpasswd hash must change with the password",
    );
    assert.match(after, HTPASSWD_LINE);
  });
});

test("removing the last user renders nothing - the login prompt disappears", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    const u = await addBasicAuthUser(APP_A, "alice", "Hunter2!x");
    await removeBasicAuthUser(u.id);
    assert.equal(await basicAuthUsersValue(APP_A), "");
    assert.equal(await appHasBasicAuth(APP_A), false);
  });
});

test("usernames that would corrupt the label or the users= list are rejected", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    for (const bad of ["ali ce", "ali:ce", "ali,ce", 'ali"ce', "ali`ce", ""]) {
      await assert.rejects(
        () => addBasicAuthUser(APP_A, bad, "Pw1!xxxxx"),
        /username/i,
        `"${bad}" must be rejected`,
      );
    }
    await assert.rejects(
      () => addBasicAuthUser(APP_A, "alice", ""),
      /password is required/i,
    );
    await addBasicAuthUser(APP_A, "alice", "Pw1!xxxxx");
    await assert.rejects(
      () => addBasicAuthUser(APP_A, "alice", "Other1!xx"),
      /already exists/i,
    );
  });
});

test("another team's credentials are invisible and untouchable", async () => {
  const foreign = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "Hunter2!x"),
  );

  await as(OWNER_B, TEAM_B, async () => {
    assert.deepEqual(
      await listBasicAuthUsers(APP_A),
      [],
      "an out-of-team app lists nothing (the tab is hidden)",
    );
    await assert.rejects(
      () => addBasicAuthUser(APP_A, "mallory", "Pw1!xxxxx"),
      /not found/i,
    );
    await assert.rejects(
      () => updateBasicAuthUserPassword(foreign.id, "Pw1!xxxxx"),
      /not found/i,
    );
    await assert.rejects(() => removeBasicAuthUser(foreign.id), /not found/i);
  });

  const after = await as(OWNER_A, TEAM_A, () => listBasicAuthUsers(APP_A));
  assert.equal(after.length, 1);
  assert.equal(after[0].username, "alice");
});

test("add names the creator; a password change moves only “modified by”", async () => {
  const added = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "Hunter2!x"),
  );
  assert.equal(added.createdBy?.id, OWNER_A);
  assert.equal(
    added.updatedBy?.id,
    OWNER_A,
    "a brand-new credential was last touched by whoever added it",
  );
  assert.equal(added.createdBy?.username, OWNER_A);
  assert.equal(added.createdBy?.avatarColor, "#abc");

  const rotated = await as(MATE_A, TEAM_A, () =>
    updateBasicAuthUserPassword(added.id, "Hunter3!x"),
  );
  assert.equal(
    rotated.createdBy?.id,
    OWNER_A,
    "who ADDED the credential never changes",
  );
  assert.equal(rotated.updatedBy?.id, MATE_A);

  const [listed] = await as(OWNER_A, TEAM_A, () => listBasicAuthUsers(APP_A));
  assert.equal(listed.createdBy?.id, OWNER_A);
  assert.equal(listed.updatedBy?.id, MATE_A);
});

test("a credential from before authorship tracking is never attributed to anyone", async () => {
  const added = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "Hunter2!x"),
  );
  // Exactly what migration 0045 leaves behind: it does NOT backfill the authors.
  await db
    .update(appBasicAuthUsers)
    .set({ createdByUserId: null, updatedByUserId: null })
    .where(eq(appBasicAuthUsers.id, added.id));

  const [row] = await as(OWNER_A, TEAM_A, () => listBasicAuthUsers(APP_A));
  assert.equal(row.createdBy, null, "the UI renders “—”, not a guess");
  assert.equal(row.updatedBy, null);
});

test("no DTO ever carries the password - the reveal is the only way to it", async () => {
  const u = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "Hunter2!x"),
  );
  const [listed] = await as(OWNER_A, TEAM_A, () => listBasicAuthUsers(APP_A));
  // Field-by-field, not a substring scan: a new column must not join the DTO by accident.
  const EXPECTED = [
    "appId",
    "createdAt",
    "createdBy",
    "id",
    "imported",
    "updatedAt",
    "updatedBy",
    "username",
  ];
  assert.deepEqual(Object.keys(u).sort(), EXPECTED);
  assert.deepEqual(Object.keys(listed).sort(), EXPECTED);
});

test("the reveal returns the current password, and follows a rotation", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    const u = await addBasicAuthUser(APP_A, "alice", "Hunter2!x");
    assert.equal(await revealBasicAuthPassword(u.id), "Hunter2!x");
    await updateBasicAuthUserPassword(u.id, "Hunter3!x");
    assert.equal(
      await revealBasicAuthPassword(u.id),
      "Hunter3!x",
      "the reveal reads the stored credential, never a cached one",
    );
  });
});

test("the reveal refuses another team, and a member without manage_domains", async () => {
  const u = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "alice", "Hunter2!x"),
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
    addBasicAuthUser(APP_A, "alice", "Hunter2!x"),
  );
  // decryptSecret fails closed to "", and showing that as "the password" would be a lie.
  await db
    .update(appBasicAuthUsers)
    .set({ passwordEnc: "not-a-valid-ciphertext" })
    .where(eq(appBasicAuthUsers.id, u.id));

  await assert.rejects(
    () => as(OWNER_A, TEAM_A, () => revealBasicAuthPassword(u.id)),
    /could not be decrypted/i,
  );
});

// An imported password is already in use and protecting a public URL; refusing it removes the protection.
test("an imported credential skips the password policy and is flagged weak", async () => {
  const weak = await as(OWNER_A, TEAM_A, () =>
    addBasicAuthUser(APP_A, "carried", "coderpass123", { imported: true }),
  );
  assert.equal(weak.imported, true);
  await assert.rejects(
    () =>
      as(OWNER_A, TEAM_A, () =>
        addBasicAuthUser(APP_A, "typed", "coderpass123"),
      ),
    /uppercase|special|number/i,
  );
});
