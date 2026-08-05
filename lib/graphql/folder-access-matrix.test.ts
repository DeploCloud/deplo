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
  appBasicAuthUsers as basicAuthTable,
  domains as domainsTable,
  envVars as envVarsTable,
  folders as foldersTable,
  membershipCapabilities as membershipCapabilitiesTable,
  apps as appsTable,
} from "../db/schema/control-plane";
import { schema } from "./schema";
import { type GraphQLContext } from "./context";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { seedIdentity, TEAM_A } from "../data/identity-test-helpers";
import { seedApp, seedServer, seedDeployment } from "../data/app-graph-test-helpers";
import { ALL_CAPABILITIES } from "../types";
import { encryptSecret } from "../crypto";
import { __setRunnerForTest, __resetQueueForTest } from "../deploy/deploy-queue";
import { eq } from "drizzle-orm";

/**
 * The PRIVATE-FOLDER matrix: every field of the public API, driven by a member
 * who holds every team capability there is, against an app inside a folder that
 * is not theirs.
 *
 * This is ADR-0016's central promise stated as a test — "holding a TEAM
 * capability is NOT enough to act on an app inside a folder: you also need that
 * capability ON THE FOLDER" — and it is a promise every app-shaped resolver has
 * to keep individually. `requireAppCapability` folds the team check, the
 * ownership check and the folder gate into one call precisely so that no call
 * site has to remember all three; this file is what notices when one of them
 * reaches for `requireCapability` instead. It found `appTransferInfo`, which
 * disclosed the app's name, its server, its counts and — through `homeLabel` —
 * the name of the private folder itself.
 *
 * The intruder deliberately does NOT hold `manage_team`: that capability makes
 * its holder a folder super-user in its own right, which is the documented
 * design and would mask every other question.
 *
 * Reads are checked against sentinels that exist only inside that app, with a
 * CONTROL run as the folder's owner — a sweep that finds nothing proves nothing
 * until you know the queries return something when they should. Writes are
 * checked on effect, with the fixture rebuilt between mutations so one can't
 * mask the next.
 */

let db: TestDb;
let pg: PGlite;
const T0 = "2026-01-01T00:00:00.000Z";
const OWNER = "u_folderowner";
const INTRUDER = "u_intruder";

const P = {
  app: "prj_private_teamx",
  slug: "private-teamx",
  folder: "fld_private_teamx",
  envVar: "env_private_teamx",
  domain: "private-teamx.example.com",
  deployment: "dpl_private_teamx",
  basicAuth: "bau_private_teamx",
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

async function seedAll(): Promise<void> {
  await pg.exec(TRUNCATE_ALL);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: INTRUDER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  // The INTRUDER holds EVERY team capability except `manage_team`, which makes
  // its holder a folder super-user in its own right and would mask the question.
  await db.delete(membershipCapabilitiesTable);
  await db.insert(membershipCapabilitiesTable).values([
    ...ALL_CAPABILITIES.map((capability) => ({
      membershipId: `mem_${OWNER}`,
      capability,
    })),
    ...ALL_CAPABILITIES.filter((c) => c !== "manage_team").map((capability) => ({
      membershipId: `mem_${INTRUDER}`,
      capability,
    })),
  ]);
  await seedServer(db);
  await db.insert(foldersTable).values({
    id: P.folder,
    teamId: TEAM_A,
    name: "Private",
    ownerUserId: OWNER,
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(db, { id: P.app, slug: P.slug, teamId: TEAM_A });
  await db.update(appsTable).set({ folderId: P.folder }).where(eq(appsTable.id, P.app));
  await seedDeployment(db, { id: P.deployment, appId: P.app, status: "ready" });
  await db.insert(envVarsTable).values({
    id: P.envVar,
    appId: P.app,
    key: "SECRET_KEY",
    valueEnc: encryptSecret("s3cr3t"),
    type: "plain",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(domainsTable).values({
    id: "dom_private_teamx",
    appId: P.app,
    name: P.domain,
    isPrimary: true,
    ssl: false,
    status: "valid",
    createdAt: T0,
  });
  await db.insert(basicAuthTable).values({
    id: P.basicAuth,
    appId: P.app,
    username: "privateuser",
    passwordEnc: encryptSecret("pw"),
    createdAt: T0,
    updatedAt: T0,
  });
}

after(async () => {
  __resetQueueForTest();
  __resetTestDb();
  await pg.close();
});

const BY_ARG: Record<string, string> = {
  appId: P.app,
  appIds: P.app,
  folderId: P.folder,
  folderIds: P.folder,
  slug: P.slug,
};

function bareIdFor(field: string): string | null {
  const m = field.toLowerCase();
  if (m.includes("folder")) return P.folder;
  if (m.includes("deployment")) return P.deployment;
  if (m.includes("basicauth")) return P.basicAuth;
  if (m.includes("domain")) return "dom_private_teamx";
  if (m.includes("env")) return P.envVar;
  if (m.includes("app")) return P.app;
  return null;
}

function literal(
  type: GraphQLInputType,
  argName: string,
  field: string,
  depth = 0,
): string {
  if (isNonNullType(type)) return literal(type.ofType, argName, field, depth);
  if (isListType(type)) return `[${literal(type.ofType, argName, field, depth)}]`;
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

function docsFor(kind: "query" | "mutation") {
  const type = kind === "query" ? schema.getQueryType()! : schema.getMutationType()!;
  return Object.values(type.getFields())
    .filter((f) => !["me", "apiContext", "login", "logout", "completeSetup", "registerThroughLink", "verifyTwoFactorLogin", "deleteTeam", "deleteUser", "removeUserFromTeam", "removeMember"].includes(f.name))
    .map((f) => {
      const field = f as GraphQLField<unknown, unknown>;
      const args = field.args.length
        ? `(${field.args.map((a) => `${a.name}: ${literal(a.type, a.name, field.name)}`).join(", ")})`
        : "";
      return {
        name: field.name,
        doc: `${kind} { ${field.name}${args}${kind === "query" ? deepSelection(field.type) : deepSelection(field.type)} }`,
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

async function run(p: { ctx: GraphQLContext; identity: RequestIdentity }, doc: string) {
  return (await Promise.race([
    runWithIdentity(p.identity, () =>
      graphql({ schema, source: doc, contextValue: p.ctx }),
    ),
    new Promise((r) => setTimeout(() => r({}), 15_000)),
  ])) as { data?: unknown; errors?: readonly { message: string }[] };
}

const SENTINELS = [P.app, P.slug, P.folder, P.envVar, P.domain, P.deployment, P.basicAuth];

test("no query hands the private folder's app to a member without access", async () => {
  await seedAll();
  const intruder = await principalFor(INTRUDER);
  const leaks: string[] = [];
  for (const q of docsFor("query")) {
    const res = await run(intruder, q.doc);
    const body = JSON.stringify(res.data ?? {});
    const hit = SENTINELS.filter((s) => body.includes(s));
    if (hit.length > 0) leaks.push(`${q.name} → ${hit.join(", ")}`);
  }
  const owner = await principalFor(OWNER);
  const seen = new Set<string>();
  for (const q of docsFor("query")) {
    const res = await run(owner, q.doc);
    const body = JSON.stringify(res.data ?? {});
    for (const s of SENTINELS) if (body.includes(s)) seen.add(s);
  }
  assert.deepEqual(
    [...seen].sort(),
    [...SENTINELS].sort(),
    "the sweep can't prove anything: the folder's own owner didn't surface every sentinel, so the generated queries are not reading enough",
  );
  assert.deepEqual(
    leaks,
    [],
    `these queries handed a private folder's app to a member with no access: ${leaks.join(" | ")}`,
  );
});

async function snapshot(): Promise<string> {
  const rows = await Promise.all([
    db.select().from(appsTable).where(eq(appsTable.id, P.app)),
    db.select().from(envVarsTable).where(eq(envVarsTable.appId, P.app)),
    db.select().from(domainsTable).where(eq(domainsTable.appId, P.app)),
    db.select().from(basicAuthTable).where(eq(basicAuthTable.appId, P.app)),
    db.select().from(foldersTable).where(eq(foldersTable.id, P.folder)),
  ]);
  return JSON.stringify(rows);
}

test("no mutation touches the private folder's app", async () => {
  const touched: string[] = [];
  for (const m of docsFor("mutation")) {
    await seedAll();
    const intruder = await principalFor(INTRUDER);
    const before = await snapshot();
    await run(intruder, m.doc);
    if ((await snapshot()) !== before) touched.push(m.name);
  }
  assert.deepEqual(
    touched,
    [],
    `these mutations reached into a folder the caller can't see: ${touched.join(", ")}`,
  );
});
