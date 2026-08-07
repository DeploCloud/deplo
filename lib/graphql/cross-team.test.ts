import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import {
  graphql,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLOutputType,
} from "graphql";

process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  domains as domainsTable,
  envVars as envVarsTable,
  environments as environmentsTable,
  folders as foldersTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projects as projectsTable,
  registries as registriesTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
} from "../db/schema/control-plane";
import { schema } from "./schema";
import { type GraphQLContext } from "./context";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../data/leaf-test-helpers";
import { seedApp, seedServer, seedDeployment } from "../data/app-graph-test-helpers";
import { seedDatabase, seedS3, seedBackup, seedRun } from "../data/backup-test-helpers";
import { ALL_CAPABILITIES } from "../types";
import { eq } from "drizzle-orm";
import { encryptSecret } from "../crypto";
import { __setRunnerForTest, __resetQueueForTest } from "../deploy/deploy-queue";

/**
 * The CROSS-TEAM matrix: every mutation and every query of the public API,
 * driven by a full-powered owner of team A, handed team B's ids.
 *
 * The sibling matrix in `authz-matrix.test.ts` asks whether a field checks the
 * right CAPABILITY, and deliberately feeds it ids that exist nowhere — so a
 * resolver that authorizes correctly but forgets to scope its query by team
 * passes it. This file asks the other half: the caller holds every capability
 * there is, and the only thing standing between them and another team's rows is
 * the team scoping itself.
 *
 * Both directions are covered, because they fail differently:
 *  - a WRITE is judged on effect, not on the error — several mutations are
 *    documented to sanitise foreign ids and return a count, so "no error" is a
 *    legitimate answer and only a changed row is a leak. Team B is fingerprinted
 *    before and after each call, with the fixture rebuilt in between so one
 *    mutation can't mask the next;
 *  - a READ is judged on the payload, against sentinel strings that exist only
 *    inside team B — with a CONTROL run as team B's own owner, because a sweep
 *    that finds nothing proves nothing until you know the queries return
 *    something when they should.
 *
 * The caller is deliberately NOT an instance admin: instance administration is
 * global by design, so an admin reaching another team is the feature and would
 * drown the signal. Servers are excluded from the sentinels for the same reason
 * — they are the one resource shared across teams (ADR-0006).
 */

let db: TestDb;
let pg: PGlite;
const T0 = "2026-01-01T00:00:00.000Z";

const TRUNCATE_ALL = `DO $$ DECLARE r record; BEGIN
  FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
    EXECUTE format('truncate table public.%I restart identity cascade', r.tablename);
  END LOOP; END $$;`;

/**
 * Team B's resources — everything an argument could name.
 *
 * The `_teamb` marker is load-bearing: the read sweep looks for these strings
 * INSIDE a JSON payload (a hostname or a slug can be embedded in a URL), and a
 * bare `role_b` would also match a freshly-minted `role_bX9k…` whose random tail
 * happens to start with a `b`. That made the sweep fail at random.
 */
const B = {
  app: "prj_teamb_app",
  project: "prc_teamb",
  folder: "fld_teamb",
  environment: "environ_teamb",
  database: "db_teamb",
  s3: "s3_teamb",
  backup: "bkp_teamb",
  run: "run_teamb",
  registry: "reg_teamb",
  role: "role_teamb",
  envVar: "env_teamb",
  domain: "dom_teamb",
  deployment: "dpl_teamb",
  user: "user_teamb",
  server: "srv_teamb",
};

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setRunnerForTest(async () => {});
});

async function seedAll(): Promise<void> {
  await pg.exec(TRUNCATE_ALL);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: B.user, teamId: TEAM_B, role: "owner" },
    ],
  });
  await db.delete(membershipCapabilitiesTable);
  await db.insert(membershipCapabilitiesTable).values(
    ALL_CAPABILITIES.flatMap((capability) => [
      { membershipId: `mem_${USER_1}`, capability },
      { membershipId: `mem_${B.user}`, capability },
    ]),
  );
  await seedServer(db);
  await seedServer(db, B.server);

  // Team A needs one of everything too, so a mutation that reads the ACTIVE
  // team first doesn't fail for an unrelated reason.
  await db.insert(projectsTable).values([
    { id: "prc_a", teamId: TEAM_A, name: "A", slug: "a", createdAt: T0, updatedAt: T0 },
    { id: B.project, teamId: TEAM_B, name: "B", slug: "b", createdAt: T0, updatedAt: T0 },
  ]);
  await db.insert(foldersTable).values([
    { id: "fld_a", teamId: TEAM_A, name: "A", createdAt: T0, updatedAt: T0 },
    { id: B.folder, teamId: TEAM_B, name: "B", ownerUserId: B.user, createdAt: T0, updatedAt: T0 },
  ]);
  await db.insert(environmentsTable).values([
    { id: "environ_a", projectId: "prc_a", name: "Prod", slug: "prod", kind: "production", gitBranch: "", isDefault: true, position: 0, createdAt: T0, updatedAt: T0 },
    { id: B.environment, projectId: B.project, name: "Prod", slug: "prod", kind: "production", gitBranch: "", isDefault: true, position: 0, createdAt: T0, updatedAt: T0 },
  ]);
  await seedApp(db, { id: "prj_a_app", slug: "a-app", teamId: TEAM_A });
  await seedApp(db, { id: B.app, slug: "b-app", teamId: TEAM_B, serverId: B.server });
  await seedDeployment(db, { id: "dpl_a", appId: "prj_a_app", status: "ready" });
  await seedDeployment(db, { id: B.deployment, appId: B.app, status: "ready" });
  await seedDatabase(db, { id: "db_a", name: "a", teamId: TEAM_A });
  await seedDatabase(db, { id: B.database, name: "b", teamId: TEAM_B, serverId: B.server });
  await seedS3(db, { id: "s3_a", teamId: TEAM_A });
  await seedS3(db, { id: B.s3, teamId: TEAM_B });
  await seedBackup(db, { id: "bkp_a", teamId: TEAM_A, databaseId: "db_a", destinationId: "s3_a" });
  await seedBackup(db, { id: B.backup, teamId: TEAM_B, databaseId: B.database, destinationId: B.s3 });
  await seedRun(db, { id: "run_a", teamId: TEAM_A, backupId: "bkp_a", databaseId: "db_a", destinationId: "s3_a" });
  await seedRun(db, { id: B.run, teamId: TEAM_B, backupId: B.backup, databaseId: B.database, destinationId: B.s3 });
  await db.insert(registriesTable).values([
    { id: "reg_a", teamId: TEAM_A, name: "a", type: "generic", registryUrl: "ghcr.io", username: "u", passwordEnc: encryptSecret("p"), createdAt: T0 },
    { id: B.registry, teamId: TEAM_B, name: "b", type: "generic", registryUrl: "ghcr.io", username: "u", passwordEnc: encryptSecret("p"), createdAt: T0 },
  ]);
  await db.insert(teamRolesTable).values([
    { id: "role_a", teamId: TEAM_A, builtinKey: null, name: "Custom A", createdAt: T0 },
    { id: B.role, teamId: TEAM_B, builtinKey: null, name: "Custom B", createdAt: T0 },
  ]);
  await db.insert(teamRoleCapabilitiesTable).values([
    { roleId: "role_a", capability: "view" },
    { roleId: B.role, capability: "view" },
  ]);
  await db.insert(envVarsTable).values([
    { id: "env_a", appId: "prj_a_app", key: "K", valueEnc: encryptSecret("v"), type: "plain", createdAt: T0, updatedAt: T0 },
    { id: B.envVar, appId: B.app, key: "K", valueEnc: encryptSecret("v"), type: "plain", createdAt: T0, updatedAt: T0 },
  ]);
  await db.insert(domainsTable).values([
    { id: "dom_a", appId: "prj_a_app", name: "a.example.com", isPrimary: true, ssl: false, status: "valid", createdAt: T0 },
    { id: B.domain, appId: B.app, name: "b.example.com", isPrimary: true, ssl: false, status: "valid", createdAt: T0 },
  ]);
  // NOT an instance admin: instance administration is global by design, and a
  // global admin reaching another team is the feature, not the leak.
  await db
    .update((await import("../db/schema/control-plane")).users)
    .set({ isInstanceAdmin: false })
    .where(eq((await import("../db/schema/control-plane")).users.id, USER_1));
}

after(async () => {
  __resetQueueForTest();
  __resetTestDb();
  await pg.close();
});

/* ------------------------------------------------------------------ */
/* Which of team B's ids an argument names                             */
/* ------------------------------------------------------------------ */

/** Argument name → the team-B id it should be handed. */
const BY_ARG: Record<string, string> = {
  appId: B.app,
  appIds: B.app,
  projectId: B.project,
  projectIds: B.project,
  folderId: B.folder,
  folderIds: B.folder,
  environmentId: B.environment,
  databaseId: B.database,
  destinationId: B.s3,
  runId: B.run,
  userId: B.user,
  serverId: B.server,
  targetId: B.database,
  roleId: B.role,
  parentId: B.folder,
  teamId: TEAM_B,
  teamIds: TEAM_B,
};

/** Mutation name → what its bare `id` / `ids` argument names. */
function bareIdFor(mutation: string): string | null {
  const m = mutation.toLowerCase();
  if (m.includes("folder")) return B.folder;
  if (m.includes("environment")) return B.environment;
  if (m.includes("project")) return B.project;
  if (m.includes("database")) return B.database;
  if (m.includes("registry")) return B.registry;
  if (m.includes("role")) return B.role;
  if (m.includes("s3")) return B.s3;
  if (m.includes("backup")) return B.backup;
  if (m.includes("deployment")) return B.deployment;
  if (m.includes("domain")) return B.domain;
  if (m.includes("env")) return B.envVar;
  if (m.includes("server")) return B.server;
  if (m.includes("user") || m.includes("member")) return B.user;
  if (m.includes("app")) return B.app;
  return null;
}

function literal(
  type: GraphQLInputType,
  argName: string,
  mutation: string,
  depth = 0,
): string {
  if (isNonNullType(type)) return literal(type.ofType, argName, mutation, depth);
  if (isListType(type)) return `[${literal(type.ofType, argName, mutation, depth)}]`;
  if (isEnumType(type)) return type.getValues()[0]?.name ?? "null";
  if (isScalarType(type)) {
    switch (type.name) {
      case "Int":
        return "1";
      case "Float":
        return "1.0";
      case "Boolean":
        return "false";
      case "JSON":
        return "{}";
      case "DateTime":
        return `"${T0}"`;
      default: {
        const mapped =
          BY_ARG[argName] ??
          (argName === "id" || argName === "ids" ? bareIdFor(mutation) : null);
        return `"${mapped ?? "zzz_nonexistent"}"`;
      }
    }
  }
  if (isInputObjectType(type)) {
    if (depth > 3) return "{}";
    return `{${Object.values(type.getFields())
      .map((f) => `${f.name}: ${literal(f.type, f.name, mutation, depth + 1)}`)
      .join(", ")}}`;
  }
  return "null";
}

function selectionFor(type: GraphQLOutputType): string {
  if (isNonNullType(type) || isListType(type)) return selectionFor(type.ofType);
  return isObjectType(type) || isInterfaceType(type) || isUnionType(type)
    ? " { __typename }"
    : "";
}

/** Mutations that are not about a foreign id at all (auth, account, setup). */
const SKIP = new Set([
  "login",
  "logout",
  "completeSetup",
  "registerThroughLink",
  "verifyTwoFactorLogin",
  "changePassword",
  "updateProfile",
  "updateEmail",
  "startTwoFactorEnrolment",
  "confirmTwoFactorEnrolment",
  "disableTwoFactor",
  "regenerateRecoveryCodes",
  "createTeam",
  "createToken",
  "createApp",
  "createDatabase",
  "createS3",
  "createRole",
  "createFolder",
  "createProject",
  "addServer",
  "addRegistry",
  "mintRegistrationLink",
  "checkForUpdates",
  "checkAgentUpdates",
  "checkAllServerHealth",
  "updateDockerCleanupPolicy",
  "runDockerCleanupNow",
  "upsertInstanceEnv",
  "testAllS3",
  "setSaveMetrics",
]);

const MUTATIONS = Object.values(schema.getMutationType()!.getFields())
  .filter((f) => !SKIP.has(f.name))
  .map((f) => {
    const field = f as GraphQLField<unknown, unknown>;
    const args = field.args.length
      ? `(${field.args
          .map((a) => `${a.name}: ${literal(a.type, a.name, field.name)}`)
          .join(", ")})`
      : "";
    return {
      name: field.name,
      doc: `mutation { ${field.name}${args}${selectionFor(field.type)} }`,
    };
  });

async function asOwnerOfA(): Promise<{ ctx: GraphQLContext; identity: RequestIdentity }> {
  const identity: RequestIdentity = { userId: USER_1, teamId: TEAM_A };
  const ctx = await runWithIdentity(
    identity,
    async (): Promise<GraphQLContext> => ({
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity: null,
    }),
  );
  return { ctx, identity };
}

/** A fingerprint of everything team B owns — any change is a cross-team write. */
async function snapshotB(): Promise<string> {
  const cp = await import("../db/schema/control-plane");
  const counts = await Promise.all([
    db.select().from(cp.apps).where(eq(cp.apps.teamId, TEAM_B)),
    db.select().from(cp.folders).where(eq(cp.folders.teamId, TEAM_B)),
    db.select().from(cp.projects).where(eq(cp.projects.teamId, TEAM_B)),
    db.select().from(cp.databases).where(eq(cp.databases.teamId, TEAM_B)),
    db.select().from(cp.s3Destination).where(eq(cp.s3Destination.teamId, TEAM_B)),
    db.select().from(cp.backups).where(eq(cp.backups.teamId, TEAM_B)),
    db.select().from(cp.registries).where(eq(cp.registries.teamId, TEAM_B)),
    db.select().from(cp.teamRoles).where(eq(cp.teamRoles.teamId, TEAM_B)),
    db.select().from(cp.memberships).where(eq(cp.memberships.teamId, TEAM_B)),
    db.select().from(cp.teams).where(eq(cp.teams.id, TEAM_B)),
    db.select().from(cp.envVars).where(eq(cp.envVars.appId, B.app)),
    db.select().from(cp.domains).where(eq(cp.domains.appId, B.app)),
    db.select().from(cp.deployments).where(eq(cp.deployments.appId, B.app)),
    db.select().from(cp.environments).where(eq(cp.environments.projectId, B.project)),
  ]);
  return JSON.stringify(counts);
}

test("no mutation touches another team's rows", async () => {
  const touched: string[] = [];
  for (const m of MUTATIONS) {
    await seedAll();
    const principal = await asOwnerOfA();
    const before = await snapshotB();
    try {
      await Promise.race([
        runWithIdentity(principal.identity, () =>
          graphql({ schema, source: m.doc, contextValue: principal.ctx }),
        ),
        new Promise((r) => setTimeout(() => r("timeout"), 15_000)),
      ]);
    } catch {
      /* a throw is a refusal */
    }
    const after = await snapshotB();
    if (before !== after) touched.push(m.name);
  }
  assert.deepEqual(
    touched,
    [],
    `these mutations wrote to team B with team A's principal: ${touched.join(", ")}`,
  );
});


/* ------------------------------------------------------------------ */
/* Reads: does any query hand back team B's data?                      */
/* ------------------------------------------------------------------ */

/** A selection deep enough to actually surface leaked values, not `__typename`. */
function deepSelection(type: GraphQLOutputType, depth = 0): string {
  if (isNonNullType(type) || isListType(type))
    return deepSelection((type as { ofType: GraphQLOutputType }).ofType, depth);
  if (!isObjectType(type)) return "";
  const fields = Object.values(type.getFields());
  const parts: string[] = ["__typename"];
  for (const f of fields) {
    if (f.args.some((a) => isNonNullType(a.type))) continue; // needs args we can't guess
    const inner = deepSelection(f.type, depth + 1);
    if (inner) {
      if (depth >= 2) continue;
      parts.push(`${f.name}${inner}`);
    } else {
      parts.push(f.name);
    }
  }
  return ` { ${parts.join(" ")} }`;
}

/** Strings that only exist inside team B. A SERVER is deliberately shared
 *  across teams (the one cross-team resource), so it is not a sentinel. */
const SENTINELS = [
  B.app,
  "b-app",
  B.project,
  B.folder,
  B.environment,
  B.database,
  B.s3,
  B.backup,
  B.run,
  B.registry,
  B.role,
  "Custom B",
  B.envVar,
  B.domain,
  "b.example.com",
  B.deployment,
  B.user,
];

const QUERIES = Object.values(schema.getQueryType()!.getFields())
  .filter((f) => !["me", "apiContext"].includes(f.name))
  .map((f) => {
    const field = f as GraphQLField<unknown, unknown>;
    const args = field.args.length
      ? `(${field.args
          .map((a) => `${a.name}: ${literal(a.type, a.name, field.name)}`)
          .join(", ")})`
      : "";
    return {
      name: field.name,
      doc: `query { ${field.name}${args}${deepSelection(field.type)} }`,
    };
  });

test("no query hands back another team's data", async () => {
  await seedAll();
  const principal = await asOwnerOfA();
  const leaks: string[] = [];
  for (const q of QUERIES) {
    let result;
    try {
      result = await Promise.race([
        runWithIdentity(principal.identity, () =>
          graphql({ schema, source: q.doc, contextValue: principal.ctx }),
        ),
        new Promise((r) => setTimeout(() => r("timeout"), 15_000)),
      ]);
    } catch {
      continue;
    }
    if (result === "timeout") continue;
    const res = result as { data?: unknown; errors?: readonly { message: string }[] };
    const invalid = (res.errors ?? []).filter((e) => !(e as { path?: unknown }).path);
    if (invalid.length > 0) {
      leaks.push(`${q.name}: INVALID DOC — ${invalid.map((x) => x.message).join("; ")}`);
      continue;
    }
    const body = JSON.stringify(res.data ?? {});
    const hit = SENTINELS.filter((sentinel) => body.includes(sentinel));
    if (hit.length > 0) leaks.push(`${q.name} → ${hit.join(", ")}`);
  }
  // THE CONTROL: the same documents, run by team B's own owner, must surface
  // those sentinels — otherwise the sweep above proves nothing about leaks, only
  // that the queries returned nothing at all.
  const owner: RequestIdentity = { userId: B.user, teamId: TEAM_B };
  const ownerCtx = await runWithIdentity(
    owner,
    async (): Promise<GraphQLContext> => ({
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity: null,
    }),
  );
  const seen = new Set<string>();
  for (const q of QUERIES) {
    try {
      const r = (await Promise.race([
        runWithIdentity(owner, () =>
          graphql({ schema, source: q.doc, contextValue: ownerCtx }),
        ),
        new Promise((res) => setTimeout(() => res({}), 15_000)),
      ])) as { data?: unknown };
      const body = JSON.stringify(r.data ?? {});
      for (const sentinel of SENTINELS) if (body.includes(sentinel)) seen.add(sentinel);
    } catch {
      /* ignore */
    }
  }
  assert.ok(
    seen.size >= SENTINELS.length - 2,
    `the sweep can't prove anything: team B's own owner only surfaced ${seen.size} of ${SENTINELS.length} sentinels (${[...seen].join(", ")}) — the generated queries are not reading enough`,
  );
  assert.deepEqual(
    leaks,
    [],
    `these queries handed team B's data to team A: ${leaks.join(" | ")}`,
  );
});
