import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { deploymentScreenshots } from "../../db/schema/control-plane/deployments";
import {
  CaptureOutcome,
  type CaptureScreenshotResponse,
} from "../../agent/gen/agent";
import { runWithIdentity } from "../../auth/request-context";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { seedIdentity, TEAM_A, TEAM_B } from "../identity-test-helpers";
import {
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
  seedApp,
  seedDeployment,
  seedServer,
} from "../app-graph-test-helpers";
import { setAppScreenshots } from "../apps/settings";
import {
  getDeploymentScreenshot,
  readDeploymentScreenshotImage,
  retakeDeploymentScreenshot,
} from "./screenshot";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const OWNER = "u_owner";
const VIEWER = "u_viewer";
const STRANGER = "u_stranger";
const APP = "prj_shot";
const DEP = "dpl_live";
const OLD = "dpl_old";
const LIGHT = Buffer.from("RIFF0000WEBPlight");

let respond: () => CaptureScreenshotResponse;

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({ capabilities: ["screenshot"] }),
        captureScreenshot: async () => respond(),
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
  respond = () => ({
    outcome: CaptureOutcome.CAPTURE_OUTCOME_OK,
    httpStatus: 200,
    lightWebp: LIGHT,
    darkWebp: new Uint8Array(),
    detail: "",
  });
  await pg.exec(
    `truncate table deployment_screenshots restart identity cascade;`,
  );
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(
    `truncate table membership_capabilities, memberships, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: VIEWER, teamId: TEAM_A, role: "member", capabilities: ["view"] },
      { id: STRANGER, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A, slug: "shop" });
  await seedDeployment(db, { id: OLD, appId: APP, serverId: SERVER_1 });
  await seedDeployment(db, {
    id: DEP,
    appId: APP,
    serverId: SERVER_1,
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  await db
    .update(appsTable)
    .set({ latestDeploymentId: DEP })
    .where(eq(appsTable.id, APP));
  await db.insert(deploymentScreenshots).values([
    { deploymentId: DEP, light: LIGHT, dark: null, capturedAt: T0 },
    { deploymentId: OLD, light: LIGHT, dark: null, capturedAt: T0 },
  ]);
});

test("a picture is visible at the view floor, and to nobody outside the team", async () => {
  const mine = await as(VIEWER, TEAM_A, () => getDeploymentScreenshot(DEP));
  assert.ok(mine);
  assert.match(
    mine.lightUrl,
    /^\/api\/deployments\/dpl_live\/screenshot\?v=\d+&theme=light$/,
  );
  assert.equal(mine.darkUrl, null);
  assert.equal(mine.current, true);
  assert.equal(
    (await as(VIEWER, TEAM_A, () => getDeploymentScreenshot(OLD)))?.current,
    false,
  );
  assert.equal(
    await as(STRANGER, TEAM_B, () => getDeploymentScreenshot(DEP)),
    null,
  );
  assert.equal(
    await as(STRANGER, TEAM_B, () =>
      readDeploymentScreenshotImage(DEP, "light"),
    ),
    null,
  );
  // The image route runs under the deployment's own team; a stranger is refused there too.
  await assert.rejects(
    as(STRANGER, TEAM_A, () => readDeploymentScreenshotImage(DEP, "light")),
  );
});

test("a missing dark picture falls back to the light one", async () => {
  const img = await as(OWNER, TEAM_A, () =>
    readDeploymentScreenshotImage(DEP, "dark"),
  );
  assert.deepEqual(img && Buffer.from(img), LIGHT);
});

test("retaking needs configure_apps and only works on the live deployment", async () => {
  await assert.rejects(
    as(VIEWER, TEAM_A, () => retakeDeploymentScreenshot(DEP)),
    /permission/,
  );
  await assert.rejects(
    as(STRANGER, TEAM_B, () => retakeDeploymentScreenshot(DEP)),
    /not found/i,
  );
  await assert.rejects(
    as(OWNER, TEAM_A, () => retakeDeploymentScreenshot(OLD)),
    /Only the deployment that is live/,
  );
  await as(OWNER, TEAM_A, () => retakeDeploymentScreenshot(DEP));
});

test("a failed retake says why and keeps the previous picture", async () => {
  respond = () => ({
    outcome: CaptureOutcome.CAPTURE_OUTCOME_HTTP_ERROR,
    httpStatus: 502,
    lightWebp: new Uint8Array(),
    darkWebp: new Uint8Array(),
    detail: "",
  });
  await assert.rejects(
    as(OWNER, TEAM_A, () => retakeDeploymentScreenshot(DEP)),
    /answered with an error \(502\)/,
  );
  const [row] = await db
    .select()
    .from(deploymentScreenshots)
    .where(eq(deploymentScreenshots.deploymentId, DEP));
  assert.ok(row, "the old picture stays");
});

test("turning screenshots off deletes every saved one", async () => {
  await as(OWNER, TEAM_A, () => setAppScreenshots(APP, false));
  assert.equal((await db.select().from(deploymentScreenshots)).length, 0);
  await assert.rejects(
    as(OWNER, TEAM_A, () => retakeDeploymentScreenshot(DEP)),
    /turned off/,
  );
  await assert.rejects(
    as(VIEWER, TEAM_A, () => setAppScreenshots(APP, true)),
    /permission/,
  );
});
