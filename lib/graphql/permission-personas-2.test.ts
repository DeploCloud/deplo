import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import {
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  projectGrants as projectGrantsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { reachableCapabilities } from "../membership";
import { capabilitiesForRole } from "../membership-shared";
import {
  APP_A_PROD,
  APP_A_STG,
  APP_B,
  APP_F,
  APP_F_CHILD,
  APP_P,
  APP_TOP,
  APP_X,
  CONTRACTOR,
  ENV_PROD,
  FLD_F,
  FLD_P,
  GRANTEE,
  HR,
  M,
  MEMBER,
  NEWBIE,
  OTHER,
  OWNER,
  OWNER2,
  PRJ_A,
  PRJ_B,
  Q,
  SOLO,
  SYSADMIN,
  TEAM,
  VIEWER,
  appLookup,
  envInput,
  field,
  gql,
  ids,
  installLab,
  lab,
  mintToken,
  newApp,
  passed,
  refused,
  settle,
  throwawayApp,
} from "./permission-lab-test-helpers";

/**
 * Second pass over the permission lab: the people and moves the first pass did
 * not cover - the instance admin who is not a member, the second owner, reach
 * handed out on a whole project or folder, what moving and deleting folders does
 * to the shares inside them, and the less common ways in (narrow tokens, a
 * role-level 2FA mandate, a suspended account).
 */

installLab();

/* ------------------------------------------------------------------ */
/* People with power from outside the team                            */
/* ------------------------------------------------------------------ */

test("an instance admin who is not a member administers the team, and works in it not at all", async () => {
  const inOwn = (doc: string, vars: Record<string, unknown> = {}) =>
    gql(SYSADMIN, doc, vars, { teamId: OTHER });
  refused(await gql(SYSADMIN, Q.apps), "the lab is not one of their teams");
  passed(
    await inOwn(M.addUserToTeam, {
      input: { userId: NEWBIE, teamId: TEAM, roleId: lab.roles.get("viewer") },
    }),
    "the admin door adds people to a team they are not in",
  );
  passed(
    await inOwn(M.setUserTeamAccess, {
      input: {
        userId: NEWBIE,
        teamId: TEAM,
        roleId: lab.roles.get("member"),
        granular: true,
        grants: [{ appIds: [APP_TOP], capabilities: ["deploy_apps"] }],
      },
    }),
    "and shapes their reach",
  );
  passed(await gql(NEWBIE, M.redeploy, { appId: APP_TOP }), "which works");
  refused(await gql(NEWBIE, M.redeploy, { appId: APP_X }), "and stops there");
  refused(
    await inOwn(M.removeUserFromTeam, {
      input: { userId: OWNER, teamId: TEAM },
    }),
    "the founder is closed to an instance admin too",
  );
  passed(
    await inOwn(M.removeUserFromTeam, {
      input: { userId: NEWBIE, teamId: TEAM },
    }),
    "removal through the admin door",
  );
  refused(await gql(NEWBIE, Q.apps), "gone");

  // Their token is not an admin unless it says so.
  const { token } = await mintToken(
    SYSADMIN,
    { name: "plain", capabilities: ["view", "manage_tokens"] },
    { teamId: OTHER },
  );
  refused(
    await gql(
      SYSADMIN,
      M.addUserToTeam,
      {
        input: {
          userId: NEWBIE,
          teamId: TEAM,
          roleId: lab.roles.get("viewer"),
        },
      },
      { teamId: OTHER, token },
    ),
    "instance administration is opt-in per token",
  );
});

test("a second owner administers everyone but the founder", async () => {
  passed(
    await gql(OWNER2, M.updateRole, {
      input: {
        id: lab.roles.get("member"),
        name: "Member",
        capabilities: [...capabilitiesForRole("member"), "manage_backups"],
      },
    }),
    "edits roles",
  );
  passed(
    await gql(OWNER2, M.addMember, {
      input: { userId: NEWBIE, roleId: lab.roles.get("owner") },
    }),
    "an owner can add another owner",
  );
  refused(
    await gql(OWNER2, M.removeMember, { userId: OWNER }),
    "not the crown",
  );
  refused(
    await gql(OWNER2, M.updateMember, {
      input: { userId: OWNER, roleId: lab.roles.get("viewer") },
    }),
    "nor demote it",
  );
  passed(await gql(OWNER2, M.removeMember, { userId: NEWBIE }), "peers go");
  passed(
    await gql(OWNER, M.removeMember, { userId: OWNER2 }),
    "the founder removes an owner",
  );
  refused(await gql(OWNER2, Q.apps), "and they are out");
});

/* ------------------------------------------------------------------ */
/* Reach handed out on a container                                     */
/* ------------------------------------------------------------------ */

test("a member given one project holds it whole, environments included", async () => {
  const saved = await gql(OWNER, M.setMemberAccess, {
    input: {
      userId: VIEWER,
      roleId: lab.roles.get("viewer"),
      granular: true,
      grants: [
        {
          projectIds: [PRJ_A],
          capabilities: ["create_apps", "deploy_apps", "manage_env"],
        },
      ],
    },
  });
  assert.equal(saved.error, undefined, saved.error);
  assert.deepEqual(ids(await gql(VIEWER, Q.apps), "apps"), [
    APP_A_PROD,
    APP_A_STG,
  ]);
  passed(await gql(VIEWER, M.redeploy, { appId: APP_A_STG }), "staging too");
  passed(await gql(VIEWER, M.upsertEnv, envInput(APP_A_PROD)), "variables");
  passed(
    await gql(
      VIEWER,
      M.createApp,
      newApp("in-a-2", { projectId: PRJ_A, environmentId: ENV_PROD }),
    ),
    "creates inside the project",
  );
  refused(await gql(VIEWER, M.createApp, newApp("top-2")), "not at the top");
  refused(
    await gql(VIEWER, M.renameApp, { id: APP_A_PROD, name: "x" }),
    "configure was not given",
  );
  refused(await gql(VIEWER, M.redeploy, { appId: APP_B }), "another project");
});

test("a member given one folder holds its subtree, and a nearer app grant wins inside it", async () => {
  const saved = await gql(OWNER, M.setMemberAccess, {
    input: {
      userId: VIEWER,
      roleId: lab.roles.get("viewer"),
      granular: true,
      grants: [
        { folderIds: [FLD_F], capabilities: ["deploy_apps", "configure_apps"] },
        { appIds: [APP_F_CHILD], capabilities: ["view_logs"] },
      ],
    },
  });
  assert.equal(saved.error, undefined, saved.error);
  assert.deepEqual(ids(await gql(VIEWER, Q.apps), "apps"), [
    APP_F,
    APP_F_CHILD,
  ]);
  passed(await gql(VIEWER, M.redeploy, { appId: APP_F }), "the folder grant");
  refused(
    await gql(VIEWER, M.redeploy, { appId: APP_F_CHILD }),
    "the app grant replaces the folder's inside the child, and holds no deploy",
  );
  refused(await gql(VIEWER, M.redeploy, { appId: APP_TOP }), "outside");
});

/* ------------------------------------------------------------------ */
/* Shares follow the folder, not the app                              */
/* ------------------------------------------------------------------ */

test("moving an app in and out of a shared folder moves the grantee's power with it", async () => {
  refused(await gql(GRANTEE, M.redeploy, { appId: APP_TOP }), "not shared yet");
  passed(
    await gql(OWNER, M.moveAppToFolder, { appId: APP_TOP, folderId: FLD_P }),
    "the owner files it into the shared folder",
  );
  passed(await gql(GRANTEE, M.redeploy, { appId: APP_TOP }), "now deployable");
  passed(
    await gql(OWNER, M.moveAppToFolder, { appId: APP_TOP, folderId: null }),
    "and back out",
  );
  refused(
    await gql(GRANTEE, M.redeploy, { appId: APP_TOP }),
    "power went with the folder",
  );
  assert.equal(
    appLookup(await gql(GRANTEE, Q.app, { slug: APP_TOP })),
    APP_TOP,
    "at the top level it is visible to everyone, read-only",
  );
});

test("deleting a shared folder keeps its apps and drops the share", async () => {
  passed(await gql(GRANTEE, M.redeploy, { appId: APP_P }), "control");
  passed(
    await gql(OWNER, M.deleteFolder, { id: FLD_P, deleteApps: false }),
    "the owner removes the folder, keeping the apps",
  );
  assert.equal(
    appLookup(await gql(VIEWER, Q.app, { slug: APP_P })),
    APP_P,
    "the app is now at the top level, and everyone sees it",
  );
  refused(
    await gql(GRANTEE, M.redeploy, { appId: APP_P }),
    "the share died with the folder: back to Viewer",
  );
  assert.equal(
    (await lab.db.select().from(folderGrantsTable)).length,
    0,
    "no grant row outlives its folder",
  );
});

test("a share can carry only what the sharer holds on the folder", async () => {
  const folderId = field<{ id: string }>(
    await gql(MEMBER, M.createFolder, { name: "member-owned" }),
    "createFolder",
  ).id;
  passed(
    await gql(MEMBER, M.moveAppToFolder, { appId: APP_X, folderId }),
    "files an app",
  );
  // Member holds no manage_backups: the share is bounded to what they have.
  const grants = field<{ userId: string; capabilities: string[] }[]>(
    await gql(MEMBER, M.setFolderGrant, {
      folderId,
      userId: VIEWER,
      capabilities: ["deploy_apps", "manage_backups"],
    }),
    "setFolderGrant",
  );
  const viewerRow = grants.find((g) => g.userId === VIEWER)!;
  assert.ok(viewerRow.capabilities.includes("deploy_apps"));
  assert.ok(
    !viewerRow.capabilities.includes("manage_backups"),
    "a sharer cannot hand out what they do not hold",
  );
  passed(
    await gql(VIEWER, M.redeploy, { appId: APP_X }),
    "the shared part works",
  );
  refused(
    await gql(VIEWER, M.moveAppsToFolder, { appIds: [APP_X], folderId: null }),
    "moving was not shared",
  );
});

/* ------------------------------------------------------------------ */
/* Bulk actions ask per app                                            */
/* ------------------------------------------------------------------ */

test("a bulk delete is refused as a whole when one app is out of reach", async () => {
  refused(
    await gql(SOLO, M.deleteApps, { ids: [APP_X] }),
    "SOLO holds no delete on their one app",
  );
  refused(
    await gql(MEMBER, M.deleteApps, { ids: [APP_TOP, APP_P] }),
    "a Member cannot see into the private folder, so the selection fails",
  );
  const a = await throwawayApp(MEMBER, "bulk-a");
  const b = await throwawayApp(MEMBER, "bulk-b");
  assert.equal(
    field<number>(
      await gql(MEMBER, M.deleteApps, { ids: [a, b] }),
      "deleteApps",
    ),
    2,
    "a selection entirely in reach goes through",
  );
  await settle();
});

/* ------------------------------------------------------------------ */
/* Narrow tokens                                                        */
/* ------------------------------------------------------------------ */

test("a token limited to a folder or an app sees exactly that", async () => {
  const { token: folderToken } = await mintToken(OWNER, {
    name: "folder-ci",
    capabilities: ["view", "deploy_apps"],
    folderIds: [FLD_F],
  });
  assert.deepEqual(
    ids(await gql(OWNER, Q.apps, {}, { token: folderToken }), "apps"),
    [APP_F, APP_F_CHILD],
    "the subtree",
  );
  passed(
    await gql(
      OWNER,
      M.redeploy,
      { appId: APP_F_CHILD },
      { token: folderToken },
    ),
    "deploys inside",
  );
  refused(
    await gql(OWNER, M.redeploy, { appId: APP_TOP }, { token: folderToken }),
    "not outside",
  );

  const { token: appToken } = await mintToken(OWNER, {
    name: "app-ci",
    capabilities: ["view", "deploy_apps", "manage_members"],
    appIds: [APP_TOP],
  });
  assert.deepEqual(
    ids(await gql(OWNER, Q.apps, {}, { token: appToken }), "apps"),
    [APP_TOP],
  );
  refused(
    await gql(
      OWNER,
      M.setMemberAccess,
      {
        input: {
          userId: VIEWER,
          roleId: lab.roles.get("viewer"),
          granular: false,
        },
      },
      { token: appToken },
    ),
    "a narrowed token cannot manage members, whatever it was minted with",
  );
  refused(
    await gql(OWNER, Q.members, {}, { token: appToken }),
    "nor list them",
  );
});

test("a member whose role is limited cannot mint a token at all", async () => {
  const minted = await gql(CONTRACTOR, M.createToken, {
    input: { name: "ci", capabilities: ["view", "deploy_apps"] },
  });
  refused(minted, "manage_tokens is team-wide, and a limited role holds none");
});

/* ------------------------------------------------------------------ */
/* Policies on the person                                              */
/* ------------------------------------------------------------------ */

test("a role-level two-factor mandate locks out that role's holders and nobody else", async () => {
  passed(
    await gql(OWNER, M.updateRole, {
      input: {
        id: lab.roles.get("member"),
        name: "Member",
        requireTwoFactor: true,
      },
    }),
    "the founder does not hold Member, so they may mandate it",
  );
  refused(await gql(MEMBER, Q.apps), "Member is unenrolled");
  passed(await gql(VIEWER, Q.apps), "Viewer is untouched");
  passed(await gql(HR, Q.apps), "so is a hand-picked set");

  // HR is moved onto a role and then tries to put the mandate on it themselves.
  const managers = field<{ id: string }>(
    await gql(OWNER, M.createRole, {
      input: { name: "Managers", capabilities: ["view", "manage_roles"] },
    }),
    "createRole",
  ).id;
  passed(
    await gql(OWNER, M.updateMember, {
      input: { userId: HR, roleId: managers },
    }),
    "assign",
  );
  refused(
    await gql(HR, M.updateRole, {
      input: { id: managers, name: "Managers", requireTwoFactor: true },
    }),
    "you cannot mandate two-factor on your own role without enrolling first",
  );
});

test("a suspended account resolves nothing, in the dashboard and through its tokens", async () => {
  const { token } = await mintToken(OWNER, {
    name: "ci",
    capabilities: ["view", "deploy_apps"],
  });
  await lab.db
    .update(usersTable)
    .set({ suspended: true })
    .where(eq(usersTable.id, OWNER));
  refused(await gql(OWNER, Q.apps), "the session");
  refused(
    await gql(OWNER, M.redeploy, { appId: APP_TOP }, { token }),
    "the token",
  );
  await lab.db
    .update(usersTable)
    .set({ suspended: false })
    .where(eq(usersTable.id, OWNER));
  passed(await gql(OWNER, Q.apps), "and back");
});

/* ------------------------------------------------------------------ */
/* What a limited member is told                                        */
/* ------------------------------------------------------------------ */

test("search and the activity trail are cut to what a limited member reaches", async () => {
  passed(
    await gql(OWNER, M.renameApp, { id: APP_TOP, name: "top-renamed" }),
    "seed",
  );
  passed(
    await gql(OWNER, M.renameApp, { id: APP_X, name: "x-renamed" }),
    "seed",
  );
  passed(
    await gql(OWNER, M.renameApp, { id: APP_A_PROD, name: "a-renamed" }),
    "seed",
  );

  const found = field<{ apps: { id: string }[] }>(
    await gql(CONTRACTOR, Q.search, { q: "renamed" }),
    "search",
  );
  assert.deepEqual(
    found.apps.map((a) => a.id),
    [APP_A_PROD],
    "search never names an app outside the scope",
  );
  const soloFound = field<{ apps: { id: string }[] }>(
    await gql(SOLO, Q.search, { q: "renamed" }),
    "search",
  );
  assert.deepEqual(
    soloFound.apps.map((a) => a.id),
    [APP_X],
  );

  const trail = field<{ appId: string | null }[]>(
    await gql(SOLO, Q.activity),
    "activity",
  );
  assert.ok(
    trail.length > 0,
    "SOLO holds view_logs? no - view_activity is Viewer's",
  );
  assert.ok(
    trail.every((e) => e.appId === APP_X),
    "the trail shows their app and nothing about the others",
  );
  const all = field<{ appId: string | null }[]>(
    await gql(VIEWER, Q.activity),
    "activity",
  );
  assert.ok(
    all.some((e) => e.appId === APP_TOP) && all.some((e) => e.appId === APP_X),
    "a full Viewer reads the whole trail",
  );
});

test("a manager hands out only what they hold, and the member reads as more than their role", async () => {
  refused(
    await gql(HR, M.setMemberAccess, {
      input: {
        userId: VIEWER,
        roleId: lab.roles.get("viewer"),
        granular: false,
        capabilities: [...capabilitiesForRole("viewer"), "deploy_apps"],
      },
    }),
    "HR holds no deploy_apps",
  );
  const saved = await gql(HR, M.setMemberAccess, {
    input: {
      userId: VIEWER,
      roleId: lab.roles.get("viewer"),
      granular: false,
      capabilities: [...capabilitiesForRole("viewer"), "manage_roles"],
    },
  });
  assert.equal(saved.error, undefined, saved.error);
  assert.equal(
    field<{ customCapabilities: boolean }[]>(saved, "setMemberAccess")[0]
      .customCapabilities,
    true,
    "their set is now their own",
  );
  const holds = await runWithIdentity({ userId: VIEWER, teamId: TEAM }, () =>
    reachableCapabilities(),
  );
  assert.ok(holds.includes("manage_roles"));
});

test("deleting the project a role is limited to leaves its holders with nothing, not everything", async () => {
  passed(await gql(CONTRACTOR, M.redeploy, { appId: APP_A_PROD }), "control");
  passed(await gql(OWNER, M.deleteProject, { id: PRJ_A }), "the project goes");
  assert.deepEqual(
    ids(await gql(CONTRACTOR, Q.apps), "apps"),
    [],
    "the apps fell to the top level, which the scope never reached",
  );
  refused(
    await gql(CONTRACTOR, M.createApp, newApp("anywhere")),
    "nowhere to create",
  );
  const scope = (
    await lab.db
      .select({ granular: membershipsTable.granular })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, CONTRACTOR),
          eq(membershipsTable.teamId, TEAM),
        ),
      )
  )[0];
  assert.equal(scope.granular, false, "their role, not a per-member reach");
});

test("switching to a team you are not in is refused, and a folder of the lab stays private to its owner", async () => {
  refused(await gql(VIEWER, M.switchTeam, { teamId: OTHER }), "not a member");
  const folderId = field<{ id: string }>(
    await gql(MEMBER, M.createFolder, { name: "quiet" }),
    "createFolder",
  ).id;
  assert.ok(!ids(await gql(VIEWER, Q.folders), "folders").includes(folderId));
  assert.ok(
    ids(await gql(OWNER, Q.folders), "folders").includes(folderId),
    "the owner sees all",
  );
  assert.ok(
    ids(await gql(HR, Q.folders), "folders").includes(folderId) === false,
    "manage_members is not manage_team",
  );
  const [row] = await lab.db
    .select({ owner: foldersTable.ownerUserId })
    .from(foldersTable)
    .where(eq(foldersTable.id, folderId));
  assert.equal(row.owner, MEMBER);
});

test("creating an app is decided where it lands: a project grant can take create_apps away", async () => {
  // Member holds create_apps team-wide; inside Project B a grant says deploy only.
  await lab.db
    .insert(projectGrantsTable)
    .values({ projectId: PRJ_B, userId: MEMBER, capability: "deploy_apps" });
  passed(
    await gql(MEMBER, M.createApp, newApp("at-top")),
    "top level: the role",
  );
  passed(
    await gql(
      MEMBER,
      M.createApp,
      newApp("in-a-3", { projectId: PRJ_A, environmentId: ENV_PROD }),
    ),
    "Project A: the role",
  );
  refused(
    await gql(MEMBER, M.createApp, newApp("in-b", { projectId: PRJ_B })),
    "Project B: the grant replaces the role there, and holds no create_apps",
  );
  passed(await gql(MEMBER, M.redeploy, { appId: APP_B }), "what it does hold");
});

test("a token dies with the permission its owner was put back on a role without", async () => {
  const roleId = lab.roles.get("member")!;
  const saved = await gql(OWNER, M.setMemberAccess, {
    input: {
      userId: MEMBER,
      roleId,
      granular: false,
      capabilities: [...capabilitiesForRole("member"), "manage_tokens"],
    },
  });
  assert.equal(saved.error, undefined, saved.error);
  const { raw } = await mintToken(MEMBER, {
    name: "ci",
    capabilities: ["view", "deploy_apps"],
  });
  passed(
    await gql(OWNER, M.updateMember, { input: { userId: MEMBER, roleId } }),
    "back on plain Member, which carries no manage_tokens",
  );
  const { authenticateToken } = await import("../data/tokens");
  assert.equal(
    await authenticateToken(raw, null),
    null,
    "the credential resolves to nothing the moment the permission is gone",
  );
});
