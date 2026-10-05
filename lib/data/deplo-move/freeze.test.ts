import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { folders } from "../../db/schema/control-plane/projects";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { runWithIdentity } from "../../auth/request-context";
import { authenticateToken } from "../tokens/authenticate";
import { createToken } from "../tokens/mint";
import { getCurrentUser } from "../../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../../membership";
import { runGraphql } from "../../mcp/execute";
import { MCP_TOOLS } from "../../mcp/tools/catalog";
import { schema } from "../../graphql/schema";
import {
  FREEZE_ALLOWED_MUTATIONS,
  instanceFrozen,
  invalidateFrozen,
  refuseWhileFrozen,
} from "./freeze";
import { POST as bootstrap } from "@/app/api/agent/bootstrap/route";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const NEW = "https://new.example";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  invalidateFrozen();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table deplo_moves, folders, api_tokens, activities,
    users, teams restart identity cascade;`);
  await seedIdentity(db);
  invalidateFrozen();
});

async function move(side: "source" | "target", state: string) {
  await db.insert(deploMoves).values({
    id: `dmv_${side}_${state}`,
    side,
    state,
    peerUrl: NEW,
    startedBy: "user_1",
    createdAt: T0,
    updatedAt: T0,
  });
  invalidateFrozen();
}

async function tokenContext() {
  const raw = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    createToken({ name: "mcp", capabilities: ["view", "create_folders"] }),
  );
  const identity = await authenticateToken(raw.raw, null);
  assert.ok(identity);
  return runWithIdentity(identity, async () => ({
    viewer: await getCurrentUser(),
    teamId: await getActiveTeamId(),
    capabilities: await reachableCapabilities(),
    via: "token" as const,
    identity,
  }));
}

const createFolder = MCP_TOOLS.find((t) => t.name === "create_folder")!;

test("only a new Deplo mid-copy freezes, never the old one", async () => {
  for (const [side, state] of [
    ["source", "armed"],
    ["source", "bound"],
    ["source", "copying"],
    ["source", "done"],
    ["source", "cancelled"],
    ["target", "connected"],
    ["target", "deploying"],
    ["target", "done"],
    ["target", "cancelled"],
    ["target", "failed"],
  ] as const)
    await move(side, state);
  await db.update(deploMoves).set({ rowsCopied: 12 });
  invalidateFrozen();
  assert.equal(
    await instanceFrozen(),
    null,
    "a failed copy that already landed rows no longer holds changes",
  );

  await db.delete(deploMoves);
  await move("target", "copying");
  assert.deepEqual(await instanceFrozen(), {
    state: "copying",
    peerUrl: NEW,
    message: `A Deplo is being copied here from ${NEW}. Changes are paused until its data is in.`,
  });
});

test("the answer is cached until invalidated", async () => {
  assert.equal(await instanceFrozen(), null);
  await db.insert(deploMoves).values({
    id: "dmv_quiet",
    side: "target",
    state: "copying",
    peerUrl: NEW,
    startedBy: "user_1",
    createdAt: T0,
    updatedAt: T0,
  });
  assert.equal(await instanceFrozen(), null, "served from the cache");
  invalidateFrozen();
  assert.ok(await instanceFrozen());
});

test("a mutation is refused while frozen, on the schema MCP runs too", async () => {
  const ctx = await tokenContext();
  const ok = await runGraphql(createFolder.query, { name: "Before" }, ctx);
  assert.equal(ok.error, undefined, ok.error ?? "");

  await move("target", "copying");
  const res = await runGraphql(createFolder.query, { name: "During" }, ctx);
  assert.match(
    res.error ?? "",
    /A Deplo is being copied here from https:\/\/new\.example/,
  );
  const names = (await db.select({ name: folders.name }).from(folders)).map(
    (f) => f.name,
  );
  assert.deepEqual(names, ["Before"], "the refused mutation wrote nothing");

  const whoami = MCP_TOOLS.find((t) => t.name === "whoami")!;
  const read = await runGraphql(whoami.query, {}, ctx);
  assert.equal(read.error, undefined, "reads keep working");
});

test("an allowlisted mutation is never refused by the freeze", async () => {
  const fields = schema.getMutationType()!.getFields();
  const moveOwn = /Move(Code)?$/;
  for (const name of FREEZE_ALLOWED_MUTATIONS)
    if (!moveOwn.test(name)) assert.ok(fields[name], `no mutation ${name}`);

  const ctx = await tokenContext();
  await move("target", "copying");
  const res = await runGraphql("mutation { logout }", {}, ctx);
  assert.doesNotMatch(res.error ?? "", /being copied/);
});

test("a REST write answers 503 with the sentence", async () => {
  assert.equal(await refuseWhileFrozen(), null);
  await move("target", "copying");
  const res = await bootstrap(
    new Request("http://deplo.test/api/agent/bootstrap", {
      method: "POST",
      body: "{}",
    }),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: `A Deplo is being copied here from ${NEW}. Changes are paused until its data is in.`,
  });
});
