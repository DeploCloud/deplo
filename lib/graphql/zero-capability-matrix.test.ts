import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import {
  graphql,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLOutputType,
} from "graphql";

process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, truncateAll, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  appBasicAuthUsers as basicAuthTable,
  domains as domainsTable,
  envVars as envVarsTable,
  folders as foldersTable,
  folderGrants as folderGrantsTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projects as projectsTable,
  teamRoles as teamRolesTable,
  teams as teamsTable,
  apiTokens as apiTokensTable,
  apps as appsTable,
} from "../db/schema/control-plane";
import { schema } from "./schema";
import { type GraphQLContext } from "./context";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { seedIdentity, TEAM_A } from "../data/identity-test-helpers";
import {
  seedApp,
  seedServer,
  seedDeployment,
} from "../data/app-graph-test-helpers";
import { ALL_CAPABILITIES } from "../types";
import { encryptSecret } from "../crypto";
import {
  __setRunnerForTest,
  __resetQueueForTest,
} from "../deploy/deploy-queue";

/**
 * The ROLE FLOOR: every field of the public API, driven by a real member of the
 * team whose role grants nothing at all.
 */

let db: TestDb;
let pg: PGlite;
const T0 = "2026-01-01T00:00:00.000Z";
const OWNER = "u_owner";
const NOBODY = "u_nobody";

const F = {
  app: "prj_fixture",
  slug: "fixture-app",
  folder: "fld_fixture",
  project: "prc_fixture",
  envVar: "env_fixture",
  domainId: "dom_fixture",
  domain: "fixture.example.com",
  deployment: "dpl_fixture",
  basicAuth: "bau_fixture",
  token: "tok_fixture",
};

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setRunnerForTest(async () => {});
});

after(async () => {
  __resetQueueForTest();
  __resetTestDb();
  await pg.close();
});

async function seedAll(): Promise<void> {
  await truncateAll(pg);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: NOBODY, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  // NOBODY holds nothing. Not even `view` as a row: it is the implied floor.
  await db.delete(membershipCapabilitiesTable);
  await db.insert(membershipCapabilitiesTable).values(
    ALL_CAPABILITIES.map((capability) => ({
      membershipId: `mem_${OWNER}`,
      capability,
    })),
  );
  await seedServer(db);
  await db.insert(projectsTable).values({
    id: F.project,
    teamId: TEAM_A,
    name: "Fixture project",
    slug: "fixture-project",
    ownerUserId: OWNER,
    createdAt: T0,
    updatedAt: T0,
  });
  // A TOP-LEVEL folder owned by nobody in particular: a folder the zero-capability
  // member can see is the interesting case (folder privacy would otherwise mask
  // every missing capability check behind "you can't see it anyway").
  await db.insert(foldersTable).values({
    id: F.folder,
    teamId: TEAM_A,
    name: "Fixture folder",
    ownerUserId: NOBODY,
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(db, { id: F.app, slug: F.slug, teamId: TEAM_A });
  await seedDeployment(db, { id: F.deployment, appId: F.app, status: "ready" });
  await db.insert(envVarsTable).values({
    id: F.envVar,
    appId: F.app,
    key: "FIXTURE_SECRET",
    valueEnc: encryptSecret("s3cr3t"),
    type: "plain",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(domainsTable).values({
    id: F.domainId,
    appId: F.app,
    name: F.domain,
    isPrimary: true,
    ssl: false,
    status: "valid",
    createdAt: T0,
  });
  await db.insert(basicAuthTable).values({
    id: F.basicAuth,
    appId: F.app,
    username: "fixtureuser",
    passwordEnc: encryptSecret("pw"),
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(apiTokensTable).values({
    id: F.token,
    userId: OWNER,
    name: "Fixture token",
    prefix: "deplo_fixtur",
    tokenHash: "deadbeef",
    instanceAdmin: false,
    scoped: false,
    lastUsedAt: null,
    createdAt: T0,
  });
}

/* ------------------------------------------------------------------ */
/* Document generation                                                 */
/* ------------------------------------------------------------------ */

const BY_ARG: Record<string, string> = {
  appId: F.app,
  appIds: F.app,
  folderId: F.folder,
  folderIds: F.folder,
  projectId: F.project,
  projectIds: F.project,
  slug: F.slug,
  userId: OWNER,
  teamId: TEAM_A,
  tokenId: F.token,
};

function bareIdFor(field: string): string | null {
  const m = field.toLowerCase();
  if (m.includes("token")) return F.token;
  if (m.includes("folder")) return F.folder;
  if (m.includes("project")) return F.project;
  if (m.includes("deployment")) return F.deployment;
  if (m.includes("basicauth")) return F.basicAuth;
  if (m.includes("domain")) return F.domainId;
  if (m.includes("env")) return F.envVar;
  if (m.includes("member") || m.includes("user")) return OWNER;
  if (m.includes("app")) return F.app;
  return null;
}

function literal(
  type: GraphQLInputType,
  argName: string,
  field: string,
  depth = 0,
): string {
  if (isNonNullType(type)) return literal(type.ofType, argName, field, depth);
  if (isListType(type))
    return `[${literal(type.ofType, argName, field, depth)}]`;
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
          (argName === "id" || argName === "ids" ? bareIdFor(field) : null);
        return `"${mapped ?? "zzz_nonexistent"}"`;
      }
    }
  }
  if (isInputObjectType(type)) {
    if (depth > 3) return "{}";
    return `{${Object.values(type.getFields())
      .map((f) => `${f.name}: ${literal(f.type, f.name, field, depth + 1)}`)
      .join(", ")}}`;
  }
  return "null";
}

function deepSelection(type: GraphQLOutputType, depth = 0): string {
  if (isNonNullType(type) || isListType(type))
    return deepSelection((type as { ofType: GraphQLOutputType }).ofType, depth);
  if (!isObjectType(type)) return "";
  const parts: string[] = ["__typename"];
  for (const f of Object.values(type.getFields())) {
    if (f.args.some((a) => isNonNullType(a.type))) continue;
    const inner = deepSelection(f.type, depth + 1);
    if (inner) {
      if (depth >= 2) continue;
      parts.push(`${f.name}${inner}`);
    } else parts.push(f.name);
  }
  return ` { ${parts.join(" ")} }`;
}

/**
 * Skipped by name.
 */
const SKIP = new Set([
  "me",
  "apiContext",
  "login",
  "logout",
  "completeSetup",
  "registerThroughLink",
  "verifyTwoFactorLogin",
  "switchTeam",
  "deleteTeam",
  "deleteUser",
  "updateAccount",
  "changePassword",
  "startTwoFactorEnrollment",
  "confirmTwoFactorEnrollment",
  "disableTwoFactor",
  "regenerateRecoveryCodes",
  "revokeSession",
  "revokeOtherSessions",
  "markNotificationsRead",
  "dismissNotification",
  // Starting your OWN team is not a capability in anyone else's team - the
  // creator becomes its owner, and nothing of the seeded team moves.
  "createTeam",
]);

function docsFor(kind: "query" | "mutation") {
  const type =
    kind === "query" ? schema.getQueryType()! : schema.getMutationType()!;
  return Object.values(type.getFields())
    .filter((f) => !SKIP.has(f.name))
    .map((f) => {
      const field = f as GraphQLField<unknown, unknown>;
      const args = field.args.length
        ? `(${field.args.map((a) => `${a.name}: ${literal(a.type, a.name, field.name)}`).join(", ")})`
        : "";
      return {
        name: field.name,
        doc: `${kind} { ${field.name}${args}${deepSelection(field.type)} }`,
      };
    });
}

async function principalFor(userId: string) {
  const identity: RequestIdentity = { userId, teamId: TEAM_A };
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

async function run(
  p: { ctx: GraphQLContext; identity: RequestIdentity },
  doc: string,
) {
  return (await Promise.race([
    runWithIdentity(p.identity, () =>
      graphql({ schema, source: doc, contextValue: p.ctx }),
    ),
    new Promise((r) => setTimeout(() => r({}), 15_000)),
  ])) as { data?: unknown; errors?: readonly { message: string }[] };
}

/** Everything a mutation could plausibly move, plus the authz backbone itself. */
const WATCHED = [
  appsTable,
  foldersTable,
  projectsTable,
  envVarsTable,
  domainsTable,
  basicAuthTable,
  folderGrantsTable,
  membershipsTable,
  membershipCapabilitiesTable,
  teamRolesTable,
  teamsTable,
  apiTokensTable,
];

async function snapshot(): Promise<string> {
  return JSON.stringify(
    await Promise.all(WATCHED.map((t) => db.select().from(t))),
  );
}

/** The same snapshot with one table left out - see the carve-out below. */
async function snapshotWithout(
  excluded: (typeof WATCHED)[number],
): Promise<string> {
  return JSON.stringify(
    await Promise.all(
      WATCHED.filter((t) => t !== excluded).map((t) => db.select().from(t)),
    ),
  );
}

/**
 * Mutations a member with NO capability may still write through, and why. Only a
 * write to the actor's OWN preferences belongs here, never anything another
 * member, another team, or an authorization check can read.
 */
const OWN_PREFERENCES_ONLY = ["reorderMyTeams"];

test("a member holding no capability can't move a single row", async () => {
  const touched: string[] = [];
  for (const m of docsFor("mutation")) {
    if (OWN_PREFERENCES_ONLY.includes(m.name)) continue;
    await seedAll();
    const nobody = await principalFor(NOBODY);
    const before = await snapshot();
    await run(nobody, m.doc);
    if ((await snapshot()) !== before) touched.push(m.name);
  }
  assert.deepEqual(
    touched,
    [],
    `a member whose role grants nothing wrote through: ${touched.join(", ")}`,
  );
});

test("the carve-out is real: each exempted mutation still only touches its own actor", async () => {
  // A guard on the guard.
  for (const name of OWN_PREFERENCES_ONLY) {
    const m = docsFor("mutation").find((d) => d.name === name);
    assert.ok(m, `${name} is exempted but is not a mutation`);
    await seedAll();
    const nobody = await principalFor(NOBODY);
    const before = await snapshotWithout(membershipsTable);
    await run(nobody, m!.doc);
    assert.equal(
      await snapshotWithout(membershipsTable),
      before,
      `${name} is exempted as a personal preference but touched other tables`,
    );
  }
});

test("the sweep can see: the owner moves the same fixture", async () => {
  const moved: string[] = [];
  for (const m of docsFor("mutation")) {
    await seedAll();
    const owner = await principalFor(OWNER);
    const before = await snapshot();
    await run(owner, m.doc);
    if ((await snapshot()) !== before) moved.push(m.name);
  }
  assert.ok(
    moved.length > 10,
    `the generated mutations barely write anything even as the owner (${moved.length}), so the sweep proves nothing`,
  );
});

test("and never reads a secret back", async () => {
  await seedAll();
  const nobody = await principalFor(NOBODY);
  const leaks: string[] = [];
  for (const q of docsFor("query")) {
    const res = await run(nobody, q.doc);
    const body = JSON.stringify(res.data ?? {});
    if (body.includes("s3cr3t")) leaks.push(q.name);
  }
  assert.deepEqual(
    leaks,
    [],
    `these queries revealed a secret to a member with no capability: ${leaks.join(", ")}`,
  );
});
