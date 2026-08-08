import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-hook-x-"));
process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  deployments as deploymentsTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedApp, seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { createToken } from "./tokens";
import { revealDeployHook } from "./deploy-hook";
import { __setRunnerForTest, __resetQueueForTest } from "../deploy/deploy-queue";
import { ALL_CAPABILITIES, type Capability } from "../types";

import { POST } from "@/app/api/apps/[id]/deploy-hook/[token]/route";

/**
 * The deploy hook, driven by a token whose creator is a member of BOTH teams.
 *
 * The existing route tests use a stranger - someone who belongs to the other
 * team and nothing else - which the team check catches on its own. The sharper
 * question is the person in two teams at once: their token authenticated into
 * ALPHA holding nothing but `view`, and the URL points at BETA's app, where they
 * personally deploy all day. If the hook resolved WHO before it resolved WHERE,
 * the token's clamp would go silent (it keys on the (user, team) pair) and the
 * hook would deploy as the person instead of as the credential.
 *
 * It does not, because `owningTeamId(appId)` is passed as the team hint BEFORE
 * the token is authenticated - the hook re-teams into the app's own team, so the
 * clamp lands on the team that actually matters. These tests pin that ordering
 * down: it is the property the folder gate turned out not to have.
 */

let db: TestDb;
let pg: PGlite;

const APP_IN_BETA = "prj_beta_hooked";
/** Owner of alpha AND a deploying member of beta. */
const BOTH = "user_both";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setRunnerForTest(async (depId) => {
    await db
      .update(deploymentsTable)
      .set({ status: "success" })
      .where(eq(deploymentsTable.id, depId));
  });
});

after(async () => {
  await new Promise((r) => setTimeout(r, 100));
  __resetQueueForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table api_tokens, projects, activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: BOTH, teamId: TEAM_A, role: "owner" },
      { id: USER_1, teamId: TEAM_B, role: "owner" },
    ],
  });
  // The same person, deploying in beta too.
  await db.insert(membershipsTable).values({
    id: "mem_both_in_b",
    userId: BOTH,
    teamId: TEAM_B,
    role: "member",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(membershipCapabilitiesTable).values(
    (["view", "deploy_apps", "configure_apps", "manage_tokens"] as Capability[]).map((capability) => ({
      membershipId: "mem_both_in_b",
      capability,
    })),
  );
  await seedServer(db);
  await seedApp(db, { id: APP_IN_BETA, teamId: TEAM_B, slug: "beta-hooked" });
});

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId }, fn);

async function hookToken(): Promise<string> {
  const url = await as(BOTH, TEAM_B, () => revealDeployHook(APP_IN_BETA));
  return url.slice(url.lastIndexOf("/") + 1);
}

async function mint(
  teamId: string,
  capabilities: Capability[],
  scope: Record<string, string[]> = {},
): Promise<string> {
  const { raw } = await as(BOTH, teamId, () =>
    createToken({ name: `hook-${teamId}`, capabilities, ...scope }),
  );
  return raw;
}

async function fire(urlToken: string, bearer: string) {
  const req = new Request(
    `https://deplo.test/api/apps/${APP_IN_BETA}/deploy-hook/${urlToken}`,
    { method: "POST", headers: { Authorization: `Bearer ${bearer}` } },
  );
  const res = await POST(req, {
    params: Promise.resolve({ id: APP_IN_BETA, token: urlToken }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deploymentCount(): Promise<number> {
  return (await db.select().from(deploymentsTable)).length;
}

test("a read-only token minted in alpha can't fire beta's hook, though its creator deploys there", async () => {
  const urlToken = await hookToken();
  const bearer = await mint(TEAM_A, ["view", "manage_tokens"]);
  const res = await fire(urlToken, bearer);
  assert.notEqual(res.status, 200, `the hook deployed: ${JSON.stringify(res.body)}`);
  assert.equal(await deploymentCount(), 0);
});

test("a token narrowed to alpha's own tree can't fire beta's hook either", async () => {
  const urlToken = await hookToken();
  // Every capability, but its reach is pinned to ALPHA as a whole. Breadth in one
  // team is not reach into another.
  const bearer = await mint(TEAM_A, [...ALL_CAPABILITIES], { teamIds: [TEAM_A] });
  const res = await fire(urlToken, bearer);
  assert.notEqual(res.status, 200, `the hook deployed: ${JSON.stringify(res.body)}`);
  assert.equal(await deploymentCount(), 0);
});

test("the same person's beta token, holding deploy_apps, does fire it", async () => {
  const urlToken = await hookToken();
  const bearer = await mint(TEAM_B, ["view", "deploy_apps"]);
  const res = await fire(urlToken, bearer);
  assert.equal(res.status, 200, `expected a queued deploy, got ${JSON.stringify(res.body)}`);
  assert.equal(await deploymentCount(), 1);
});
