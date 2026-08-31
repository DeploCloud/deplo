import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, truncateAll, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  folders as foldersTable,
  folderGrants as folderGrantsTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import { runWithIdentity } from "../auth/request-context";
import { ALL_CAPABILITIES } from "../types";
import { renameFolder, deleteFolder, setFolderColor } from "./folders";
import {
  folderCapabilities,
  folderShareCandidates,
  listFolderGrants,
  setFolderGrant,
} from "./folder-access";

/**
 * The ACTIVE-TEAM boundary, probed from the one direction the app-shaped gates
 * don't cover: a folder id belonging to a team that is not the request's.
 */

let db: TestDb;
let pg: PGlite;
const T0 = "2026-01-01T00:00:00.000Z";
/** In BOTH teams: owner of alpha, and holds organize/delete folders in beta. */
const BOTH = "u_both";
const FOLDER_B = "fld_in_beta";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await truncateAll(pg);
  await seedIdentity(db, {
    users: [
      { id: BOTH, teamId: TEAM_A, role: "owner" },
      { id: `${BOTH}_b`, teamId: TEAM_B, role: "owner" },
    ],
  });
  // The same person, also a member of beta with the full set there.
  await db.insert(membershipsTable).values({
    id: "mem_both_in_b",
    userId: BOTH,
    teamId: TEAM_B,
    role: "member",
    createdAt: T0,
  });
  await db.insert(membershipCapabilitiesTable).values(
    ALL_CAPABILITIES.map((capability) => ({
      membershipId: "mem_both_in_b",
      capability,
    })),
  );
  await db.insert(foldersTable).values({
    id: FOLDER_B,
    teamId: TEAM_B,
    name: "Beta folder",
    ownerUserId: BOTH,
    createdAt: T0,
    updatedAt: T0,
  });
});

async function folderStillNamed(name: string): Promise<boolean> {
  const rows = await db
    .select({ name: foldersTable.name })
    .from(foldersTable)
    .where(eq(foldersTable.id, FOLDER_B));
  return rows[0]?.name === name;
}

/** A read-only bearer token, minted in alpha, acting in alpha. */
const readOnlyTokenInAlpha = {
  userId: BOTH,
  teamId: TEAM_A,
  token: {
    id: "tok_readonly",
    capabilities: ["view" as const],
    scope: null,
    instanceAdmin: false,
  },
};

test("a read-only token can't rename a folder in ANOTHER team its creator owns", async () => {
  await assert.rejects(
    () =>
      runWithIdentity(readOnlyTokenInAlpha, () =>
        renameFolder(FOLDER_B, "pwned"),
      ),
    /not found|permission/i,
  );
  assert.ok(
    await folderStillNamed("Beta folder"),
    "a token granted only `view` renamed a folder in a team it never authenticated into",
  );
});

test("nor delete it, nor recolour it", async () => {
  await assert.rejects(
    () => runWithIdentity(readOnlyTokenInAlpha, () => deleteFolder(FOLDER_B)),
    /not found|permission/i,
  );
  await assert.rejects(
    () =>
      runWithIdentity(readOnlyTokenInAlpha, () =>
        setFolderColor(FOLDER_B, "#ff0000"),
      ),
    /not found|permission/i,
  );
  const rows = await db
    .select()
    .from(foldersTable)
    .where(eq(foldersTable.id, FOLDER_B));
  assert.equal(rows.length, 1, "the folder was deleted by a read-only token");
});

test("a token narrowed to one project in alpha reaches nothing in beta", async () => {
  const narrowed = {
    userId: BOTH,
    teamId: TEAM_A,
    token: {
      id: "tok_narrow",
      capabilities: [...ALL_CAPABILITIES],
      scope: {
        teamIds: [TEAM_A],
        wholeTeamIds: [],
        projectIds: ["prc_alpha_only"],
        folderIds: [],
        appIds: [],
        appProjectIds: [],
      },
      instanceAdmin: false,
    },
  };
  await assert.rejects(
    () => runWithIdentity(narrowed, () => renameFolder(FOLDER_B, "pwned")),
    /not found|permission|limited/i,
  );
  assert.ok(await folderStillNamed("Beta folder"));
});

test("and the capability resolver itself answers nothing for the foreign folder", async () => {
  const caps = await runWithIdentity(readOnlyTokenInAlpha, () =>
    folderCapabilities(FOLDER_B),
  );
  assert.deepEqual(
    caps.filter((c) => c !== "view"),
    [],
    "the folder gate handed a token acting in alpha its creator's beta capabilities",
  );
});

test("nor hand out standing capabilities on it to a beta member", async () => {
  // A second beta member for the token to arm. The grant OUTLIVES the token, so
  // this is the variant that survives revocation.
  await db.insert(usersTable).values({
    id: "u_beta_member",
    email: "beta@example.io",
    username: "u_beta_member",
    name: "u_beta_member",
    role: "member",
    isInstanceAdmin: false,
    suspended: false,
    avatarColor: "#abc",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(membershipsTable).values({
    id: "mem_beta_member",
    userId: "u_beta_member",
    teamId: TEAM_B,
    role: "member",
    createdAt: T0,
  });
  await db
    .insert(membershipCapabilitiesTable)
    .values({ membershipId: "mem_beta_member", capability: "view" });

  await assert.rejects(
    () =>
      runWithIdentity(readOnlyTokenInAlpha, () =>
        setFolderGrant(FOLDER_B, "u_beta_member", [
          "deploy_apps",
          "manage_env",
          "reveal_secrets",
          "delete_apps",
        ]),
      ),
    /not found|permission|owner/i,
  );
  const granted = await db
    .select({ capability: folderGrantsTable.capability })
    .from(folderGrantsTable)
    .where(eq(folderGrantsTable.folderId, FOLDER_B));
  assert.deepEqual(
    granted.map((g) => g.capability).filter((c) => c !== "view"),
    [],
    "a read-only token granted standing capabilities on another team's folder - the grant outlives the token",
  );
});

test("nor read the folder's grant list, nor its share candidates", async () => {
  await assert.rejects(
    () =>
      runWithIdentity(readOnlyTokenInAlpha, () => listFolderGrants(FOLDER_B)),
    /not found|permission|owner/i,
  );
  await assert.rejects(
    () =>
      runWithIdentity(readOnlyTokenInAlpha, () =>
        folderShareCandidates(FOLDER_B),
      ),
    /not found|permission|owner/i,
  );
});

test("a cookie session, acting in alpha, doesn't reach beta's folder either", async () => {
  await assert.rejects(
    () =>
      runWithIdentity({ userId: BOTH, teamId: TEAM_A }, () =>
        renameFolder(FOLDER_B, "pwned"),
      ),
    /not found|permission/i,
  );
  assert.ok(await folderStillNamed("Beta folder"));
});
