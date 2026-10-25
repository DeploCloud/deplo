import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  appPreviews,
  deploymentScreenshots,
} from "../../db/schema/control-plane/deployments";
import { appBasicAuthUsers } from "../../db/schema/control-plane/domains";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { invalidateFrozen } from "../../data/deplo-move/freeze";
import {
  CaptureOutcome,
  type CaptureScreenshotRequest,
  type CaptureScreenshotResponse,
} from "../../agent/gen/agent";
import { encryptSecret } from "../../crypto";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { seedIdentity, TEAM_A } from "../../data/identity-test-helpers";
import {
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
  seedApp,
  seedDeployment,
  seedPreview,
  seedServer,
} from "../../data/app-graph-test-helpers";
import {
  SCREENSHOT_RETRY_MS,
  captureAfterReady,
  captureDeploymentScreenshot,
  pruneScreenshots,
} from "./screenshot";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const APP = "prj_shot";
const DEP = "dpl_shot";
const LIGHT = Buffer.from("RIFF0000WEBPlight");
const DARK = Buffer.from("RIFF0000WEBPdark");

let capabilities: string[];
let calls: CaptureScreenshotRequest[];
let respond: (
  req: CaptureScreenshotRequest,
) => Promise<CaptureScreenshotResponse>;

const ok = (): CaptureScreenshotResponse => ({
  outcome: CaptureOutcome.CAPTURE_OUTCOME_OK,
  httpStatus: 200,
  lightWebp: LIGHT,
  darkWebp: DARK,
  detail: "",
});

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({ capabilities }),
        captureScreenshot: async (req: CaptureScreenshotRequest) => {
          calls.push(req);
          return respond(req);
        },
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<
          typeof import("../../infra/agent-client/connect").connectAgent
        >
      >,
  );
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  capabilities = ["screenshot"];
  calls = [];
  respond = async () => ok();
  await pg.exec(
    `truncate table deployment_screenshots, app_basic_auth_users, deplo_moves restart identity cascade;`,
  );
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(
    `truncate table membership_capabilities, memberships, users, teams restart identity cascade;`,
  );
  invalidateFrozen();
  await seedIdentity(db);
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A, slug: "shop" });
  await seedDeployment(db, { id: DEP, appId: APP, serverId: SERVER_1 });
  await db
    .update(appsTable)
    .set({
      latestDeploymentId: DEP,
      productionUrl: "https://shop.example.com/store",
    })
    .where(eq(appsTable.id, APP));
});

const shots = () => db.select().from(deploymentScreenshots);

test("a live deployment's light and dark pictures are stored", async () => {
  const res = await captureDeploymentScreenshot(DEP);
  assert.equal(res.kind, "stored");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://shop.example.com/store",
    "the production URL keeps its path",
  );
  assert.equal(
    calls[0].basicAuthUsername,
    "",
    "no credential without basic auth",
  );
  const [row] = await shots();
  assert.deepEqual(Buffer.from(row.light), LIGHT);
  assert.deepEqual(Buffer.from(row.dark!), DARK);
});

test("nothing is asked of the agent when screenshots are off, the agent is old, or the deployment is superseded", async () => {
  await db
    .update(appsTable)
    .set({ screenshotsEnabled: false })
    .where(eq(appsTable.id, APP));
  assert.deepEqual(await captureDeploymentScreenshot(DEP), {
    kind: "skipped",
    reason: "off",
  });
  await db
    .update(appsTable)
    .set({ screenshotsEnabled: true })
    .where(eq(appsTable.id, APP));

  capabilities = [];
  assert.deepEqual(await captureDeploymentScreenshot(DEP), {
    kind: "skipped",
    reason: "old-agent",
  });
  capabilities = ["screenshot"];

  await seedDeployment(db, {
    id: "dpl_newer",
    appId: APP,
    serverId: SERVER_1,
    status: "building",
  });
  await db
    .update(appsTable)
    .set({ latestDeploymentId: "dpl_newer" })
    .where(eq(appsTable.id, APP));
  assert.deepEqual(await captureDeploymentScreenshot(DEP), {
    kind: "skipped",
    reason: "not-live",
  });
  assert.equal(calls.length, 0);
  assert.equal((await shots()).length, 0);
});

test("a Deplo frozen by a move takes no picture", async () => {
  await db.insert(deploMoves).values({
    id: "dmv_frozen",
    side: "target",
    state: "copying",
    peerUrl: "https://old.example",
    startedBy: "Ada",
    createdAt: T0,
    updatedAt: T0,
  });
  invalidateFrozen();
  assert.deepEqual(await captureDeploymentScreenshot(DEP), {
    kind: "skipped",
    reason: "frozen",
  });
  assert.equal(calls.length, 0);
});

test("basic auth is answered for the team's own deployment, never for a fork's preview", async () => {
  await db.insert(appBasicAuthUsers).values({
    id: "bau_1",
    appId: APP,
    username: "ada",
    passwordEnc: encryptSecret("s3cret!"),
    createdAt: T0,
    updatedAt: T0,
  });
  await captureDeploymentScreenshot(DEP);
  assert.equal(calls[0].basicAuthUsername, "ada");
  assert.equal(calls[0].basicAuthPassword, "s3cret!");

  await seedPreview(db, {
    id: "prv_fork",
    appId: APP,
    prNumber: 7,
    isFork: true,
  });
  await seedDeployment(db, {
    id: "dpl_fork",
    appId: APP,
    serverId: SERVER_1,
    environment: "preview",
    previewId: "prv_fork",
  });
  await db
    .update(appPreviews)
    .set({ latestDeploymentId: "dpl_fork" })
    .where(eq(appPreviews.id, "prv_fork"));
  assert.deepEqual(await captureDeploymentScreenshot("dpl_fork"), {
    kind: "skipped",
    reason: "fork",
  });
  assert.equal(calls.length, 1);
});

test("a failed capture is tried once more a minute later, then left alone", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    respond = async () => ({
      ...ok(),
      outcome: CaptureOutcome.CAPTURE_OUTCOME_HTTP_ERROR,
      httpStatus: 502,
      lightWebp: new Uint8Array(),
    });
    captureAfterReady(DEP);
    await until(() => calls.length === 1);
    await flush();
    mock.timers.tick(SCREENSHOT_RETRY_MS);
    await until(() => calls.length === 2);
    await flush();
    mock.timers.tick(SCREENSHOT_RETRY_MS * 2);
    await flush();
    assert.equal(calls.length, 2, "exactly one retry");
  } finally {
    mock.timers.reset();
  }
});

test("two captures of one deployment at once make one call", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  respond = async () => {
    await gate;
    return ok();
  };
  const a = captureDeploymentScreenshot(DEP);
  const b = captureDeploymentScreenshot(DEP);
  await until(() => calls.length === 1);
  release();
  assert.deepEqual(await a, await b);
  assert.equal(calls.length, 1);
});

test("turning screenshots off while one is being taken keeps nothing", async () => {
  respond = async () => {
    await db
      .update(appsTable)
      .set({ screenshotsEnabled: false })
      .where(eq(appsTable.id, APP));
    return ok();
  };
  assert.deepEqual(await captureDeploymentScreenshot(DEP), {
    kind: "skipped",
    reason: "off",
  });
  assert.equal((await shots()).length, 0);
});

test("pruning keeps the production deployment and the 20 newest others", async () => {
  for (let i = 0; i < 25; i++) {
    const id = `dpl_${String(i).padStart(2, "0")}`;
    await seedDeployment(db, {
      id,
      appId: APP,
      serverId: SERVER_1,
      createdAt: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
    await db
      .insert(deploymentScreenshots)
      .values({ deploymentId: id, light: LIGHT, dark: null, capturedAt: T0 });
  }
  await db
    .update(appsTable)
    .set({ latestDeploymentId: "dpl_00" })
    .where(eq(appsTable.id, APP));
  await pruneScreenshots(APP);
  const kept = (await shots()).map((s) => s.deploymentId).sort();
  assert.equal(kept.length, 21);
  assert.ok(kept.includes("dpl_00"), "production is always kept");
  assert.ok(!kept.includes("dpl_01") && kept.includes("dpl_05"));
});

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 500 && !cond(); i++)
    await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "condition never held");
}
