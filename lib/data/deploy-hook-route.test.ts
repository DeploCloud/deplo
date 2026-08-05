import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-hook-"));
// Set BEFORE the module loads: with a configured public URL the hook never has
// to reach for request headers, which is what makes it drivable from here.
process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  apps as appsTable,
  deployments as deploymentsTable,
  folders as foldersTable,
  projects as projectsTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedApp, seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { createToken } from "./tokens";
import { revealDeployHook, setDeployHookEnabled } from "./deploy-hook";
import { setFolderGrant } from "./folder-access";
import {
  __setRunnerForTest,
  __resetQueueForTest,
  __laneSnapshotForTest,
} from "../deploy/deploy-queue";
import { SERVER_1 } from "./app-graph-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../types";

import { GET, POST } from "@/app/api/apps/[id]/deploy-hook/[token]/route";

/**
 * The deploy hook END TO END - the HTTP handler, not the helpers under it.
 *
 * It is the one route in the product authenticated by API token instead of the
 * session cookie, which makes it the only place where a URL someone pasted into
 * GitLab / a CI runner / a registry decides whether a deploy happens. Two
 * secrets have to line up (the URL's last segment says WHICH app, the bearer
 * token says WHO), and then the ordinary gates still apply: the token's own
 * capabilities, its creator's live ones, the app's folder, the two-factor
 * policy. Every one of those is asserted here through a real `Request`.
 *
 * The other half - that a wrong URL and an unknown app are indistinguishable -
 * matters just as much: a hook URL is handed to third parties, so the endpoint
 * must never become an oracle for which app ids exist.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const APP = "prj_hooked";
const VIEWER = "user_viewer";
const DEPLOYER = "user_deployer";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // A hook that passes every gate really does queue a deploy, and the real
  // runner would dial an agent that isn't there. The runner seam stands in for
  // the build and settles the row, so the queue drains instead of re-picking it.
  __setRunnerForTest(async (depId) => {
    await db
      .update(deploymentsTable)
      .set({ status: "success" })
      .where(eq(deploymentsTable.id, depId));
  });
});

after(async () => {
  // The queue re-drains its lane once a deploy finishes (`startOne`'s finally),
  // so give that last pass a tick to run while the database is still there -
  // otherwise it fails on a torn-down fixture and re-arms itself on a timer,
  // which keeps the test process alive forever.
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
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: DEPLOYER, teamId: TEAM_A, role: "member", capabilities: ["view", "deploy_apps", "manage_tokens"] },
      { id: VIEWER, teamId: TEAM_A, role: "member", capabilities: ["view", "manage_tokens"] },
      { id: "user_other", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A, slug: "hooked" });
});

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId }, fn);

/** The secret last segment of the hook URL, minted on first reveal. */
async function hookToken(appId = APP): Promise<string> {
  const url = await as(USER_1, TEAM_A, () => revealDeployHook(appId));
  return url.slice(url.lastIndexOf("/") + 1);
}

async function mint(
  userId: string,
  teamId: string,
  capabilities: Capability[],
  scope: Record<string, string[]> = {},
): Promise<string> {
  const { raw } = await as(userId, teamId, () =>
    createToken({ name: `hook-${userId}`, capabilities, ...scope }),
  );
  return raw;
}

interface HookCall {
  status: number;
  body: Record<string, unknown>;
}

async function post(
  appId: string,
  token: string,
  bearer: string | null,
): Promise<HookCall> {
  const res = await POST(
    new Request(`https://deplo.test/api/apps/${appId}/deploy-hook/${token}`, {
      method: "POST",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
    { params: Promise.resolve({ id: appId, token }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/* ------------------------------------------------------------------ */
/* The two secrets                                                     */
/* ------------------------------------------------------------------ */

test("a hook URL with no API token deploys nothing, however right the URL is", async () => {
  const token = await hookToken();
  const res = await post(APP, token, null);
  assert.equal(res.status, 401);
  assert.match(String(res.body.error), /API token/i);
  assert.equal(await deploymentCount(), 0);
});

test("a bearer that isn't a live token is refused, and says nothing about the app", async () => {
  const token = await hookToken();
  for (const bad of ["deplo_made_up_token", "not-even-a-token", ""]) {
    const res = await post(APP, token, bad);
    assert.equal(res.status, 401, `"${bad}" must not authenticate`);
  }
  assert.equal(await deploymentCount(), 0);
});

test("a valid API token with the wrong URL token deploys nothing", async () => {
  await hookToken(); // mint one, then present a different secret
  const bearer = await mint(DEPLOYER, TEAM_A, ["deploy_apps"]);
  const res = await post(APP, "wrong-secret", bearer);
  assert.equal(res.status, 404);
  assert.equal(await deploymentCount(), 0);
});

test("an unknown app and a wrong secret answer identically - the hook is no oracle", async () => {
  const token = await hookToken();
  const bearer = await mint(DEPLOYER, TEAM_A, ["deploy_apps"]);
  const unknown = await post("prj_does_not_exist", token, bearer);
  const wrong = await post(APP, "wrong-secret", bearer);
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, wrong.body, "the two answers must be the same");
});

/* ------------------------------------------------------------------ */
/* The capability still decides                                        */
/* ------------------------------------------------------------------ */

test("a token without deploy_apps is refused even holding the right URL", async () => {
  const token = await hookToken();
  const bearer = await mint(VIEWER, TEAM_A, ["view"]);
  const res = await post(APP, token, bearer);
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /permission/i);
  assert.equal(await deploymentCount(), 0);
});

test("a token granted deploy_apps by someone who doesn't hold it is refused", async () => {
  const token = await hookToken();
  // The viewer can only mint what they hold - so the token is minted by the
  // deployer and then the CREATOR loses the capability, live.
  const bearer = await mint(DEPLOYER, TEAM_A, ["deploy_apps"]);
  await pg.exec(
    `delete from membership_capabilities where membership_id = 'mem_${DEPLOYER}' and capability = 'deploy_apps';`,
  );
  const res = await post(APP, token, bearer);
  assert.equal(res.status, 403);
  assert.equal(await deploymentCount(), 0);
});

test("a token scoped to another project can't see the app at all", async () => {
  const token = await hookToken();
  await db.insert(projectsTable).values({
    id: "prc_elsewhere",
    teamId: TEAM_A,
    name: "Elsewhere",
    slug: "elsewhere",
    createdAt: T0,
    updatedAt: T0,
  });
  const bearer = await mint(DEPLOYER, TEAM_A, ["deploy_apps"], {
    projectIds: ["prc_elsewhere"],
  });
  const res = await post(APP, token, bearer);
  assert.equal(res.status, 404, "out of scope answers exactly like not there");
  assert.equal(await deploymentCount(), 0);
});

test("another team's token can't fire this app's hook", async () => {
  const token = await hookToken();
  const bearer = await mint("user_other", TEAM_B, ALL_CAPABILITIES);
  const res = await post(APP, token, bearer);
  assert.equal(res.status, 404);
  assert.equal(await deploymentCount(), 0);
});

test("the kill switch refuses the right token, and says how to turn it back on", async () => {
  const token = await hookToken();
  await as(USER_1, TEAM_A, () => setDeployHookEnabled(APP, false));
  const bearer = await mint(DEPLOYER, TEAM_A, ["deploy_apps"]);
  const res = await post(APP, token, bearer);
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /turned off/i);
  assert.equal(await deploymentCount(), 0);
});

test("an unmet two-factor policy stops the hook and names the policy", async () => {
  const token = await hookToken();
  const bearer = await mint(DEPLOYER, TEAM_A, ["deploy_apps"]);
  await db
    .update(teamsTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamsTable.id, TEAM_A));
  const res = await post(APP, token, bearer);
  assert.equal(res.status, 401);
  assert.match(String(res.body.error), /two-factor/i);
  assert.equal(await deploymentCount(), 0);
});

/* ------------------------------------------------------------------ */
/* What it does when everything lines up                               */
/* ------------------------------------------------------------------ */

test("GET explains itself instead of deploying, whatever the URL says", async () => {
  const token = await hookToken();
  const res = await GET();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "POST");
  assert.match(String(((await res.json()) as { error: string }).error), /POST/);
  assert.equal(await deploymentCount(), 0, `a GET on ${token.slice(0, 4)}… deployed nothing`);
});

test("rotating the URL kills the old one over HTTP too", async () => {
  const old = await hookToken();
  const { rotateDeployHook } = await import("./deploy-hook");
  const fresh = (await as(USER_1, TEAM_A, () => rotateDeployHook(APP))).split("/").pop()!;
  assert.notEqual(old, fresh);
  const bearer = await mint(DEPLOYER, TEAM_A, ["deploy_apps"]);
  assert.equal((await post(APP, old, bearer)).status, 404);
  assert.equal(await deploymentCount(), 0);
});

test("the right token and the right permission queue a deploy", async () => {
  const token = await hookToken();
  const bearer = await mint(DEPLOYER, TEAM_A, ["deploy_apps"]);
  const res = await post(APP, token, bearer);
  assert.equal(res.status, 200, `hook refused: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.appId, APP);
  assert.equal(typeof res.body.deploymentId, "string");
  const rows = await db
    .select({ id: deploymentsTable.id, creator: deploymentsTable.creator })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.appId, APP));
  assert.equal(rows.length, 1, "exactly one deployment was queued");
  assert.equal(
    rows[0].creator,
    DEPLOYER,
    "the deploy is attributed to the member the token acts as, not to nobody",
  );
  // Wait for the queue to actually dispatch it (the stub settles the row), so
  // the fixture isn't torn down under a pump that would then retry forever.
  for (let i = 0; i < 200; i++) {
    const [row] = await db
      .select({ status: deploymentsTable.status })
      .from(deploymentsTable)
      .where(eq(deploymentsTable.id, rows[0].id));
    if (row?.status !== "queued") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(
    __laneSnapshotForTest(SERVER_1).running,
    [],
    "the deploy was dispatched and the server lane freed",
  );
});

async function deploymentCount(): Promise<number> {
  return (await db.select({ id: deploymentsTable.id }).from(deploymentsTable)).length;
}

test("a hook can't reach into a folder its token's creator can't see", async () => {
  // The URL secret is minted BEFORE the app is filed away, which is how a leaked
  // link outlives the access that produced it: the folder is the gate that has
  // to catch up, and `redeploy`'s app gate is where it does.
  const token = await hookToken();
  await db.insert(foldersTable).values({
    id: "fld_private",
    teamId: TEAM_A,
    name: "Private",
    parentId: null,
    color: null,
    ownerUserId: USER_1,
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .update(appsTable)
    .set({ folderId: "fld_private" })
    .where(eq(appsTable.id, APP));

  // DEPLOYER holds team `deploy_apps` but nothing on the folder, so the app is
  // not theirs to see — and a hook is never more than the person behind it.
  const bearer = await mint(DEPLOYER, TEAM_A, ["view", "deploy_apps"]);
  const res = await post(APP, token, bearer);
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /not found|permission/i);
  assert.equal(await deploymentCount(), 0);

  // A grant on the folder is what makes the same call work again.
  await as(USER_1, TEAM_A, () =>
    setFolderGrant("fld_private", DEPLOYER, ["deploy_apps"]),
  );
  assert.equal((await post(APP, token, bearer)).status, 200);
});
