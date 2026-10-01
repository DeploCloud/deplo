import {
  asOwner,
  closeHarness,
  openHarness,
  resetHarness,
  seedRunItems,
  state,
  UPLOADS,
} from "./migration-data-test-helpers";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { SERVER_1 } from "../app-graph-test-helpers";
import { __setMigrationFetchForTest } from "../../migration/transport";
import { __resetDeploExportsForTest } from "../../migration/deplo/client";
import {
  deploExport,
  exportApp,
} from "../../migration/deplo/deplo-test-helpers";
import { beginMigration } from "../migration-import/run-lifecycle";
import { moveMigrationServiceData } from "./move";
import { planMigrationDataMove } from "./plan";

const SOURCE = {
  url: "https://old.deplo.test",
  apiKey: "deplo_abcdefghijklmnopqrstuvwxyz",
  kind: "deplo" as const,
};

const EXPORT = deploExport({
  apps: [
    exportApp({
      id: "src_web",
      name: "blink-web",
      slug: "old-web",
      data: {
        volumes: [
          {
            name: "deplo-old-web-uploads",
            mountPath: "/app/uploads",
            alias: "uploads",
          },
        ],
        hostMounts: [],
      },
    }),
  ],
  databases: [],
});

const panel = {
  reachable: true,
  running: true,
  asked: [] as string[],
};

function fakeDeplo() {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/api/migration/export")) {
      if (Array.isArray(body.check)) {
        panel.asked.push(`check:${body.id}`);
        return json({ reachable: panel.reachable, present: body.check });
      }
      panel.asked.push(`stream:${body.volume ?? body.hostPath}`);
      return new Response(new Uint8Array(UPLOADS), { status: 200 });
    }
    const query = String(body.query ?? "");
    if (query.includes("migrationExport"))
      return json({ data: { migrationExport: EXPORT } });
    if (query.includes("runtime"))
      return json({
        data: {
          runtime: { running: panel.running ? 1 : 0, unreachable: false },
        },
      });
    if (query.includes("stopApp")) {
      panel.asked.push(`stop:${(body.variables as { id: string }).id}`);
      panel.running = false;
      return json({ data: { stopApp: { id: "src_web" } } });
    }
    return json({ data: {} });
  };
}

before(async () => {
  await openHarness();
});

after(closeHarness);

beforeEach(async () => {
  await resetHarness();
  __resetDeploExportsForTest();
  __setMigrationFetchForTest(fakeDeplo());
  panel.reachable = true;
  panel.running = true;
  panel.asked = [];
});

async function deploRun(): Promise<string> {
  const runId = await asOwner(() =>
    beginMigration({ url: SOURCE.url, kind: "deplo" }),
  );
  await seedRunItems(runId, [
    {
      sourceKind: "application",
      sourceId: "src_web",
      sourceName: "blink-web",
      targetKind: "app",
      targetId: "prj_web",
    },
  ]);
  return runId;
}

test("the plan asks the old Deplo, not a machine Deplo would have to install on", async () => {
  const runId = await deploRun();
  const plan = await asOwner(() => planMigrationDataMove({ ...SOURCE, runId }));
  const web = plan.find((s) => s.sourceId === "src_web");
  assert.ok(web);
  assert.equal(web.sourceReachable, true);
  assert.deepEqual(
    web.volumes.map((v) => [v.sourceVolume, v.targetVolume]),
    [["deplo-old-web-uploads", "deplo-blink-web-uploads"]],
  );
  assert.deepEqual(panel.asked, ["check:src_web"]);
});

test("the copy stops the app over there and lands its bytes in the new volume", async () => {
  const runId = await deploRun();
  state.agentCalls = [];
  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...SOURCE,
      runId,
      sourceKind: "application",
      sourceId: "src_web",
    }),
  );
  assert.equal(res.failed, 0, res.notes.join(" | "));
  assert.equal(res.moved, 1);
  assert.ok(panel.asked.includes("stop:src_web"));
  assert.ok(panel.asked.includes("stream:deplo-old-web-uploads"));
  assert.deepEqual(state.volumes[SERVER_1]["deplo-blink-web-uploads"], UPLOADS);
  assert.equal(
    state.agentCalls.some((c) => c.includes(":export:")),
    false,
    "no agent of ours is asked to read the old Deplo's disk",
  );
});

test("an old Deplo that cannot reach its server stops nothing and copies nothing", async () => {
  panel.reachable = false;
  const runId = await deploRun();
  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...SOURCE,
      runId,
      sourceKind: "application",
      sourceId: "src_web",
    }),
  );
  assert.equal(res.moved, 0);
  assert.equal(res.failed, 1);
  assert.equal(panel.asked.includes("stop:src_web"), false);
  assert.match(
    res.notes.join(" "),
    /could not reach the server this service runs on/,
  );
});
