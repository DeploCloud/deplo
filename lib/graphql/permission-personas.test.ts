import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

// The deploy hook and the domain checks read this at module load.
process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb, getDb } from "../db/client";
import {
  apiTokens as apiTokensTable,
  appGrants as appGrantsTable,
  deployments as deploymentsTable,
  environments as environmentsTable,
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  projects as projectsTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
  teamRoleScopeEnvironments,
  teamRoleScopeFolders,
  teamRoleScopeProjects,
  teams as teamsTable,
} from "../db/schema/control-plane";
import {
  runWithIdentity,
  type RequestIdentity,
  type TokenGrant,
} from "../auth/request-context";
import { getCurrentUser } from "../auth";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { seedIdentity } from "../data/identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { seedDatabase } from "../data/backup-test-helpers";
import { effectiveRoleCapabilities, ensureTeamRoles } from "../data/roles";
import { authenticateToken } from "../data/tokens";
import {
  __resetQueueForTest,
  __setRunnerForTest,
} from "../deploy/deploy-queue";
import {
  __setAgentConnectorForTest,
  AgentUnreachableError,
} from "../infra/agent-client";
import { __setTeardownDialForTest } from "../data/teardown-queue";
import {
  __resetDnsResolve4ForTest,
  __setDnsResolve4ForTest,
} from "../data/domains";
import { runGraphql } from "../mcp/execute";
import { capabilitiesForRole } from "../membership-shared";
import type { Capability, Role } from "../types";

/**
 * The permission system as a TEAM uses it, end to end through the schema: the
 * field's `authScopes`, the resolver and the data-layer gate together, for the
 * people a real team is made of. Every probe is a document the dashboard or an
 * API client would send, and every persona is one an admin would actually set up.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const TEAM = "team_lab";
const OTHER = "team_other";

const OWNER = "u_owner";
const VIEWER = "u_viewer";
const MEMBER = "u_member";
const DEPLOYER = "u_deployer";
const OPS = "u_ops";
const DBA = "u_dba";
const HR = "u_hr";
const CONTRACTOR = "u_contractor";
const STAGER = "u_stager";
const FOLDERDEV = "u_folderdev";
const SOLO = "u_solo";
const GRANTEE = "u_grantee";
const NEWBIE = "u_newbie";
const STRANGER = "u_stranger";

const PRJ_A = "prc_a";
const PRJ_B = "prc_b";
const ENV_PROD = "environ_prod";
const ENV_STG = "environ_stg";
const ENV_B = "environ_b";
const FLD_F = "fld_f";
const FLD_F_CHILD = "fld_f_child";
const FLD_P = "fld_p";
const APP_A_PROD = "prj_a_prod";
const APP_A_STG = "prj_a_stg";
const APP_B = "prj_b";
const APP_F = "prj_f";
const APP_F_CHILD = "prj_f_child";
const APP_P = "prj_p";
const APP_TOP = "prj_top";
const APP_X = "prj_x";
const DEP_TOP = "dpl_top";
const DEP_OLD = "dpl_old";
const DB_1 = "db_1";
const ROLE_PRJ = "role_prj";
const ROLE_ENV = "role_env";
const ROLE_FLD = "role_fld";

const VIEWER_CAPS = capabilitiesForRole("viewer");
const DEPLOYER_CAPS: Capability[] = ["view", "deploy_apps", "view_logs"];
const OPS_CAPS: Capability[] = [
  "view",
  "control_apps",
  "view_logs",
  "view_metrics",
];
const DBA_CAPS: Capability[] = [
  "view",
  "create_databases",
  "configure_databases",
  "control_databases",
  "delete_databases",
  "open_database_console",
  "reveal_secrets",
  "manage_backups",
];
const HR_CAPS: Capability[] = [
  ...VIEWER_CAPS,
  "manage_members",
  "manage_roles",
];
/** What a contractor's role is authored with - team-wide reach is what its scope removes. */
const SCOPED_CAPS: Capability[] = [
  "view",
  "create_apps",
  "deploy_apps",
  "configure_apps",
  "manage_env",
  "view_logs",
];
const SOLO_GRANT: Capability[] = [
  "deploy_apps",
  "configure_apps",
  "manage_env",
  "view_logs",
];

let roles: Map<Role, string>;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // The stand-in runner has to settle the row: left `queued`, the lane picks it
  // up again the moment the runner returns and spins the event loop forever.
  __setRunnerForTest(async (depId) => {
    await db
      .update(deploymentsTable)
      .set({ status: "canceled" })
      .where(eq(deploymentsTable.id, depId));
  });
  // The lab has no host: a gate that passes is then stopped by the dial, which
  // is the one error every "allowed" probe is permitted to end in.
  __setAgentConnectorForTest(async () => {
    throw new AgentUnreachableError("lab: no host");
  });
  __setTeardownDialForTest(async () => {
    throw new AgentUnreachableError("lab: no host");
  });
  __setDnsResolve4ForTest(async () => ["10.0.0.1"]);
});

after(async () => {
  // A delete's teardown runs behind the response; let it land before the DB goes.
  await new Promise((r) => setTimeout(r, 300));
  __resetQueueForTest();
  __setAgentConnectorForTest();
  __setTeardownDialForTest(null);
  __resetDnsResolve4ForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table databases restart identity cascade;`);
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(`truncate table
    activities, api_tokens, projects, team_roles, membership_capabilities,
    memberships, users, teams, instance_settings restart identity cascade;`);
  const member = (
    id: string,
    capabilities: Capability[],
    role: Role = "member",
  ) => ({ id, teamId: TEAM, role, isInstanceAdmin: false, capabilities });
  await seedIdentity(db, {
    teams: [
      { id: TEAM, slug: "lab" },
      { id: OTHER, slug: "other" },
    ],
    users: [
      { id: OWNER, teamId: TEAM, role: "owner", isInstanceAdmin: false },
      member(VIEWER, VIEWER_CAPS, "viewer"),
      member(MEMBER, capabilitiesForRole("member")),
      member(DEPLOYER, DEPLOYER_CAPS),
      member(OPS, OPS_CAPS),
      member(DBA, DBA_CAPS),
      member(HR, HR_CAPS),
      member(CONTRACTOR, effectiveRoleCapabilities(SCOPED_CAPS, true)),
      member(STAGER, effectiveRoleCapabilities(SCOPED_CAPS, true)),
      member(FOLDERDEV, effectiveRoleCapabilities(SCOPED_CAPS, true)),
      member(SOLO, VIEWER_CAPS, "viewer"),
      member(GRANTEE, VIEWER_CAPS, "viewer"),
      { id: STRANGER, teamId: OTHER, role: "owner", isInstanceAdmin: false },
      { ...member(NEWBIE, VIEWER_CAPS, "viewer"), teamId: OTHER },
    ],
  });
  await seedServer(db);

  await db.insert(projectsTable).values(
    [
      [PRJ_A, "Project A", "project-a"],
      [PRJ_B, "Project B", "project-b"],
    ].map(([id, name, slug]) => ({
      id,
      teamId: TEAM,
      name,
      slug,
      createdAt: T0,
      updatedAt: T0,
    })),
  );
  await db.insert(environmentsTable).values(
    (
      [
        [ENV_PROD, PRJ_A, true, 0],
        [ENV_STG, PRJ_A, false, 1],
        [ENV_B, PRJ_B, true, 0],
      ] as const
    ).map(([id, projectId, isDefault, position]) => ({
      id,
      projectId,
      name: id,
      slug: id,
      kind: "custom" as const,
      gitBranch: "",
      isDefault,
      position,
      createdAt: T0,
      updatedAt: T0,
    })),
  );
  const folder = (id: string, parentId: string | null = null) => ({
    id,
    teamId: TEAM,
    name: id,
    parentId,
    color: null,
    ownerUserId: OWNER,
    projectId: null,
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .insert(foldersTable)
    .values([folder(FLD_F), folder(FLD_F_CHILD, FLD_F), folder(FLD_P)]);

  await seedApp(db, {
    id: APP_A_PROD,
    teamId: TEAM,
    projectId: PRJ_A,
    environmentId: ENV_PROD,
  });
  await seedApp(db, {
    id: APP_A_STG,
    teamId: TEAM,
    projectId: PRJ_A,
    environmentId: ENV_STG,
  });
  await seedApp(db, {
    id: APP_B,
    teamId: TEAM,
    projectId: PRJ_B,
    environmentId: ENV_B,
  });
  await seedApp(db, { id: APP_F, teamId: TEAM, folderId: FLD_F });
  await seedApp(db, { id: APP_F_CHILD, teamId: TEAM, folderId: FLD_F_CHILD });
  await seedApp(db, { id: APP_P, teamId: TEAM, folderId: FLD_P });
  await seedApp(db, { id: APP_TOP, teamId: TEAM, rollbackKeep: 3 });
  await seedApp(db, { id: APP_X, teamId: TEAM });
  await seedDeployment(db, {
    id: DEP_OLD,
    appId: APP_TOP,
    serverId: SERVER_1,
    imageRef: "deplo/top:old",
    createdAt: "2025-12-01T00:00:00.000Z",
  });
  await seedDeployment(db, {
    id: DEP_TOP,
    appId: APP_TOP,
    serverId: SERVER_1,
    imageRef: "deplo/top:new",
  });
  await seedDatabase(db, { id: DB_1, teamId: TEAM, name: "main" });

  // Three scoped roles, one per shape a contractor comes in.
  await db.insert(teamRolesTable).values(
    [
      [ROLE_PRJ, "Project A only"],
      [ROLE_ENV, "Staging only"],
      [ROLE_FLD, "Folder F only"],
    ].map(([id, name]) => ({
      id,
      teamId: TEAM,
      builtinKey: null,
      name,
      description: null,
      requireTwoFactor: false,
      scoped: true,
      createdAt: T0,
    })),
  );
  await db
    .insert(teamRoleCapabilitiesTable)
    .values(
      [ROLE_PRJ, ROLE_ENV, ROLE_FLD].flatMap((roleId) =>
        SCOPED_CAPS.map((capability) => ({ roleId, capability })),
      ),
    );
  await db
    .insert(teamRoleScopeProjects)
    .values({ roleId: ROLE_PRJ, projectId: PRJ_A });
  await db
    .insert(teamRoleScopeEnvironments)
    .values({ roleId: ROLE_ENV, environmentId: ENV_STG });
  await db
    .insert(teamRoleScopeFolders)
    .values({ roleId: ROLE_FLD, folderId: FLD_F });
  for (const [userId, roleId] of [
    [CONTRACTOR, ROLE_PRJ],
    [STAGER, ROLE_ENV],
    [FOLDERDEV, ROLE_FLD],
  ] as const) {
    await db
      .update(membershipsTable)
      .set({ roleId })
      .where(eq(membershipsTable.userId, userId));
  }

  // SOLO holds one app and nothing else; GRANTEE was shared one private folder.
  await db
    .update(membershipsTable)
    .set({ granular: true })
    .where(eq(membershipsTable.userId, SOLO));
  await db.insert(appGrantsTable).values(
    SOLO_GRANT.map((capability) => ({
      appId: APP_X,
      userId: SOLO,
      capability,
    })),
  );
  await db
    .insert(folderGrantsTable)
    .values({ folderId: FLD_P, userId: GRANTEE, capability: "deploy_apps" });

  roles = await ensureTeamRoles(getDb(), TEAM);
});

/* ------------------------------------------------------------------ */
/* Driving the schema                                                  */
/* ------------------------------------------------------------------ */

interface Outcome {
  data: unknown;
  error?: string;
}

/** Send one document as `userId`, exactly as /api/graphql would build the context. */
async function gql(
  userId: string,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { teamId?: string; token?: TokenGrant } = {},
): Promise<Outcome> {
  const identity: RequestIdentity = {
    userId,
    teamId: opts.teamId ?? TEAM,
    ...(opts.token ? { token: opts.token } : {}),
  };
  try {
    const ctx = await runWithIdentity(identity, async () => ({
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: opts.token ? ("token" as const) : ("cookie" as const),
      identity,
    }));
    return await runGraphql(query, variables, ctx);
  } catch (e) {
    // The context itself refuses (an unmet 2FA mandate, not a member): the
    // request never reaches the schema, which is what the route does too.
    return { data: null, error: (e as Error).message };
  }
}

const REFUSAL =
  /permission|not found|not authorized|unauthorized|can't|cannot|only |limited to|part of this team|not a member|no longer belongs|two-factor|hold yourself|isn't in this team/i;

type Verdict = "allowed" | "refused" | "blocked";

/** "blocked" is the lab's missing host: the gate was passed and the dial failed. */
function verdict(r: Outcome): Verdict {
  if (!r.error) return "allowed";
  if (REFUSAL.test(r.error)) return "refused";
  assert.match(
    r.error,
    /lab: no host|unreachable|not provisioned/i,
    `an unexpected non-permission error: ${r.error}`,
  );
  return "blocked";
}

function refused(r: Outcome, why: string): void {
  assert.equal(verdict(r), "refused", `${why} - got: ${r.error ?? "ok"}`);
}
function passed(r: Outcome, why: string): void {
  assert.notEqual(verdict(r), "refused", `${why} - refused: ${r.error}`);
}

/** What `app(slug:)` answered: the id, or null for "not found". */
function appLookup(r: Outcome): string | null {
  assert.equal(r.error, undefined, r.error);
  return (r.data as { app: { id: string } | null }).app?.id ?? null;
}

/** The ids a list query answered with. */
function ids(r: Outcome, field: string): string[] {
  assert.equal(r.error, undefined, r.error);
  const rows = (r.data as Record<string, { id: string }[] | null>)[field];
  return (rows ?? []).map((x) => x.id).sort();
}

const Q = {
  apps: /* GraphQL */ `
    {
      apps {
        id
      }
    }
  `,
  app: /* GraphQL */ `
    query ($slug: String!) {
      app(slug: $slug) {
        id
      }
    }
  `,
  members: /* GraphQL */ `
    {
      members {
        userId
      }
    }
  `,
  roles: /* GraphQL */ `
    {
      teamRoles {
        id
      }
    }
  `,
  databases: /* GraphQL */ `
    {
      databases {
        id
      }
    }
  `,
  servers: /* GraphQL */ `
    {
      servers {
        id
      }
    }
  `,
  sharedVars: /* GraphQL */ `
    {
      sharedVars {
        id
      }
    }
  `,
  env: /* GraphQL */ `
    query ($appId: String!) {
      env(appId: $appId) {
        id
      }
    }
  `,
  activity: /* GraphQL */ `
    {
      activity {
        id
      }
    }
  `,
  folders: /* GraphQL */ `
    {
      folders {
        id
      }
    }
  `,
  projects: /* GraphQL */ `
    {
      projects {
        id
      }
    }
  `,
};

const M = {
  redeploy: /* GraphQL */ `
    mutation ($appId: String!) {
      redeploy(appId: $appId) {
        id
      }
    }
  `,
  stopApp: /* GraphQL */ `
    mutation ($id: String!) {
      stopApp(id: $id) {
        id
      }
    }
  `,
  renameApp: /* GraphQL */ `
    mutation ($id: String!, $name: String!) {
      renameApp(id: $id, name: $name) {
        id
      }
    }
  `,
  deleteApp: /* GraphQL */ `
    mutation ($id: String!) {
      deleteApp(id: $id)
    }
  `,
  upsertEnv: /* GraphQL */ `
    mutation ($input: UpsertEnvInput!) {
      upsertEnv(input: $input) {
        id
      }
    }
  `,
  addDomain: /* GraphQL */ `
    mutation ($appId: String!, $name: String!) {
      addDomain(appId: $appId, name: $name) {
        id
      }
    }
  `,
  createApp: /* GraphQL */ `
    mutation ($input: CreateAppInput!) {
      createApp(input: $input) {
        id
      }
    }
  `,
  createFolder: /* GraphQL */ `
    mutation ($name: String!) {
      createFolder(name: $name) {
        id
      }
    }
  `,
  createProject: /* GraphQL */ `
    mutation ($name: String!) {
      createProject(name: $name) {
        id
      }
    }
  `,
  createDatabase: /* GraphQL */ `
    mutation ($input: CreateDatabaseInput!) {
      createDatabase(input: $input) {
        id
      }
    }
  `,
  deleteDatabase: /* GraphQL */ `
    mutation ($id: String!) {
      deleteDatabase(id: $id)
    }
  `,
  revealConnection: /* GraphQL */ `
    mutation ($id: String!) {
      revealConnection(id: $id)
    }
  `,
  addMember: /* GraphQL */ `
    mutation ($input: AddMemberInput!) {
      addExistingMember(input: $input) {
        userId
      }
    }
  `,
  removeMember: /* GraphQL */ `
    mutation ($userId: String!) {
      removeMember(userId: $userId)
    }
  `,
  updateMember: /* GraphQL */ `
    mutation ($input: UpdateMemberInput!) {
      updateMember(input: $input) {
        userId
      }
    }
  `,
  setMemberAccess: /* GraphQL */ `
    mutation ($input: SetMemberAccessInput!) {
      setMemberAccess(input: $input) {
        teamId
        customCapabilities
        granular
      }
    }
  `,
  createRole: /* GraphQL */ `
    mutation ($input: CreateRoleInput!) {
      createRole(input: $input) {
        id
      }
    }
  `,
  updateRole: /* GraphQL */ `
    mutation ($input: UpdateRoleInput!) {
      updateRole(input: $input)
    }
  `,
  deleteRole: /* GraphQL */ `
    mutation ($id: String!) {
      deleteRole(id: $id)
    }
  `,
  createToken: /* GraphQL */ `
    mutation ($input: CreateTokenInput!) {
      createToken(input: $input) {
        raw
        token {
          id
        }
      }
    }
  `,
  updateTeam: /* GraphQL */ `
    mutation ($input: UpdateTeamInput!) {
      updateTeam(input: $input) {
        id
      }
    }
  `,
  deleteTeam: /* GraphQL */ `
    mutation ($teamId: String!) {
      deleteTeam(teamId: $teamId)
    }
  `,
  setFolderGrant: /* GraphQL */ `
    mutation ($folderId: ID!, $userId: ID!, $capabilities: [String!]!) {
      setFolderGrant(
        folderId: $folderId
        userId: $userId
        capabilities: $capabilities
      ) {
        userId
      }
    }
  `,
  moveAppToFolder: /* GraphQL */ `
    mutation ($appId: ID!, $folderId: ID) {
      moveAppToFolder(appId: $appId, folderId: $folderId)
    }
  `,
  rollback: /* GraphQL */ `
    mutation ($deploymentId: String!) {
      rollbackDeployment(deploymentId: $deploymentId) {
        id
      }
    }
  `,
  cancel: /* GraphQL */ `
    mutation ($id: String!) {
      cancelDeployment(id: $id)
    }
  `,
};

/** An app made to be deleted, so a teardown landing later never touches a fixture. */
async function throwawayApp(userId: string, name: string): Promise<string> {
  const made = await gql(userId, M.createApp, newApp(name));
  assert.equal(made.error, undefined, made.error);
  return (made.data as { createApp: { id: string } }).createApp.id;
}
const settle = () => new Promise((r) => setTimeout(r, 200));

const envInput = (appId: string) => ({
  input: { appId, key: "LAB_KEY", value: "1", type: "plain" },
});
const newApp = (name: string, placement: Record<string, string> = {}) => ({
  input: { name, source: "UPLOAD", ...placement },
});

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
    [M.addMember, { input: { userId: NEWBIE, roleId: roles.get("viewer") } }],
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
      input: { userId: NEWBIE, roleId: roles.get("viewer") },
    }),
    "members",
  );
  refused(await gql(MEMBER, M.createRole, { input: { name: "r" } }), "roles");
  refused(await gql(MEMBER, M.updateTeam, { input: { name: "x" } }), "team");
  refused(await gql(MEMBER, M.deleteTeam, { teamId: TEAM }), "delete team");
  refused(
    await gql(MEMBER, M.setMemberAccess, {
      input: { userId: VIEWER, roleId: roles.get("member"), granular: false },
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
      input: { userId: NEWBIE, roleId: roles.get("viewer") },
    }),
    "Viewer is within HR's own set",
  );
  refused(
    await gql(HR, M.updateMember, {
      input: { userId: NEWBIE, roleId: roles.get("member") },
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
      input: { id: roles.get("owner"), name: "Owner", capabilities: ["view"] },
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
        roleId: roles.get("viewer"),
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
      input: { userId: OWNER, roleId: roles.get("viewer") },
    }),
    "the founder's crown cannot be handed down",
  );
  refused(
    await gql(OWNER, M.deleteRole, { id: roles.get("viewer") }),
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
  const roleId = roles.get("member")!;
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
  await db
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
  const roleId = roles.get("member")!;
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
    await db
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
  const leftovers = await db
    .select({ id: appGrantsTable.appId })
    .from(appGrantsTable)
    .where(eq(appGrantsTable.userId, SOLO));
  const shares = await db
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
        input: { userId, roleId: roles.get("viewer") },
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
  const [row] = await db
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
  await db
    .update(teamsTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamsTable.id, TEAM));
  for (const userId of [VIEWER, MEMBER, HR, CONTRACTOR, SOLO])
    refused(await gql(userId, Q.apps), `${userId} is not enrolled`);
  await db
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
