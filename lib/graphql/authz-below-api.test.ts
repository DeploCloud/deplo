import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { graphql } from "graphql";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { folders as foldersTable } from "../db/schema/control-plane";
import { schema } from "./schema";
import type { GraphQLContext } from "./context";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../types";

/**
 * The other half of the API's authorization surface: the mutations whose field
 * gate is only `loggedIn`, because the capability they need is a PER-RESOURCE
 * question a static scope cannot ask — which folder, whose account, which
 * backup target. For those the data layer is not defense in depth, it is the
 * only depth, so each one is driven here against a REAL fixture (a real folder,
 * owned by someone else; a real app; a real team) rather than the unreachable
 * ids `authz-matrix.test.ts` uses.
 *
 * Every case is stated twice, because either half alone proves nothing:
 *  - a member holding only `view` must be refused, and
 *  - a member holding exactly the named capability must NOT be — otherwise the
 *    gate is really "manage the whole team", and the fine-grained permission the
 *    role editor offers is decoration.
 */

let db: TestDb;
let pg: PGlite;

const USER_M = "user_below";
const FOLDER = "fld_owned";
const MY_FOLDER = "fld_mine";
const APP_ROOT = "prj_root";
const APP_FILED = "prj_filed";
const T0 = "2026-01-01T00:00:00.000Z";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec(
    `truncate table projects, activities, notification_settings restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_M, teamId: TEAM_A, role: "member", capabilities: ["view"] },
    ],
  });
  await seedServer(db);
  // Owned by the OTHER member: a folder gate that answered "yes" because the
  // caller happens to own the folder would prove nothing about capabilities.
  await db.insert(foldersTable).values([
    // Owned by the OTHER member: what a capability must NOT be able to open.
    {
      id: FOLDER,
      teamId: TEAM_A,
      name: "Prod",
      ownerUserId: USER_1,
      createdAt: T0,
      updatedAt: T0,
    },
    // Owned by the subject: where their team capabilities actually apply, so a
    // refusal is the CAPABILITY talking and not the folder's privacy.
    {
      id: MY_FOLDER,
      teamId: TEAM_A,
      name: "Mine",
      ownerUserId: USER_M,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await seedApp(db, { id: APP_ROOT, slug: "root-app" });
  await seedApp(db, { id: APP_FILED, slug: "filed-app", folderId: FOLDER });
});

async function setCaps(caps: Capability[]): Promise<void> {
  await pg.exec(
    `delete from membership_capabilities where membership_id = 'mem_${USER_M}';`,
  );
  const wanted = new Set<Capability>([...caps, "view"]);
  const values = ALL_CAPABILITIES.filter((c) => wanted.has(c))
    .map((c) => `('mem_${USER_M}', '${c}')`)
    .join(", ");
  await pg.exec(
    `insert into membership_capabilities (membership_id, capability) values ${values};`,
  );
}

async function callAs(
  userId: string,
  doc: string,
  teamId = TEAM_A,
): Promise<string[]> {
  const identity: RequestIdentity = { userId, teamId };
  return runWithIdentity(identity, async () => {
    const ctx: GraphQLContext = {
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId().catch(() => null),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity: null,
    };
    const result = await graphql({ schema, source: doc, contextValue: ctx });
    const invalid = (result.errors ?? []).filter((e) => !e.path);
    assert.equal(
      invalid.length,
      0,
      `invalid document: ${invalid.map((e) => e.message).join("; ")}\n${doc}`,
    );
    return (result.errors ?? []).map((e) => e.message);
  });
}

// "not found" counts: every id below is REAL, so the only way a gate can answer
// that is by refusing to admit the resource exists — the deliberate non-oracle.
const REFUSED =
  /not authorized|don't have permission|only the folder owner|only an instance admin|not a member|only its primary owner|not found/i;
const refused = (messages: string[]): boolean => messages.some((m) => REFUSED.test(m));

/**
 * One `loggedIn` mutation, the capability that must admit it, and the arguments
 * that reach a REAL row. `cap: null` means no team capability admits it — the
 * gate is ownership (a folder's owner) or the founder's crown.
 */
const CASES: { name: string; doc: string; cap: Capability | null }[] = [
  {
    name: "renameFolder",
    doc: `mutation { renameFolder(id: "${MY_FOLDER}", name: "Renamed") }`,
    cap: "organize_folders",
  },
  {
    name: "setFolderColor",
    doc: `mutation { setFolderColor(id: "${MY_FOLDER}", color: "#ff0000") }`,
    cap: "organize_folders",
  },
  {
    name: "moveFolder",
    doc: `mutation { moveFolder(id: "${MY_FOLDER}", parentId: null) }`,
    cap: "organize_folders",
  },
  {
    name: "deleteFolder",
    doc: `mutation { deleteFolder(id: "${MY_FOLDER}") }`,
    cap: "delete_folders",
  },
  {
    name: "moveAppToFolder",
    doc: `mutation { moveAppToFolder(appId: "${APP_ROOT}", folderId: null) }`,
    cap: "move_apps",
  },
  {
    name: "moveAppsToFolder",
    doc: `mutation { moveAppsToFolder(appIds: ["${APP_ROOT}"], folderId: null) }`,
    cap: "move_apps",
  },
  {
    // Someone else's folder: sharing it is the owner's call, and the only
    // capability that overrides that is the team super-user's `manage_team`.
    name: "setFolderGrant",
    doc: `mutation { setFolderGrant(folderId: "${FOLDER}", userId: "${USER_M}", capabilities: ["view"]) { userId } }`,
    cap: "manage_team",
  },
  {
    name: "removeFolderGrant",
    doc: `mutation { removeFolderGrant(folderId: "${FOLDER}", userId: "${USER_M}") { userId } }`,
    cap: "manage_team",
  },
  {
    name: "saveNotificationSettings",
    doc: `mutation { saveNotificationSettings(input: {}) { __typename } }`,
    cap: "manage_notifications",
  },
  {
    name: "testNotification",
    doc: `mutation { testNotification(channel: email) }`,
    cap: "manage_notifications",
  },
  {
    name: "deleteBackupArtifacts (app target)",
    doc: `mutation { deleteBackupArtifacts(targetKind: app, targetId: "${APP_ROOT}") }`,
    cap: "delete_apps",
  },
  {
    name: "deleteTeam",
    doc: `mutation { deleteTeam(teamId: "${TEAM_A}") }`,
    cap: null, // the founder's crown, never a capability someone can be given
  },
];

for (const c of CASES) {
  test(`${c.name}: a view-only member is refused`, async () => {
    await setCaps([]);
    const messages = await callAs(USER_M, c.doc);
    assert.ok(
      refused(messages),
      `${c.name} answered a view-only member with: ${messages.join("; ") || "no error at all"}`,
    );
  });

  test(
    c.cap
      ? `${c.name}: ${c.cap} is what admits it`
      : `${c.name}: no capability admits it, not even all forty`,
    async () => {
      await setCaps(c.cap ? [c.cap] : ALL_CAPABILITIES);
      const messages = await callAs(USER_M, c.doc);
      if (c.cap)
        assert.ok(
          !refused(messages),
          `${c.cap} was not enough for ${c.name}: ${messages.join("; ")}`,
        );
      else
        assert.ok(
          refused(messages),
          `${c.name} let a member through on capabilities alone: ${
            messages.join("; ") || "no error at all"
          }`,
        );
    },
  );
}

/* ------------------------------------------------------------------ */
/* The self-service surface: `loggedIn` because it really is           */
/* ------------------------------------------------------------------ */

test("a view-only member still owns their own account and sessions", async () => {
  await setCaps([]);
  // These are `loggedIn` on purpose — they act on the caller, not on the team.
  // Refusing them would lock a Viewer out of their own profile and 2FA.
  for (const doc of [
    `mutation { updateProfile(name: "New Name") }`,
    `mutation { revokeOtherSessions }`,
    `query { mySessions { id } }`,
    `query { myTeams { id } }`,
  ]) {
    const messages = await callAs(USER_M, doc);
    assert.ok(!refused(messages), `${doc} was refused: ${messages.join("; ")}`);
  }
});

test("switching to a team you don't belong to is refused", async () => {
  await setCaps(ALL_CAPABILITIES);
  const messages = await callAs(USER_M, `mutation { switchTeam(teamId: "${TEAM_B}") }`);
  assert.ok(
    refused(messages),
    `switchTeam crossed a team boundary: ${messages.join("; ") || "no error at all"}`,
  );
});

test("the compose preview is served at the view floor with every value masked", async () => {
  await setCaps([]);
  // The preview is deliberately readable by anyone who can see the app — which
  // is only safe because the values are stripped on the way out. Assert the
  // masking, not the permission: this field IS the exception.
  const identity: RequestIdentity = { userId: USER_M, teamId: TEAM_A };
  const rendered = await runWithIdentity(identity, async () => {
    const ctx: GraphQLContext = {
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity: null,
    };
    return graphql({
      schema,
      source: `mutation { renderComposeStack(appId: "${APP_ROOT}") }`,
      contextValue: ctx,
    });
  });
  const yaml = (rendered.data as { renderComposeStack: string | null } | null)
    ?.renderComposeStack;
  if (yaml)
    assert.ok(
      !/=(?!\s*$)[^\s]/.test(
        yaml
          .split("\n")
          .filter((l) => /^\s*-\s+[A-Z0-9_]+=/.test(l))
          .join("\n")
          .replace(/=\*+/g, "="),
      ),
      `an env VALUE survived the redaction:\n${yaml}`,
    );
});

/* ------------------------------------------------------------------ */
/* Folder grants: the second gate on an app inside a folder            */
/* ------------------------------------------------------------------ */

test("a team capability does not reach into a folder the member can't see", async () => {
  // The folder is owned by USER_1 and shared with nobody: an app filed inside it
  // is invisible, and stays invisible however much the TEAM role grants —
  // EXCEPT `manage_team`, which is the documented folder super-user, so the
  // subject holds everything but that.
  await setCaps(ALL_CAPABILITIES.filter((c) => c !== "manage_team"));
  const messages = await callAs(
    USER_M,
    `mutation { renameApp(id: "${APP_FILED}", name: "taken") { id } }`,
  );
  assert.ok(
    messages.some((m) => /not found|don't have permission/i.test(m)),
    `an app inside someone else's folder was writable: ${messages.join("; ") || "no error at all"}`,
  );
  const readable = await runWithIdentity(
    { userId: USER_M, teamId: TEAM_A },
    async () => {
      const ctx: GraphQLContext = {
        viewer: await getCurrentUser(),
        teamId: await getActiveTeamId(),
        capabilities: await reachableCapabilities(),
        via: "cookie",
        identity: null,
      };
      return graphql({
        schema,
        source: `query { app(slug: "filed-app") { id } }`,
        contextValue: ctx,
      });
    },
  );
  assert.equal(
    (readable.data as { app: unknown } | null)?.app ?? null,
    null,
    "the read answers nothing rather than the app it is hiding",
  );
});
