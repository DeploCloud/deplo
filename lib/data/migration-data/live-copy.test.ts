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

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { SERVER_1 } from "../app-graph-test-helpers";
import { __setMigrationFetchForTest } from "../../migration/transport";
import { __resetDeploExportsForTest } from "../../migration/deplo/client";
import {
  deploExport,
  exportApp,
  exportDatabase,
} from "../../migration/deplo/deplo-test-helpers";
import { beginMigration } from "../migration-import/run-lifecycle";
import { moveMigrationServiceData } from "./move";

const SOURCE = {
  url: "https://old.deplo.test",
  apiKey: "deplo_abcdefghijklmnopqrstuvwxyz",
  kind: "deplo" as const,
};

const DUMP = Buffer.from("age-encrypted dump of blink-db");

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
  databases: [exportDatabase({ id: "src_db", name: "blink-db" })],
});

const panel = {
  asked: [] as string[],
  dumpRequests: [] as Record<string, unknown>[],
  dumpRefusal: "",
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
      if (Array.isArray(body.check))
        return json({ reachable: true, present: body.check });
      if (body.dump === true) {
        panel.asked.push(`dump:${body.id}`);
        panel.dumpRequests.push(body);
        if (panel.dumpRefusal)
          return new Response(JSON.stringify({ error: panel.dumpRefusal }), {
            status: 400,
          });
        return new Response(new Uint8Array(DUMP), { status: 200 });
      }
      panel.asked.push(`stream:${body.volume ?? body.hostPath}`);
      return new Response(new Uint8Array(UPLOADS), { status: 200 });
    }
    const query = String(body.query ?? "");
    if (query.includes("migrationExport"))
      return json({ data: { migrationExport: EXPORT } });
    if (query.includes("runtime"))
      return json({ data: { runtime: { running: 1, unreachable: false } } });
    if (/stopApp|setDatabaseRunning/.test(query)) {
      panel.asked.push(`stop:${(body.variables as { id: string }).id}`);
      return json({ data: {} });
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
  state.agentCapabilities = ["host-path-copy.file", "backup", "backup-store"];
  panel.asked = [];
  panel.dumpRequests = [];
  panel.dumpRefusal = "";
});

async function liveRun(): Promise<string> {
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
    {
      sourceKind: "postgres",
      sourceId: "src_db",
      sourceName: "blink-db",
      targetKind: "database",
      targetId: "db_blink",
    },
  ]);
  return runId;
}

const copyLive = (runId: string, sourceKind: string, sourceId: string) =>
  asOwner(() =>
    moveMigrationServiceData({
      ...SOURCE,
      runId,
      sourceKind,
      sourceId,
      liveCopy: true,
    }),
  );

async function reportOf(runId: string): Promise<string[]> {
  return (
    await getDb()
      .select({ message: itemsTable.message })
      .from(itemsTable)
      .where(eq(itemsTable.runId, runId))
  ).map((r) => r.message ?? "");
}

test("a copy without stopping leaves the app serving over there and says the copy is live", async () => {
  const runId = await liveRun();
  const res = await copyLive(runId, "application", "src_web");
  assert.equal(res.failed, 0, res.notes.join(" | "));
  assert.equal(res.moved, 1);
  assert.equal(panel.asked.includes("stop:src_web"), false);
  assert.deepEqual(state.volumes[SERVER_1]["deplo-blink-web-uploads"], UPLOADS);
  const report = (await reportOf(runId)).join("\n");
  assert.match(
    report,
    /kept running on Deplo at old.deplo.test while it was read/,
  );
  assert.match(report, /still serves on Deplo at old.deplo.test/);
  assert.doesNotMatch(report, /stopped on both sides/);
});

test("a database copied without stopping comes over as a dump encrypted to a key only this side holds", async () => {
  const runId = await liveRun();
  const res = await copyLive(runId, "postgres", "src_db");
  assert.equal(res.failed, 0, res.notes.join(" | "));
  assert.equal(res.moved, 1);
  assert.deepEqual(panel.asked, ["dump:src_db"]);
  assert.match(String(panel.dumpRequests[0].recipient), /^age1/);
  assert.equal(state.restored.length, 1);
  assert.equal(state.restored[0].serverId, SERVER_1);
  assert.deepEqual(state.restored[0].bytes, DUMP);
  const header = state.restored[0].header as {
    ageIdentity: string;
    database?: { container: string };
  };
  assert.match(header.ageIdentity, /^AGE-SECRET-KEY-1/);
  assert.equal(header.database?.container, "db-blink-db");
  assert.equal(
    state.agentCalls.some((c) => c.includes(":stop:")),
    false,
    "the database here keeps running to take the dump",
  );
  const report = (await reportOf(runId)).join("\n");
  assert.match(report, /blink-db is up on the copied data - 7 tables/);
  assert.match(report, /snapshot of blink-db taken while it kept running/);
  assert.match(report, /still serves on Deplo at old.deplo.test/);
});

test("a dump that does not restore fails the copy and stops nothing over there", async () => {
  state.restoreRefusal = "pg_restore: error: could not read input file";
  const runId = await liveRun();
  const res = await copyLive(runId, "postgres", "src_db");
  assert.equal(res.moved, 0);
  assert.equal(res.failed, 1);
  assert.equal(panel.asked.includes("stop:src_db"), false);
  assert.match(res.notes.join(" "), /could not read input file/);
});

test("an old Deplo that cannot dump says so and stops nothing", async () => {
  panel.dumpRefusal = "Name a volume or a host path.";
  const runId = await liveRun();
  const res = await copyLive(runId, "postgres", "src_db");
  assert.equal(res.failed, 1);
  assert.equal(panel.asked.includes("stop:src_db"), false);
  assert.match(
    res.notes.join(" "),
    /old.deplo.test is too old to hand over a database while it keeps running/,
  );
});
