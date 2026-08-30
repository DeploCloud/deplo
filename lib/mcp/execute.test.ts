// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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
import { runGraphql } from "./execute";
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
