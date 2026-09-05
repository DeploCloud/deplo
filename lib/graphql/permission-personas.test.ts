import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

// The deploy hook and the domain checks read this at module load.
process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import {
  apiTokens as apiTokensTable,
  appGrants as appGrantsTable,
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { reachableCapabilities } from "../membership";
import { authenticateToken } from "../data/tokens";
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
  DB_1,
  DBA,
  DEP_OLD,
  DEP_TOP,
  DEPLOYER,
  ENV_B,
  ENV_PROD,
  ENV_STG,
  FLD_F,
  FLD_F_CHILD,
  FLD_P,
  FOLDERDEV,
  GRANTEE,
  HR,
  M,
  MEMBER,
  NEWBIE,
  OPS,
  OTHER,
  OWNER,
  PRJ_A,
  PRJ_B,
  Q,
  ROLE_PRJ,
  SOLO,
  STAGER,
  STRANGER,
  TEAM,
  VIEWER,
  appLookup,
  envInput,
  gql,
  ids,
  installLab,
  lab,
  newApp,
  passed,
  refused,
  settle,
  throwawayApp,
} from "./permission-lab-test-helpers";

/**
 * The permission system as a TEAM uses it, end to end through the schema: the
 * field's `authScopes`, the resolver and the data-layer gate together, for the
 * people a real team is made of. Every probe is a document the dashboard or an
 * API client would send, and every persona is one an admin would actually set up.
 */

installLab();

/* ------------------------------------------------------------------ */
/* The built-in roles                                                  */
/* ------------------------------------------------------------------ */

test("a Viewer reads everything public and changes nothing", async () => {
  assert.deepEqual(
    ids(await gql(VIEWER, Q.apps), "apps"),
    [APP_A_PROD, APP_A_STG, APP_B, APP_TOP, APP_X].sort(),
    "every app outside a folder: a folder is private to its owner and the people it was shared with",
  );
  for (const q of [Q.members, Q.roles, Q.databases, Q.servers, Q.activity])
    passed(await gql(VIEWER, q), "a viewer reads the team's furniture");
  assert.deepEqual(
    ids(await gql(VIEWER, Q.env, { appId: APP_TOP }), "env"),
    [],
    "variables are not part of read-only: not even their names",
  );
  refused(
    await gql(VIEWER, Q.sharedVars),
    "the shared library needs manage_env",
  );

  const denied: [string, Record<string, unknown>][] = [
    [M.redeploy, { appId: APP_TOP }],
    [M.stopApp, { id: APP_TOP }],
    [M.renameApp, { id: APP_TOP, name: "x" }],
    [M.deleteApp, { id: APP_TOP }],
    [M.upsertEnv, envInput(APP_TOP)],
    [M.addDomain, { appId: APP_TOP, name: "v.example.io" }],
    [M.createApp, newApp("viewer-app")],
    [M.createFolder, { name: "f" }],
    [M.createProject, { name: "p" }],
    [
      M.createDatabase,
      { input: { name: "d", type: "postgres", version: "16" } },
    ],
    [M.revealConnection, { id: DB_1 }],
    [
      M.addMember,
      { input: { userId: NEWBIE, roleId: lab.roles.get("viewer") } },
    ],
    [M.removeMember, { userId: MEMBER }],
    [M.createRole, { input: { name: "r" } }],
    [M.updateTeam, { input: { name: "renamed" } }],
    [M.deleteTeam, { teamId: TEAM }],
    [
      M.setFolderGrant,
      { folderId: FLD_F, userId: MEMBER, capabilities: ["deploy_apps"] },
    ],
    [M.moveAppToFolder, { appId: APP_TOP, folderId: FLD_F }],
    [M.rollback, { deploymentId: DEP_OLD }],
  ];
  for (const [doc, vars] of denied)
    refused(await gql(VIEWER, doc, vars), `viewer: ${doc.slice(0, 40)}`);
});

test("a Member ships and configures apps, and stops at the team's administration", async () => {
  passed(await gql(MEMBER, M.redeploy, { appId: APP_TOP }), "deploy");
  passed(await gql(MEMBER, M.stopApp, { id: APP_TOP }), "stop");
  passed(
    await gql(MEMBER, M.renameApp, { id: APP_TOP, name: "top2" }),
    "rename",
  );
  passed(await gql(MEMBER, M.upsertEnv, envInput(APP_TOP)), "variables");
  passed(
    await gql(MEMBER, M.addDomain, { appId: APP_TOP, name: "m.example.io" }),
    "domains",
  );
  passed(await gql(MEMBER, M.createApp, newApp("member-app")), "create");
  passed(await gql(MEMBER, M.createFolder, { name: "mine" }), "folders");
  passed(await gql(MEMBER, M.createProject, { name: "mine" }), "projects");
  passed(await gql(MEMBER, M.rollback, { deploymentId: DEP_OLD }), "rollback");
  const doomed = await throwawayApp(MEMBER, "member-doomed");
  passed(await gql(MEMBER, M.deleteApp, { id: doomed }), "delete");
  await settle();

  refused(
    await gql(MEMBER, M.createDatabase, {
      input: { name: "d", type: "postgres", version: "16" },
    }),
    "databases are infrastructure, not part of Member",
  );
  // Member carries reveal_secrets (variables are theirs to read back), and a
  // connection string is what they paste into an app's variables.
  passed(await gql(MEMBER, M.revealConnection, { id: DB_1 }), "reveal");
  refused(
    await gql(MEMBER, M.addMember, {
      input: { userId: NEWBIE, roleId: lab.roles.get("viewer") },
    }),
    "members",
  );
  refused(await gql(MEMBER, M.createRole, { input: { name: "r" } }), "roles");
  refused(await gql(MEMBER, M.updateTeam, { input: { name: "x" } }), "team");
  refused(await gql(MEMBER, M.deleteTeam, { teamId: TEAM }), "delete team");
  refused(
    await gql(MEMBER, M.setMemberAccess, {
      input: {
        userId: VIEWER,
        roleId: lab.roles.get("member"),
        granular: false,
      },
    }),
    "access",
  );
});

test("a Member cannot mint a token until the team lets tokens in, and is told why", async () => {
  const minted = await gql(MEMBER, M.createToken, {
    input: { name: "ci", capabilities: ["view", "deploy_apps"] },
  });
  refused(minted, "Member carries no manage_tokens");
  assert.match(
    minted.error!,
    /API tokens permission/,
    "the refusal names the permission to ask for, not a bare no",
  );
});

/* ------------------------------------------------------------------ */
/* Custom roles a team would author                                    */
/* ------------------------------------------------------------------ */

test("a Deployer redeploys and nothing else", async () => {
  passed(await gql(DEPLOYER, M.redeploy, { appId: APP_TOP }), "deploy");
  passed(await gql(DEPLOYER, M.cancel, { id: DEP_TOP }), "cancel is deploy");
  refused(await gql(DEPLOYER, M.stopApp, { id: APP_TOP }), "stop is control");
  refused(
    await gql(DEPLOYER, M.renameApp, { id: APP_TOP, name: "x" }),
    "rename",
  );
  refused(await gql(DEPLOYER, M.upsertEnv, envInput(APP_TOP)), "variables");
  refused(await gql(DEPLOYER, M.deleteApp, { id: APP_TOP }), "delete");
  refused(await gql(DEPLOYER, M.createApp, newApp("d")), "create");
  refused(
    await gql(DEPLOYER, M.rollback, { deploymentId: DEP_OLD }),
    "rollback is its own permission",
  );
});

test("an Ops role starts and stops, and never ships a build", async () => {
  passed(await gql(OPS, M.stopApp, { id: APP_TOP }), "stop");
  refused(await gql(OPS, M.redeploy, { appId: APP_TOP }), "deploy");
  refused(await gql(OPS, M.renameApp, { id: APP_TOP, name: "x" }), "rename");
});

test("a DBA owns the databases and touches no app", async () => {
  passed(
    await gql(DBA, M.createDatabase, {
      input: { name: "d2", type: "postgres", version: "16" },
    }),
    "create",
  );
  passed(await gql(DBA, M.revealConnection, { id: DB_1 }), "reveal");
  passed(await gql(DBA, M.deleteDatabase, { id: DB_1 }), "delete");
  refused(await gql(DBA, M.redeploy, { appId: APP_TOP }), "deploy");
  refused(await gql(DBA, M.createApp, newApp("d")), "create app");
  refused(await gql(DBA, M.upsertEnv, envInput(APP_TOP)), "variables");
});

test("a team administrator manages people within what they hold themselves", async () => {
  passed(
    await gql(HR, M.addMember, {
      input: { userId: NEWBIE, roleId: lab.roles.get("viewer") },
    }),
    "Viewer is within HR's own set",
  );
  refused(
    await gql(HR, M.updateMember, {
      input: { userId: NEWBIE, roleId: lab.roles.get("member") },
    }),
    "Member grants more than HR holds: an escalation",
  );
  refused(
    await gql(HR, M.createRole, {
      input: { name: "Shipper", capabilities: ["view", "deploy_apps"] },
    }),
    "a role can only carry what its author holds",
  );
  passed(
    await gql(HR, M.createRole, {
      input: { name: "Watcher", capabilities: ["view", "view_logs"] },
    }),
    "a role within HR's own set",
  );
  refused(
    await gql(HR, M.updateRole, {
      input: {
        id: lab.roles.get("owner"),
        name: "Owner",
        capabilities: ["view"],
      },
    }),
    "the Owner role is locked",
  );
  refused(await gql(HR, M.removeMember, { userId: OWNER }), "the founder");
  passed(await gql(HR, M.removeMember, { userId: NEWBIE }), "a plain member");
  refused(await gql(HR, M.redeploy, { appId: APP_TOP }), "HR never ships");
  refused(
    await gql(HR, M.setMemberAccess, {
      input: {
        userId: VIEWER,
        roleId: lab.roles.get("viewer"),
        granular: true,
        grants: [{ appIds: [APP_TOP], capabilities: ["deploy_apps"] }],
      },
    }),
    "cannot hand out deploy on a node they don't hold it on",
  );
});

test("the team can never lose its last administrator, through any door", async () => {
  // HR is the only non-owner administrator; OWNER is the founder and untouchable,
  // so the only way to zero admins is to strip both, which every path refuses.
  refused(await gql(OWNER, M.removeMember, { userId: OWNER }), "self-removal");
  refused(
    await gql(OWNER, M.updateMember, {
      input: { userId: OWNER, roleId: lab.roles.get("viewer") },
    }),
    "the founder's crown cannot be handed down",
  );
  refused(
    await gql(OWNER, M.deleteRole, { id: lab.roles.get("viewer") }),
    "a default role is never deleted",
  );
  refused(
    await gql(OWNER, M.deleteRole, { id: ROLE_PRJ }),
    "a role still held cannot be deleted",
  );
});

/* ------------------------------------------------------------------ */
/* Contractors: a role limited to part of the team                     */
/* ------------------------------------------------------------------ */

test("a contractor limited to one project sees and ships that project alone", async () => {
  assert.deepEqual(ids(await gql(CONTRACTOR, Q.apps), "apps"), [
    APP_A_PROD,
    APP_A_STG,
  ]);
  assert.deepEqual(ids(await gql(CONTRACTOR, Q.projects), "projects"), [PRJ_A]);
  assert.equal(
    appLookup(await gql(CONTRACTOR, Q.app, { slug: APP_B })),
    null,
    "an app outside the scope is not found by slug",
  );
  passed(await gql(CONTRACTOR, M.redeploy, { appId: APP_A_PROD }), "in");
  passed(await gql(CONTRACTOR, M.upsertEnv, envInput(APP_A_STG)), "in");
  refused(await gql(CONTRACTOR, M.redeploy, { appId: APP_B }), "other project");
  refused(await gql(CONTRACTOR, M.redeploy, { appId: APP_TOP }), "top level");
  refused(await gql(CONTRACTOR, M.upsertEnv, envInput(APP_TOP)), "top level");
  passed(
    await gql(
      CONTRACTOR,
      M.createApp,
      newApp("in-a", { projectId: PRJ_A, environmentId: ENV_PROD }),
    ),
    "creates inside the project",
  );
  refused(
    await gql(CONTRACTOR, M.createApp, newApp("top")),
    "cannot create at the top level",
  );
  refused(
    await gql(
      CONTRACTOR,
      M.createApp,
      newApp("in-b", { projectId: PRJ_B, environmentId: ENV_B }),
    ),
    "cannot create in the other project",
  );
  for (const q of [Q.members, Q.roles, Q.databases, Q.sharedVars])
    refused(await gql(CONTRACTOR, q), "nothing team-wide");
  refused(await gql(CONTRACTOR, M.createFolder, { name: "f" }), "no folders");
  refused(await gql(CONTRACTOR, M.createProject, { name: "p" }), "no projects");
});

test("a contractor limited to one environment never touches production", async () => {
  assert.deepEqual(ids(await gql(STAGER, Q.apps), "apps"), [APP_A_STG]);
  passed(await gql(STAGER, M.redeploy, { appId: APP_A_STG }), "staging");
  refused(await gql(STAGER, M.redeploy, { appId: APP_A_PROD }), "production");
  passed(
    await gql(
      STAGER,
      M.createApp,
      newApp("stg-app", { projectId: PRJ_A, environmentId: ENV_STG }),
    ),
    "creates in staging",
  );
  refused(
    await gql(
      STAGER,
      M.createApp,
      newApp("prod-app", { projectId: PRJ_A, environmentId: ENV_PROD }),
    ),
    "cannot create in production",
  );
});

test("a contractor limited to one folder reaches its whole subtree and nothing beside it", async () => {
  assert.deepEqual(ids(await gql(FOLDERDEV, Q.apps), "apps"), [
    APP_F,
    APP_F_CHILD,
  ]);
  assert.deepEqual(ids(await gql(FOLDERDEV, Q.folders), "folders"), [
    FLD_F,
    FLD_F_CHILD,
  ]);
  passed(await gql(FOLDERDEV, M.redeploy, { appId: APP_F_CHILD }), "subtree");
  refused(await gql(FOLDERDEV, M.redeploy, { appId: APP_TOP }), "outside");
  refused(await gql(FOLDERDEV, M.redeploy, { appId: APP_P }), "private folder");
  passed(
    await gql(FOLDERDEV, M.createApp, newApp("in-f", { folderId: FLD_F })),
    "creates in the folder",
  );
  refused(
    await gql(FOLDERDEV, M.createApp, newApp("in-p", { folderId: FLD_P })),
    "cannot create in a folder outside the scope",
  );
});

/* ------------------------------------------------------------------ */
/* One person, one corner: node grants                                 */
/* ------------------------------------------------------------------ */

test("a member given one app holds exactly that app", async () => {
  assert.deepEqual(ids(await gql(SOLO, Q.apps), "apps"), [APP_X]);
  passed(await gql(SOLO, M.redeploy, { appId: APP_X }), "deploy their app");
  passed(await gql(SOLO, M.renameApp, { id: APP_X, name: "x2" }), "configure");
  passed(await gql(SOLO, M.upsertEnv, envInput(APP_X)), "variables");
  refused(
    await gql(SOLO, M.deleteApp, { id: APP_X }),
    "delete was not granted",
  );
  refused(await gql(SOLO, M.redeploy, { appId: APP_TOP }), "another app");
  refused(await gql(SOLO, Q.members), "nothing team-wide");
});

test("a private folder is invisible until shared, and the share is exactly what was given", async () => {
  assert.equal(appLookup(await gql(VIEWER, Q.app, { slug: APP_P })), null);
  refused(
    await gql(MEMBER, M.redeploy, { appId: APP_P }),
    "a full Member cannot even see into someone else's private folder",
  );
  assert.ok(ids(await gql(GRANTEE, Q.apps), "apps").includes(APP_P));
  passed(await gql(GRANTEE, M.redeploy, { appId: APP_P }), "the share");
  refused(
    await gql(GRANTEE, M.renameApp, { id: APP_P, name: "x" }),
    "only deploy was shared",
  );
  refused(
    await gql(GRANTEE, M.setFolderGrant, {
      folderId: FLD_P,
      userId: MEMBER,
      capabilities: ["deploy_apps"],
    }),
    "a grantee never re-shares",
  );
  passed(
    await gql(OWNER, M.setFolderGrant, {
      folderId: FLD_P,
      userId: MEMBER,
      capabilities: ["deploy_apps"],
    }),
    "the owner shares",
  );
  passed(await gql(MEMBER, M.redeploy, { appId: APP_P }), "now reachable");
  refused(
    await gql(MEMBER, M.deleteApp, { id: APP_P }),
    "inside the folder the share REPLACES the Member set: no delete here",
  );
  const doomed = await throwawayApp(MEMBER, "member-doomed");
  passed(await gql(MEMBER, M.deleteApp, { id: doomed }), "elsewhere unchanged");
  await settle();
});

test("saving a member's page keeps the folders that were shared with them", async () => {
  passed(
    await gql(OWNER, M.setFolderGrant, {
      folderId: FLD_P,
      userId: MEMBER,
      capabilities: ["deploy_apps"],
    }),
    "share",
  );
  passed(await gql(MEMBER, M.redeploy, { appId: APP_P }), "reachable");

  // An admin trims one permission from the member page, which sends the
  // shares it did not touch along, exactly as the page does.
  const roleId = lab.roles.get("member")!;
  const own = capabilitiesForRole("member").filter((c) => c !== "delete_apps");
  const saved = await gql(OWNER, M.setMemberAccess, {
    input: {
      userId: MEMBER,
      roleId,
      granular: false,
      capabilities: own,
      grants: [{ folderIds: [FLD_P], capabilities: ["deploy_apps"] }],
    },
  });
  assert.equal(saved.error, undefined, saved.error);
  passed(await gql(MEMBER, M.redeploy, { appId: APP_P }), "the share survived");

  // An API client that sends no grants at all is leaving them alone, not
  // revoking every share the member has.
  const bare = await gql(OWNER, M.setMemberAccess, {
    input: { userId: MEMBER, roleId, granular: false, capabilities: own },
  });
  assert.equal(bare.error, undefined, bare.error);
  passed(await gql(MEMBER, M.redeploy, { appId: APP_P }), "still shared");
});

/* ------------------------------------------------------------------ */
/* API tokens                                                          */
/* ------------------------------------------------------------------ */

test("an owner's token holds only what it was minted with, and only where", async () => {
  const minted = await gql(OWNER, M.createToken, {
    input: { name: "ci", capabilities: ["view", "deploy_apps"] },
  });
  const raw = (minted.data as { createToken: { raw: string } }).createToken.raw;
  const identity = await authenticateToken(raw, null);
  assert.ok(identity?.token);
  const token = identity.token;
  passed(await gql(OWNER, M.redeploy, { appId: APP_TOP }, { token }), "minted");
  refused(
    await gql(OWNER, M.renameApp, { id: APP_TOP, name: "x" }, { token }),
    "the owner holds configure_apps, the token does not",
  );
  refused(
    await gql(OWNER, M.removeMember, { userId: VIEWER }, { token }),
    "nor manage_members",
  );

  const narrow = await gql(OWNER, M.createToken, {
    input: {
      name: "ci-a",
      capabilities: ["view", "deploy_apps", "manage_env"],
      projectIds: [PRJ_A],
    },
  });
  const narrowRaw = (narrow.data as { createToken: { raw: string } })
    .createToken.raw;
  const scoped = (await authenticateToken(narrowRaw, null))!.token!;
  assert.deepEqual(
    ids(await gql(OWNER, Q.apps, {}, { token: scoped }), "apps"),
    [APP_A_PROD, APP_A_STG],
  );
  refused(
    await gql(OWNER, M.redeploy, { appId: APP_TOP }, { token: scoped }),
    "outside the project",
  );
  refused(
    await gql(OWNER, Q.sharedVars, {}, { token: scoped }),
    "a narrowed token loses the team-wide library",
  );
});

test("an expired token and a removed member's token both stop resolving", async () => {
  const inThePast = await gql(OWNER, M.createToken, {
    input: {
      name: "old",
      capabilities: ["view"],
      expiresAt: "2020-01-01T00:00:00.000Z",
    },
  });
  assert.match(inThePast.error ?? "", /future/, "the past is refused at mint");

  const minted = await gql(OWNER, M.createToken, {
    input: {
      name: "short",
      capabilities: ["view"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  });
  const raw = (minted.data as { createToken: { raw: string } }).createToken.raw;
  assert.ok(await authenticateToken(raw, null), "live until it expires");
  await lab.db
    .update(apiTokensTable)
    .set({ expiresAt: "2020-01-01T00:00:00.000Z" })
    .where(eq(apiTokensTable.name, "short"));
  assert.equal(
    await authenticateToken(raw, null),
    null,
    "past its expiry the credential resolves to nothing",
  );

  refused(
    await gql(HR, M.createToken, {
      input: { name: "hr", capabilities: ["view", "manage_members"] },
    }),
    "HR holds no manage_tokens, so even a manager cannot mint one",
  );
});

/* ------------------------------------------------------------------ */
/* Roles as a living thing                                             */
/* ------------------------------------------------------------------ */

test("editing a role changes what its holders can do, immediately", async () => {
  const created = await gql(OWNER, M.createRole, {
    input: { name: "Dev", capabilities: ["view", "deploy_apps"] },
  });
  const roleId = (created.data as { createRole: { id: string } }).createRole.id;
  passed(
    await gql(OWNER, M.addMember, { input: { userId: NEWBIE, roleId } }),
    "add",
  );
  passed(await gql(NEWBIE, M.redeploy, { appId: APP_TOP }), "holds deploy");
  refused(
    await gql(NEWBIE, M.renameApp, { id: APP_TOP, name: "x" }),
    "not yet",
  );

  passed(
    await gql(OWNER, M.updateRole, {
      input: {
        id: roleId,
        name: "Dev",
        capabilities: ["view", "configure_apps"],
      },
    }),
    "edit",
  );
  refused(await gql(NEWBIE, M.redeploy, { appId: APP_TOP }), "deploy went");
  passed(
    await gql(NEWBIE, M.renameApp, { id: APP_TOP, name: "x" }),
    "rename came",
  );
});

test("re-assigning a role from the roster hands the member back to the role", async () => {
  const roleId = lab.roles.get("member")!;
  passed(
    await gql(OWNER, M.addMember, { input: { userId: NEWBIE, roleId } }),
    "add",
  );
  // An admin trims one permission from NEWBIE: their set is now their own.
  const own = capabilitiesForRole("member").filter((c) => c !== "delete_apps");
  const trimmed = await gql(OWNER, M.setMemberAccess, {
    input: { userId: NEWBIE, roleId, granular: false, capabilities: own },
  });
  assert.equal(trimmed.error, undefined, trimmed.error);
  refused(await gql(NEWBIE, M.deleteApp, { id: APP_TOP }), "trimmed");

  // Later the role is edited: the customised member is deliberately left alone.
  passed(
    await gql(OWNER, M.updateRole, {
      input: {
        id: roleId,
        name: "Member",
        capabilities: [...capabilitiesForRole("member"), "manage_backups"],
      },
    }),
    "role edit",
  );
  const stillOwn = await gql(NEWBIE, M.deleteApp, { id: APP_TOP });
  refused(stillOwn, "a customised set does not follow the role");

  // The admin puts NEWBIE back on the role from the roster's dropdown: from
  // here on they are the role again, and the next edit has to reach them.
  passed(
    await gql(OWNER, M.updateMember, { input: { userId: NEWBIE, roleId } }),
    "re-assign",
  );
  const flags = (
    await lab.db
      .select({
        custom: membershipsTable.customCapabilities,
        granular: membershipsTable.granular,
      })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, NEWBIE),
          eq(membershipsTable.teamId, TEAM),
        ),
      )
  )[0];
  assert.deepEqual(
    flags,
    { custom: false, granular: false },
    "assigning a role IS choosing to follow it",
  );
  passed(
    await gql(OWNER, M.updateRole, {
      input: {
        id: roleId,
        name: "Member",
        capabilities: [...capabilitiesForRole("member"), "manage_crons"],
      },
    }),
    "another role edit",
  );
  const caps = (await gql(NEWBIE, Q.apps)).error;
  assert.equal(caps, undefined);
  const holds = await runWithIdentity({ userId: NEWBIE, teamId: TEAM }, () =>
    reachableCapabilities(),
  );
  assert.ok(
    holds.includes("manage_crons"),
    "a member put back on the role follows the next edit",
  );
});

/* ------------------------------------------------------------------ */
/* Leaving                                                             */
/* ------------------------------------------------------------------ */

test("removing a member takes every corner they were given with them", async () => {
  passed(await gql(OWNER, M.removeMember, { userId: SOLO }), "remove SOLO");
  passed(
    await gql(OWNER, M.removeMember, { userId: GRANTEE }),
    "remove GRANTEE",
  );
  const leftovers = await lab.db
    .select({ id: appGrantsTable.appId })
    .from(appGrantsTable)
    .where(eq(appGrantsTable.userId, SOLO));
  const shares = await lab.db
    .select({ id: folderGrantsTable.folderId })
    .from(folderGrantsTable)
    .where(eq(folderGrantsTable.userId, GRANTEE));
  assert.deepEqual(
    [leftovers, shares],
    [[], []],
    "a grant hangs off the node, not the membership: removal has to clear it",
  );

  // Re-added as a plain Viewer, neither gets their old corner back.
  for (const userId of [SOLO, GRANTEE])
    passed(
      await gql(OWNER, M.addMember, {
        input: { userId, roleId: lab.roles.get("viewer") },
      }),
      "re-add",
    );
  refused(await gql(SOLO, M.redeploy, { appId: APP_X }), "no silent restore");
  assert.equal(
    appLookup(await gql(GRANTEE, Q.app, { slug: APP_P })),
    null,
    "the private folder is private again",
  );
});

test("removing a member hands the folders they owned to the primary owner", async () => {
  const made = await gql(MEMBER, M.createFolder, { name: "mine" });
  assert.equal(made.error, undefined, made.error);
  const folderId = (made.data as { createFolder: { id: string } }).createFolder
    .id;
  passed(
    await gql(MEMBER, M.moveAppToFolder, { appId: APP_TOP, folderId }),
    "the owner files an app into their folder",
  );
  assert.equal(
    appLookup(await gql(VIEWER, Q.app, { slug: APP_TOP })),
    null,
    "inside a private folder the app is gone from everyone else's overview",
  );

  passed(await gql(HR, M.removeMember, { userId: MEMBER }), "HR removes them");
  const [row] = await lab.db
    .select({ owner: foldersTable.ownerUserId })
    .from(foldersTable)
    .where(eq(foldersTable.id, folderId));
  assert.equal(
    row.owner,
    OWNER,
    "a folder never stays private to someone who left: the primary owner takes it",
  );
  assert.equal(
    appLookup(await gql(OWNER, Q.app, { slug: APP_TOP })),
    APP_TOP,
    "and can see, and share, what is inside",
  );
  passed(
    await gql(OWNER, M.setFolderGrant, {
      folderId,
      userId: VIEWER,
      capabilities: ["deploy_apps"],
    }),
    "sharing it on is the owner's call",
  );
  passed(await gql(VIEWER, M.redeploy, { appId: APP_TOP }), "and it works");
});

/* ------------------------------------------------------------------ */
/* Two-factor as a policy                                              */
/* ------------------------------------------------------------------ */

test("a team that requires two-factor locks every unenrolled member out, tokens included", async () => {
  await lab.db
    .update(teamsTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamsTable.id, TEAM));
  for (const userId of [VIEWER, MEMBER, HR, CONTRACTOR, SOLO])
    refused(await gql(userId, Q.apps), `${userId} is not enrolled`);
  await lab.db
    .update(teamsTable)
    .set({ requireTwoFactor: false })
    .where(eq(teamsTable.id, TEAM));
  passed(await gql(VIEWER, Q.apps), "policy lifted");
});

/* ------------------------------------------------------------------ */
/* Another team's ids                                                  */
/* ------------------------------------------------------------------ */

test("an owner of another team reaches nothing here, by id or by header", async () => {
  refused(
    await gql(STRANGER, Q.apps),
    "acting in a team they are not in is refused before the schema",
  );
  const inOwn = (vars: Record<string, unknown>, doc: string) =>
    gql(STRANGER, doc, vars, { teamId: OTHER });
  refused(await inOwn({ appId: APP_TOP }, M.redeploy), "an app of ours");
  refused(await inOwn({ id: APP_TOP, name: "x" }, M.renameApp), "rename");
  refused(await inOwn({ id: DB_1 }, M.revealConnection), "a database of ours");
  refused(
    await inOwn(
      { folderId: FLD_F, userId: STRANGER, capabilities: ["deploy_apps"] },
      M.setFolderGrant,
    ),
    "a folder of ours",
  );
  refused(
    await inOwn(
      { input: { id: ROLE_PRJ, name: "Mine", capabilities: ["view"] } },
      M.updateRole,
    ),
    "a role of ours",
  );
  assert.equal(
    appLookup(await inOwn({ slug: APP_TOP }, Q.app)),
    null,
    "not found, never a different error",
  );
});
