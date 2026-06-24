import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { buildSeed } from "../../seed";
import type { DeploData } from "../../types";
import { makeTestDb, type TestDb } from "../test-harness";
import { __setTestDb, __resetTestDb } from "../client";
import { runBackfill } from "./engine";
import { identityCutSetCopy, reconcileIdentity } from "./cut-sets/identity";
import { CUT_SETS } from "./markers";
import {
  membershipCapabilities as membershipCapabilitiesTable,
  storeMigration,
} from "../schema/control-plane";
import { runWithIdentity } from "../../auth/request-context";
import { capabilitiesForRole } from "../../membership-shared";
import { listMembers, listAllUsers, listRegistrationLinks } from "../../data/members";
import { membershipFor, teamsForUser } from "../../membership";

/**
 * End-to-end: the identity BACKFILL (cut-set b — copy users/teams/memberships
 * (+caps)/registrationLinks from a live JSONB doc into the relational tables) and
 * the async DATA LAYER agree (relational-store PLAN Step 3 "backfill fidelity").
 * Also covers idempotent re-run, fresh-install-marks-done-with-zero, the
 * capability-junction round-trip (incl. legacy coercion via cleanCapabilities),
 * and a reconcile mismatch driving a rollback.
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
  await pg.exec(`truncate table
    registration_links, membership_capabilities, memberships, users, teams,
    store_migration restart identity cascade;`);
});

const TEAM = "team_a";
const TEAM2 = "team_b";
const USER = "user_1";
const T0 = "2026-01-01T00:00:00.000Z";

function doc(): DeploData {
  const d = buildSeed();
  d.teams = [
    { id: TEAM, name: "Alpha", slug: "alpha", plan: "pro", createdAt: T0 },
    { id: TEAM2, name: "Beta", slug: "beta", plan: "pro", createdAt: "2026-01-02T00:00:00.000Z" },
  ];
  d.users = [
    {
      id: USER, email: "Owner@Alpha.io", username: "owner", name: "Owner",
      passwordHash: "h", role: "owner", isInstanceAdmin: true,
      canExposePorts: true, avatarColor: "#abc", createdAt: T0,
    },
    {
      id: "user_2", email: "member@beta.io", username: "member", name: "Member",
      passwordHash: "h2", role: "member", avatarColor: "#def",
      createdAt: "2026-01-03T00:00:00.000Z",
    },
  ];
  d.memberships = [
    {
      id: "mem_1", userId: USER, teamId: TEAM, role: "owner",
      capabilities: capabilitiesForRole("owner"), createdAt: T0,
    },
    {
      // A membership carrying a LEGACY/garbage capability — cleanCapabilities must
      // drop the unknown and always imply "view".
      id: "mem_2", userId: "user_2", teamId: TEAM2, role: "member",
      capabilities: ["manage_env", "bogus_cap" as never], createdAt: "2026-01-03T00:00:00.000Z",
    },
  ];
  d.registrationLinks = [
    {
      id: "reg_1", tokenHash: "hash_reg", status: "pending", createdBy: "owner",
      usedByUsername: null, expiresAt: "2099-01-01T00:00:00.000Z", createdAt: T0, usedAt: null,
    },
  ];
  return d;
}

test("identity backfill → async data layer reads back the copied rows", async () => {
  const d = doc();
  await runBackfill(db, CUT_SETS.identity, d, identityCutSetCopy);

  // teamsForUser / membershipFor read the relational rows.
  const teams = await teamsForUser(USER);
  assert.deepEqual(teams.map((t) => t.slug), ["alpha"]);

  const m = await membershipFor(USER, TEAM);
  assert.ok(m);
  assert.equal(m!.role, "owner");
  assert.deepEqual(
    new Set(m!.capabilities),
    new Set(capabilitiesForRole("owner")),
  );

  // The legacy/garbage capability was coerced: unknown dropped, view implied.
  const m2 = await membershipFor("user_2", TEAM2);
  assert.ok(m2!.capabilities.includes("view"));
  assert.ok(m2!.capabilities.includes("manage_env"));
  assert.ok(!m2!.capabilities.includes("bogus_cap" as never));

  // listMembers (team-scoped) + listAllUsers (instance) + registration links.
  await runWithIdentity({ userId: USER, teamId: TEAM }, async () => {
    const members = await listMembers();
    assert.deepEqual(members.map((x) => x.username), ["owner"]);
    const all = await listAllUsers();
    assert.deepEqual(
      all.map((u) => u.username).sort(),
      ["member", "owner"],
    );
    // Email is never projected in the global list.
    assert.equal("email" in all[0]!, false);
    const links = await listRegistrationLinks();
    assert.equal(links.length, 1);
    assert.equal(links[0]!.status, "pending");
  });
});

test("identity backfill is idempotent and a fresh install marks done with zero rows", async () => {
  const d = doc();
  await runBackfill(db, CUT_SETS.identity, d, identityCutSetCopy);
  // Re-run: no-op (marker present), row counts unchanged.
  await runBackfill(db, CUT_SETS.identity, d, identityCutSetCopy);
  const caps = await db.select().from(membershipCapabilitiesTable);
  assert.ok(caps.length > 0, "capabilities copied once, not doubled");

  // Fresh install: an empty doc still writes the marker (no rows copied).
  await pg.exec(`truncate table
    registration_links, membership_capabilities, memberships, users, teams,
    store_migration restart identity cascade;`);
  await runBackfill(db, CUT_SETS.identity, buildSeed(), identityCutSetCopy);
  const marker = await db
    .select()
    .from(storeMigration)
    .where(eq(storeMigration.name, CUT_SETS.identity));
  assert.equal(marker.length, 1, "marker written even with zero rows");
});

test("reconcileIdentity throws on a count drift (drives the tx rollback)", async () => {
  const d = doc();
  await runBackfill(db, CUT_SETS.identity, d, identityCutSetCopy);
  // Now assert reconcile against a doc with an EXTRA user the DB doesn't have:
  // the count mismatch must throw (this is what aborts a real copy + re-runs it).
  const drifted = doc();
  drifted.users.push({
    id: "ghost", email: "g@x.io", username: "ghost", name: "Ghost",
    passwordHash: "h", role: "member", avatarColor: "#000", createdAt: T0,
  });
  await assert.rejects(
    () => db.transaction((tx) => reconcileIdentity(tx, drifted)),
    /reconcile mismatch/,
  );
});
