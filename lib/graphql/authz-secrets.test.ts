import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { graphql, isNonNullType } from "graphql";

// Set BEFORE the data modules load: with a configured public URL the deploy
// hook never reaches for request headers, which don't exist under `node --test`.
process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { schema } from "./schema";
import type { GraphQLContext } from "./context";
import { runWithIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { upsertEnv, listEnv } from "../data/env";
import { addBasicAuthUser } from "../data/basic-auth";
import { saveSharedVar } from "../data/shared-vars";
import { revealDeployHook } from "../data/deploy-hook";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  USER_1,
} from "../data/identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../types";

/**
 * Secrets are write-only: `reveal_secrets` is a permission of its own precisely
 * so that a member who configures variables cannot read them back. That only
 * holds if NO read anywhere returns a plaintext - so this sweeps every query the
 * API exposes, as a member holding all thirty-nine OTHER permissions, and fails
 * on any response that contains a value the fixture planted.
 *
 * Where `authz-matrix.test.ts` asks "was the gate applied", this asks the
 * question a gate can't answer on its own: did the value leak through a read
 * that never needed a gate.
 */

let db: TestDb;
let pg: PGlite;

const APP = "prj_secretive";
const USER_M = "user_reader";
// Distinctive on purpose: a substring match on the response has to be unambiguous.
const ENV_SECRET = "zzz-env-plaintext-2f8a1c";
const SHARED_SECRET = "zzz-shared-plaintext-91bd47";
const BASIC_PASSWORD = "Zzz-basic-plaintext-6c30de!";
const PLANTED = [ENV_SECRET, SHARED_SECRET, BASIC_PASSWORD];

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
    `truncate table projects, activities, app_basic_auth_users, shared_env_vars restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_M, teamId: TEAM_A, role: "member", capabilities: ["view"] },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A, slug: "secretive" });
  await asOwner(async () => {
    await upsertEnv({ appId: APP, key: "API_KEY", value: ENV_SECRET, type: "secret" });
    await saveSharedVar({
      key: "SHARED_KEY",
      value: SHARED_SECRET,
      type: "secret",
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    });
    await addBasicAuthUser(APP, "gatekeeper", BASIC_PASSWORD);
    await revealDeployHook(APP); // mint the hook token so it exists to leak
  });
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

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

async function readAs(userId: string, doc: string): Promise<string> {
  return runWithIdentity({ userId, teamId: TEAM_A }, async () => {
    const ctx: GraphQLContext = {
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity: null,
    };
    const result = await graphql({ schema, source: doc, contextValue: ctx });
    // The whole payload, errors included: a message that quotes the value is a
    // leak exactly like a field that returns it.
    return JSON.stringify(result);
  });
}

/**
 * Every query in the schema, asked with the fixture's REAL ids wherever the
 * argument names one - a sweep against unreachable ids would prove nothing.
 * Fields are selected one level deep, which is where a value would surface.
 */
function everyQueryDocument(): { name: string; doc: string }[] {
  const query = schema.getQueryType()!;
  const docs: { name: string; doc: string }[] = [];
  for (const field of Object.values(query.getFields())) {
    const args = field.args
      .filter((a) => isNonNullType(a.type))
      .map((a) => `${a.name}: ${argValue(a.name, String(a.type))}`);
    const type = namedOutput(field.type);
    const selection = type ? ` { ${leafSelection(type)} }` : "";
    if (type && !selection.includes("{")) continue;
    docs.push({
      name: field.name,
      doc: `query { ${field.name}${args.length ? `(${args.join(", ")})` : ""}${selection} }`,
    });
  }
  return docs;
}

function argValue(name: string, type: string): string {
  if (/^\[/.test(type)) return `["${APP}"]`;
  if (/Boolean/.test(type)) return "true";
  if (/Int|Float/.test(type)) return "1";
  if (/^(appId|id|serviceId|projectId)/i.test(name)) return `"${APP}"`;
  if (/slug/i.test(name)) return `"secretive"`;
  return `"${APP}"`;
}

function namedOutput(type: unknown): import("graphql").GraphQLNamedType | null {
  let t = type as { ofType?: unknown; name?: string };
  while (t && "ofType" in t && t.ofType) t = t.ofType as typeof t;
  const named = t as unknown as import("graphql").GraphQLNamedType;
  return "getFields" in (named as object) ? named : null;
}

/** Select every scalar leaf of an object type - one level, no recursion. */
function leafSelection(type: import("graphql").GraphQLNamedType): string {
  const fields = (
    type as unknown as {
      getFields(): Record<string, { args: unknown[]; type: unknown }>;
    }
  ).getFields();
  const leaves = Object.entries(fields)
    .filter(([, f]) => f.args.length === 0 && !namedOutput(f.type))
    .map(([n]) => n);
  return leaves.length ? leaves.join(" ") : "__typename";
}

test("no query returns a planted secret to a member without reveal_secrets", async () => {
  await setCaps(ALL_CAPABILITIES.filter((c) => c !== "reveal_secrets"));
  const leaks: string[] = [];
  const answered: string[] = [];
  let sawTheVariable = false;
  for (const { name, doc } of everyQueryDocument()) {
    const body = await readAs(USER_M, doc);
    if (/"data":\{"[a-zA-Z]+":(?!null)/.test(body)) answered.push(name);
    if (name === "env" && body.includes("API_KEY")) sawTheVariable = true;
    for (const secret of PLANTED) if (body.includes(secret)) leaks.push(`${name} → ${secret}`);
  }
  // A sweep that reached nothing would pass while proving nothing.
  assert.ok(answered.length > 10, `only ${answered.length} queries answered at all`);
  assert.ok(sawTheVariable, "the sweep must reach the read that carries the secret");
  assert.deepEqual(leaks, [], `a read handed back a secret: ${leaks.join(", ")}`);
});

test("nor to a view-only member", async () => {
  await setCaps([]);
  const leaks: string[] = [];
  for (const { name, doc } of everyQueryDocument()) {
    const body = await readAs(USER_M, doc);
    for (const secret of PLANTED) if (body.includes(secret)) leaks.push(`${name} → ${secret}`);
  }
  assert.deepEqual(leaks, [], `a read handed back a secret: ${leaks.join(", ")}`);
});

test("the masked value is a mask, not the first characters of the secret", async () => {
  await setCaps(ALL_CAPABILITIES.filter((c) => c !== "reveal_secrets"));
  const vars = await runWithIdentity({ userId: USER_M, teamId: TEAM_A }, () =>
    listEnv(APP),
  );
  const secret = vars.find((v) => v.key === "API_KEY");
  assert.ok(secret, "the fixture variable is listed");
  assert.ok(
    !ENV_SECRET.startsWith(secret.value.replace(/[•*]/g, "").trim()) ||
      secret.value.replace(/[^•*]/g, "").length > 0,
    `the mask "${secret.value}" reveals the head of the value`,
  );
  assert.ok(!secret.value.includes(ENV_SECRET.slice(0, 8)), "no prefix of the value survives");
});

test("an env secret has no reveal at all - every capability still gets the mask", async () => {
  // `revealEnv` used to be the sanctioned read-back, gated on `reveal_secrets`.
  // It is gone: an env variable marked secret is write-only for everyone, and
  // the mask is the only answer the schema has.
  await setCaps([...ALL_CAPABILITIES]);
  const [row] = await runWithIdentity({ userId: USER_M, teamId: TEAM_A }, () =>
    listEnv(APP),
  );
  assert.equal(row.masked, true);
  assert.notEqual(row.value, ENV_SECRET);

  // And the door that used to walk around the mask: relabel the row plain while
  // sending the mask back, then read the list. Holding EVERY capability is not
  // enough, because it is not a permission question any more.
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_M, teamId: TEAM_A }, () =>
        upsertEnv({
          appId: APP,
          key: "API_KEY",
          value: row.value,
          type: "plain",
        }),
      ),
    /cannot be edited/i,
    "forty permissions must not add up to reading a secret",
  );
  const [after] = await runWithIdentity({ userId: USER_M, teamId: TEAM_A }, () =>
    listEnv(APP),
  );
  assert.equal(after.masked, true);
  assert.notEqual(after.value, ENV_SECRET);
});
