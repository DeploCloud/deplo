import { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb, getDb } from "../db/client";
import {
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
 * The permission lab: one team, the people a real team is made of, and the
 * schema driven in-process exactly as /api/graphql would build the context. Named
 * to dodge the `*.test.ts` glob; both persona suites install it.
 */

export const T0 = "2026-01-01T00:00:00.000Z";
export const TEAM = "team_lab";
export const OTHER = "team_other";

export const OWNER = "u_owner";
export const VIEWER = "u_viewer";
export const MEMBER = "u_member";
export const DEPLOYER = "u_deployer";
export const OPS = "u_ops";
export const DBA = "u_dba";
export const HR = "u_hr";
export const CONTRACTOR = "u_contractor";
export const STAGER = "u_stager";
export const FOLDERDEV = "u_folderdev";
export const SOLO = "u_solo";
export const GRANTEE = "u_grantee";
export const NEWBIE = "u_newbie";
export const STRANGER = "u_stranger";
/** An instance admin who is NOT in the lab team. */
export const SYSADMIN = "u_sysadmin";
/** An assigned (non-founder) Owner of the lab team. */
export const OWNER2 = "u_owner2";

export const PRJ_A = "prc_a";
export const PRJ_B = "prc_b";
export const ENV_PROD = "environ_prod";
export const ENV_STG = "environ_stg";
export const ENV_B = "environ_b";
export const FLD_F = "fld_f";
export const FLD_F_CHILD = "fld_f_child";
export const FLD_P = "fld_p";
export const APP_A_PROD = "prj_a_prod";
export const APP_A_STG = "prj_a_stg";
export const APP_B = "prj_b";
export const APP_F = "prj_f";
export const APP_F_CHILD = "prj_f_child";
export const APP_P = "prj_p";
export const APP_TOP = "prj_top";
export const APP_X = "prj_x";
export const DEP_TOP = "dpl_top";
export const DEP_OLD = "dpl_old";
export const DB_1 = "db_1";
export const ROLE_PRJ = "role_prj";
export const ROLE_ENV = "role_env";
export const ROLE_FLD = "role_fld";

export const VIEWER_CAPS = capabilitiesForRole("viewer");
export const DEPLOYER_CAPS: Capability[] = ["view", "deploy_apps", "view_logs"];
export const OPS_CAPS: Capability[] = [
  "view",
  "control_apps",
  "view_logs",
  "view_metrics",
];
export const DBA_CAPS: Capability[] = [
  "view",
  "create_databases",
  "configure_databases",
  "control_databases",
  "delete_databases",
  "open_database_console",
  "reveal_secrets",
  "manage_backups",
];
export const HR_CAPS: Capability[] = [
  ...VIEWER_CAPS,
  "manage_members",
  "manage_roles",
];
/** What a contractor's role is authored with; its scope removes the team-wide part. */
export const SCOPED_CAPS: Capability[] = [
  "view",
  "create_apps",
  "deploy_apps",
  "configure_apps",
  "manage_env",
  "view_logs",
];
export const SOLO_GRANT: Capability[] = [
  "deploy_apps",
  "configure_apps",
  "manage_env",
  "view_logs",
];

/** The live fixture: assigned in `before`, re-seeded in `beforeEach`. */
export const lab = {
  db: null as unknown as TestDb,
  pg: null as unknown as PGlite,
  roles: new Map<Role, string>(),
};

/** Register the lab's hooks in the calling test file. */
export function installLab(): void {
  before(async () => {
    ({ db: lab.db, pg: lab.pg } = await makeTestDb());
    __setTestDb(lab.db);
    // The stand-in runner has to settle the row: left `queued`, the lane picks it
    // up again the moment the runner returns and spins the event loop forever.
    __setRunnerForTest(async (depId) => {
      await lab.db
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
    await settle(300);
    __resetQueueForTest();
    __setAgentConnectorForTest();
    __setTeardownDialForTest(null);
    __resetDnsResolve4ForTest();
    __resetTestDb();
    await lab.pg.close();
  });

  beforeEach(seedLab);
}

async function seedLab(): Promise<void> {
  const { db, pg } = lab;
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
      { id: OWNER2, teamId: TEAM, role: "owner", isInstanceAdmin: false },
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
      {
        ...member(SYSADMIN, [...VIEWER_CAPS, "manage_tokens"], "viewer"),
        teamId: OTHER,
        isInstanceAdmin: true,
      },
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

  lab.roles = await ensureTeamRoles(getDb(), TEAM);
}

/* ------------------------------------------------------------------ */
/* Driving the schema                                                  */
/* ------------------------------------------------------------------ */

export interface Outcome {
  data: unknown;
  error?: string;
}

/** Send one document as `userId`, exactly as /api/graphql would build the context. */
export async function gql(
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
  /permission|not found|not authorized|unauthorized|can't|cannot|only |limited to|part of this team|not a member|no longer belongs|two-factor|hold yourself|isn't in this team|no active team/i;

export type Verdict = "allowed" | "refused" | "blocked";

/** "blocked" is the lab's missing host: the gate was passed and the dial failed. */
export function verdict(r: Outcome): Verdict {
  if (!r.error) return "allowed";
  if (REFUSAL.test(r.error)) return "refused";
  assert.match(
    r.error,
    /lab: no host|unreachable|not provisioned/i,
    `an unexpected non-permission error: ${r.error}`,
  );
  return "blocked";
}

export function refused(r: Outcome, why: string): void {
  assert.equal(verdict(r), "refused", `${why} - got: ${r.error ?? "ok"}`);
}
export function passed(r: Outcome, why: string): void {
  assert.notEqual(verdict(r), "refused", `${why} - refused: ${r.error}`);
}

/** What `app(slug:)` answered: the id, or null for "not found". */
export function appLookup(r: Outcome): string | null {
  assert.equal(r.error, undefined, r.error);
  return (r.data as { app: { id: string } | null }).app?.id ?? null;
}

/** The ids a list query answered with. */
export function ids(r: Outcome, field: string): string[] {
  assert.equal(r.error, undefined, r.error);
  const rows = (r.data as Record<string, { id: string }[] | null>)[field];
  return (rows ?? []).map((x) => x.id).sort();
}

/** The field a mutation answered with, asserting it did not fail. */
export function field<T>(r: Outcome, name: string): T {
  assert.equal(r.error, undefined, r.error);
  return (r.data as Record<string, T>)[name];
}

export const Q = {
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
        appId
        message
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
  folderGrants: /* GraphQL */ `
    query ($folderId: ID!) {
      folderGrants(folderId: $folderId) {
        userId
        capabilities
      }
    }
  `,
  search: /* GraphQL */ `
    query ($q: String!) {
      search(q: $q, kinds: [app]) {
        apps {
          id
        }
      }
    }
  `,
};

export const M = {
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
  deleteApps: /* GraphQL */ `
    mutation ($ids: [ID!]!) {
      deleteApps(ids: $ids)
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
  deleteFolder: /* GraphQL */ `
    mutation ($id: ID!, $deleteApps: Boolean) {
      deleteFolder(id: $id, deleteApps: $deleteApps)
    }
  `,
  createProject: /* GraphQL */ `
    mutation ($name: String!) {
      createProject(name: $name) {
        id
      }
    }
  `,
  deleteProject: /* GraphQL */ `
    mutation ($id: ID!) {
      deleteProject(id: $id, deleteApps: false)
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
        roleId
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
  addUserToTeam: /* GraphQL */ `
    mutation ($input: UserTeamInput!) {
      addUserToTeam(input: $input) {
        teamId
      }
    }
  `,
  removeUserFromTeam: /* GraphQL */ `
    mutation ($input: UserTeamInput!) {
      removeUserFromTeam(input: $input) {
        teamId
      }
    }
  `,
  setUserTeamAccess: /* GraphQL */ `
    mutation ($input: SetUserTeamAccessInput!) {
      setUserTeamAccess(input: $input) {
        teamId
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
  switchTeam: /* GraphQL */ `
    mutation ($teamId: String!) {
      switchTeam(teamId: $teamId)
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
        capabilities
      }
    }
  `,
  moveAppToFolder: /* GraphQL */ `
    mutation ($appId: ID!, $folderId: ID) {
      moveAppToFolder(appId: $appId, folderId: $folderId)
    }
  `,
  moveAppsToFolder: /* GraphQL */ `
    mutation ($appIds: [ID!]!, $folderId: ID) {
      moveAppsToFolder(appIds: $appIds, folderId: $folderId)
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

export const envInput = (appId: string) => ({
  input: { appId, key: "LAB_KEY", value: "1", type: "plain" },
});
export const newApp = (
  name: string,
  placement: Record<string, string> = {},
) => ({
  input: { name, source: "UPLOAD", ...placement },
});

/** An app made to be deleted, so a teardown landing later never touches a fixture. */
export async function throwawayApp(
  userId: string,
  name: string,
): Promise<string> {
  return field<{ id: string }>(
    await gql(userId, M.createApp, newApp(name)),
    "createApp",
  ).id;
}

export const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

/** Mint a token as `userId` and hand back the grant a bearer request would carry. */
export async function mintToken(
  userId: string,
  input: Record<string, unknown>,
  opts: { teamId?: string } = {},
): Promise<{ raw: string; token: TokenGrant }> {
  const { authenticateToken } = await import("../data/tokens");
  const raw = field<{ raw: string }>(
    await gql(userId, M.createToken, { input }, opts),
    "createToken",
  ).raw;
  const identity = await authenticateToken(raw, null);
  assert.ok(identity?.token, "the freshly minted token must authenticate");
  return { raw, token: identity.token };
}
