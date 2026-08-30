// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
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

import { makeTestDb, type TestDb } from "../db/test-harness";
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
  apps as appsTable,
} from "../db/schema/control-plane";
import { schema } from "./schema";
import { type GraphQLContext } from "./context";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { seedIdentity, TEAM_A, TEAM_B } from "../data/identity-test-helpers";
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
 * The CROSS-TEAM matrix: every field of the public API, driven by a bearer token
 * that authenticated into team ALPHA holding nothing but `view`, aimed squarely at
 * team BETA's ids - a team its creator owns outright.
 */

let db: TestDb;
let pg: PGlite;
const T0 = "2026-01-01T00:00:00.000Z";
/** Owner of alpha; also a full-capability member of beta. */
const BOTH = "u_both";
const MEM_IN_B = "mem_both_in_b";

const B = {
  app: "prj_beta",
  slug: "beta-app",
  folder: "fld_beta",
  project: "prc_beta",
  envVar: "env_beta",
  domainId: "dom_beta",
  domain: "beta.example.com",
  deployment: "dpl_beta",
  basicAuth: "bau_beta",
};

const TRUNCATE_ALL = `DO $$ DECLARE r record; BEGIN
  FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
    EXECUTE format('truncate table public.%I restart identity cascade', r.tablename);
  END LOOP; END $$;`;

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
  await pg.exec(TRUNCATE_ALL);
  await seedIdentity(db, {
    users: [
      { id: BOTH, teamId: TEAM_A, role: "owner", isInstanceAdmin: false },
    ],
  });
  await db.insert(membershipsTable).values({
    id: MEM_IN_B,
    userId: BOTH,
    teamId: TEAM_B,
    role: "owner",
    createdAt: T0,
  });
  await db.insert(membershipCapabilitiesTable).values(
    ALL_CAPABILITIES.map((capability) => ({
      membershipId: MEM_IN_B,
      capability,
    })),
  );
  await seedServer(db);
  await db.insert(projectsTable).values({
    id: B.project,
    teamId: TEAM_B,
    name: "Beta project",
    slug: "beta-project",
    ownerUserId: BOTH,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(foldersTable).values({
    id: B.folder,
    teamId: TEAM_B,
    name: "Beta folder",
    ownerUserId: BOTH,
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(db, {
    id: B.app,
    slug: B.slug,
    teamId: TEAM_B,
    folderId: B.folder,
  });
  await seedDeployment(db, { id: B.deployment, appId: B.app, status: "ready" });
  await db.insert(envVarsTable).values({
    id: B.envVar,
    appId: B.app,
    key: "BETA_SECRET",
    valueEnc: encryptSecret("s3cr3t"),
    type: "plain",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(domainsTable).values({
    id: B.domainId,
    appId: B.app,
    name: B.domain,
    isPrimary: true,
    ssl: false,
    status: "valid",
    createdAt: T0,
  });
  await db.insert(basicAuthTable).values({
    id: B.basicAuth,
    appId: B.app,
    username: "betauser",
    passwordEnc: encryptSecret("pw"),
    createdAt: T0,
    updatedAt: T0,
  });
}

/* ------------------------------------------------------------------ */
/* Document generation (one per schema field, every arg filled)        */
/* ------------------------------------------------------------------ */

const BY_ARG: Record<string, string> = {
  appId: B.app,
  appIds: B.app,
  folderId: B.folder,
  folderIds: B.folder,
  projectId: B.project,
  projectIds: B.project,
  slug: B.slug,
  userId: BOTH,
  teamId: TEAM_B,
};

function bareIdFor(field: string): string | null {
  const m = field.toLowerCase();
  if (m.includes("folder")) return B.folder;
  if (m.includes("project")) return B.project;
  if (m.includes("deployment")) return B.deployment;
  if (m.includes("basicauth")) return B.basicAuth;
  if (m.includes("domain")) return B.domainId;
  if (m.includes("env")) return B.envVar;
  if (m.includes("app")) return B.app;
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
 * Skipped by name, and each for a reason that is not "it fails": - the auth verbs
 * own the session itself and take no team; - `deleteTeam` / `deleteUser` /
 * `removeUserFromTeam` tear down the fixture the remaining documents are measured
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
  "removeUserFromTeam",
  "removeMember",
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

/* ------------------------------------------------------------------ */
/* Principals                                                          */
/* ------------------------------------------------------------------ */

/** A bearer token minted in ALPHA, granted `view` and nothing else. */
const READ_ONLY_IN_ALPHA: RequestIdentity = {
  userId: BOTH,
  teamId: TEAM_A,
  token: {
    id: "tok_readonly",
    capabilities: ["view"],
    scope: null,
    instanceAdmin: false,
  },
};

/** The control: beta's own owner over a cookie session. */
const OWNER_IN_BETA: RequestIdentity = { userId: BOTH, teamId: TEAM_B };

async function principalFor(identity: RequestIdentity) {
  const ctx = await runWithIdentity(
    identity,
    async (): Promise<GraphQLContext> => ({
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: identity.token ? "token" : "cookie",
      identity: identity.token ? identity : null,
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

/** Everything of beta's a mutation could plausibly move. */
async function snapshot(): Promise<string> {
  const rows = await Promise.all([
    db.select().from(appsTable).where(eq(appsTable.teamId, TEAM_B)),
    db.select().from(foldersTable).where(eq(foldersTable.teamId, TEAM_B)),
    db.select().from(projectsTable).where(eq(projectsTable.teamId, TEAM_B)),
    db.select().from(envVarsTable).where(eq(envVarsTable.appId, B.app)),
    db.select().from(domainsTable).where(eq(domainsTable.appId, B.app)),
    db.select().from(basicAuthTable).where(eq(basicAuthTable.appId, B.app)),
    db
      .select()
      .from(folderGrantsTable)
      .where(eq(folderGrantsTable.folderId, B.folder)),
    db
      .select()
      .from(membershipCapabilitiesTable)
      .where(eq(membershipCapabilitiesTable.membershipId, MEM_IN_B)),
  ]);
  return JSON.stringify(rows);
}

test("a read-only token can't move ANY of another team's records", async () => {
  const touched: string[] = [];
  for (const m of docsFor("mutation")) {
    await seedAll();
    const intruder = await principalFor(READ_ONLY_IN_ALPHA);
    const before = await snapshot();
    await run(intruder, m.doc);
    if ((await snapshot()) !== before) touched.push(m.name);
  }
  assert.deepEqual(
    touched,
    [],
    `a bearer token holding only \`view\` in alpha wrote to team beta through: ${touched.join(", ")}`,
  );
});

test("the sweep can see: beta's own owner moves the same fixture", async () => {
  const moved: string[] = [];
  for (const m of docsFor("mutation")) {
    await seedAll();
    const owner = await principalFor(OWNER_IN_BETA);
    const before = await snapshot();
    await run(owner, m.doc);
    if ((await snapshot()) !== before) moved.push(m.name);
  }
  assert.ok(
    moved.length > 5,
    `the generated mutations barely write anything even as the owner (${moved.length}: ${moved.join(", ")}), so the intruder sweep proves nothing`,
  );
});

const SENTINELS = [
  B.app,
  B.slug,
  B.folder,
  B.project,
  B.envVar,
  B.domain,
  B.deployment,
];

test("nor read another team's records back", async () => {
  await seedAll();
  const intruder = await principalFor(READ_ONLY_IN_ALPHA);
  const leaks: string[] = [];
  for (const q of docsFor("query")) {
    const res = await run(intruder, q.doc);
    const body = JSON.stringify(res.data ?? {});
    const hit = SENTINELS.filter((s) => body.includes(s));
    if (hit.length > 0) leaks.push(`${q.name} → ${hit.join(", ")}`);
  }
  assert.deepEqual(
    leaks,
    [],
    `these queries handed team beta's records to a token scoped to alpha: ${leaks.join(" | ")}`,
  );
});
