import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/leaf-test-helpers";
import { runWithIdentity } from "../auth/request-context";
import { createToken, authenticateToken } from "../data/tokens";
import { getCurrentUser } from "../auth";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { admitPassthrough, deniedRootFields, runGraphql } from "./execute";
import { schema } from "../graphql/schema";
import { MCP_TOOLS } from "./tools";

/**
 * The one thing in `lib/mcp` that would be catastrophic to get wrong. So if
 * `runGraphql` ever stopped wrapping `execute` in `runWithIdentity`, tools would
 * keep working, keep returning data, and quietly return it as the wrong caller.
 */

let db: TestDb;
let pg: PGlite;

const TRUNCATE = `truncate table api_tokens, users, teams restart identity cascade;`;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db);
});

/** Mint a token, authenticate it, and build the context `/api/mcp` would build. */
async function contextFor(
  capabilities: Parameters<typeof createToken>[0]["capabilities"],
) {
  const raw = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    createToken({ name: "mcp", capabilities }),
  );
  const identity = await authenticateToken(raw.raw, null);
  assert.ok(identity, "the freshly minted token must authenticate");
  return runWithIdentity(identity, async () => ({
    viewer: await getCurrentUser(),
    teamId: await getActiveTeamId(),
    capabilities: await reachableCapabilities(),
    via: "token" as const,
    identity,
  }));
}

test("a tool's document resolves as the token, in the token's team", async () => {
  const ctx = await contextFor(["view"]);
  const whoami = MCP_TOOLS.find((t) => t.name === "whoami")!;

  const { data, error } = await runGraphql(whoami.query, {}, ctx);
  assert.equal(error, undefined, error);

  const result = data as {
    apiContext: { via: string; teamId: string };
    me: { id: string } | null;
    viewerTeam: { id: string };
  };
  assert.equal(
    result.apiContext.via,
    "token",
    "the request must read as token auth",
  );
  assert.equal(result.apiContext.teamId, TEAM_A);
  assert.equal(result.me?.id, USER_1, "resolved as the token's creator");
  assert.equal(result.viewerTeam.id, TEAM_A);
});

test("a capability the token was not granted is refused, not silently allowed", async () => {
  // `view` only: the token may look, and nothing else.
  const ctx = await contextFor(["view"]);
  const del = MCP_TOOLS.find((t) => t.name === "delete_app")!;

  const { data, error } = await runGraphql(del.query, { id: "prj_nope" }, ctx);
  assert.ok(
    error || (data as { deleteApp?: unknown } | null)?.deleteApp !== true,
    "deleting an app with a view-only token must not succeed",
  );
});

test("the team hint decides which team a document resolves in", async () => {
  // USER_1 belongs to TEAM_A only, so TEAM_B is unreachable and the hint must be
  // ignored rather than honoured - a token can never be talked into a team its
  // creator has no membership in.
  const raw = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    createToken({ name: "mcp", capabilities: ["view"] }),
  );
  const identity = await authenticateToken(raw.raw, TEAM_B);
  assert.ok(identity);
  assert.equal(
    identity.teamId,
    TEAM_A,
    "an unreachable hint falls back, never through",
  );
});

/* ------------------------------------------------------------------ *
 * The escape hatch's door
 * ------------------------------------------------------------------ */

/**
 * `tools.test.ts` enforces ADR-0021 rule 4 by scanning each row's `query`, and
 * the passthrough's is empty - so the rule is only as real as these tests.
 */

const refusal = (query: string, kind: "query" | "mutation" = "query") => {
  try {
    admitPassthrough(query, kind);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

test("the passthrough refuses every field that hands back a credential", () => {
  for (const field of deniedRootFields()) {
    const root =
      schema.getMutationType()!.getFields()[field] ??
      schema.getQueryType()!.getFields()[field];
    assert.ok(root, `${field} is not a root field any more - stale entry`);
    const kind = schema.getMutationType()!.getFields()[field]
      ? "mutation"
      : "query";
    // The guard runs before validation, so a bare field name is enough and the
    // assertion cannot pass on some unrelated complaint.
    const message = refusal(`${kind} X { ${field} }`, kind);
    assert.match(
      message,
      /cannot be run over MCP/,
      `${field} was admitted: ${message || "no error"}`,
    );
  }
});

test("every reveal* root field is denied without being listed by hand", () => {
  const reveals = [
    ...Object.keys(schema.getQueryType()!.getFields()),
    ...Object.keys(schema.getMutationType()!.getFields()),
  ].filter((n) => /^reveal[A-Z]/.test(n));
  assert.ok(reveals.length > 0, "the schema has no reveal* fields to derive");
  for (const name of reveals)
    assert.ok(deniedRootFields().has(name), `${name} is not denied`);
});

test("a denied field is refused from inside a fragment too", () => {
  const message = refusal(
    `mutation X { ...F } fragment F on Mutation { revealRegistrationLink }`,
    "mutation",
  );
  assert.match(message, /cannot be run over MCP/);
});

test("a field that merely shares a denied name is not refused", () => {
  // `login` is a denied root mutation. The guard reads the PARENT TYPE, so a
  // field called `login` on some object would still be readable.
  const guard = deniedRootFields();
  assert.ok(guard.has("login"));
  assert.equal(refusal(`query X { apps { id slug } }`), "");
});

test("graphql_query refuses a mutation, and graphql_mutate refuses a query", () => {
  assert.match(
    refusal(`mutation M { deleteApp(id: "x") }`, "query"),
    /runs query operations only/,
  );
  assert.match(
    refusal(`query Q { apps { id } }`, "mutation"),
    /runs mutation operations only/,
  );
});

test("a subscription is refused, whichever passthrough it arrives at", () => {
  assert.match(
    refusal(`subscription S { activeDeployments }`, "query"),
    /Subscriptions cannot be run over MCP/,
  );
});

test("a second operation cannot ride along behind the first", () => {
  assert.match(
    refusal(`query A { apps { id } } mutation B { deleteApp(id: "x") }`),
    /runs query operations only/,
  );
});

test("the passthrough carries /api/graphql's own depth limit", () => {
  let q = "id";
  for (let i = 0; i < 16; i++) q = `apps { ${q} }`;
  assert.match(refusal(`query Deep { ${q} }`), /depth|Cannot query field/i);
});

test("an unknown field is a refusal, not a silently empty answer", () => {
  // Unvalidated, graphql-js drops the field and answers `{"apps":[{}]}`, which
  // reads to a model as "that field is empty" rather than "you misspelled it".
  assert.match(refusal(`query X { apps { naem } }`), /Cannot query field/);
});
