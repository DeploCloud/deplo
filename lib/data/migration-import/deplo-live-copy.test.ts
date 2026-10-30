import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { backups as backupsTable } from "../../db/schema/control-plane/backups";
import { cronJobs } from "../../db/schema/control-plane/crons";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { SERVER_1 } from "../app-graph-test-helpers";
import type {
  DeploExport,
  DeploExportApp,
  DeploExportCron,
} from "../../migration/deplo/export-shape";
import {
  deploExport,
  exportApp,
  exportDatabase,
} from "../../migration/deplo/deplo-test-helpers";
import {
  __resetDnsLookupForTest,
  __setDnsLookupForTest,
} from "../../outbound-url";
import { setAutoDeploy } from "../apps/settings";
import { releaseMigrating } from "./run-report";
import {
  asOwner,
  closeMigrationHarness,
  openMigrationHarness,
  provisionServer1,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import {
  blockingLines,
  importFromDeplo,
  reportLines,
} from "./deplo-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
  __setDnsLookupForTest(async () => [{ address: "93.184.216.34" }]);
});

after(async () => {
  __resetDnsLookupForTest();
  await closeMigrationHarness(db, pg);
});

beforeEach(async () => {
  await resetMigrationHarness(db);
  await provisionServer1(db);
  await db.execute("truncate table cron_jobs, backups cascade;");
  await db.execute(
    "truncate table backup_destination, git_connections cascade;",
  );
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: "ab".repeat(32) })
    .where(eq(serversTable.id, SERVER_1));
});

const job = (name: string): DeploExportCron => ({
  name,
  schedule: "0 3 * * *",
  command: "echo hi",
  service: null,
  enabled: true,
});

const nightly = (schedule = "0 3 * * *") => ({
  schedule,
  enabled: true,
  timezone: "UTC",
  retentionCount: 7,
  destination: "bucket",
});

function withJobs(schedules = [nightly()]): DeploExport {
  return deploExport({
    apps: [exportApp({ cronEnabled: true, crons: [job("report")] })],
    destinations: [
      {
        name: "bucket",
        endpoint: "https://s3.acme.test",
        bucket: "backups",
        region: "eu-west-1",
        accessKeyId: "AK",
        secretAccessKey: "SK",
        provider: "aws",
        ageIdentity: null,
      },
    ],
    databases: [
      exportDatabase({
        cronEnabled: true,
        crons: [job("vacuum")],
        backups: schedules,
      }),
    ],
  });
}

const switches = async () => ({
  crons: (await db.select().from(cronJobs))
    .map((j) => `${j.name}:${j.enabled}`)
    .sort(),
  backups: (await db.select().from(backupsTable))
    .map((b) => `${b.schedule}:${b.enabled}`)
    .sort(),
});

test("a copy that keeps the source running lands every job already paused, and says so", async () => {
  const runId = await importFromDeplo(
    withJobs(),
    ["prc_shop"],
    {},
    {
      liveCopy: true,
    },
  );
  const lines = (await reportLines(runId)).join("\n");
  assert.deepEqual(
    await switches(),
    { crons: ["report:false", "vacuum:false"], backups: ["0 3 * * *:false"] },
    lines,
  );
  assert.match(lines, /1 cron came across paused: web keeps running/);
  assert.match(
    lines,
    /1 cron and 1 backup schedule came across paused: main keeps running/,
  );
  assert.doesNotMatch((await blockingLines(runId)).join("\n"), /paused/);
});

test("a plain migration lands the same jobs switched on", async () => {
  await importFromDeplo(withJobs(), ["prc_shop"]);
  assert.deepEqual(await switches(), {
    crons: ["report:true", "vacuum:true"],
    backups: ["0 3 * * *:true"],
  });
});

test("a copy onto a database already here pauses the schedules it adds, not the ones it found", async () => {
  await importFromDeplo(withJobs(), ["prc_shop"]);
  const runId = await importFromDeplo(
    withJobs([nightly(), nightly("0 5 * * *")]),
    ["prc_shop"],
    {},
    { liveCopy: true },
  );
  assert.deepEqual(
    (await switches()).backups,
    ["0 3 * * *:true", "0 5 * * *:false"],
    (await reportLines(runId)).join("\n"),
  );
  assert.match(
    (await reportLines(runId)).join("\n"),
    /1 backup schedule came across paused: main keeps running/,
  );
});

const fromGitea = (): DeploExportApp =>
  exportApp({
    source: "git",
    repo: {
      provider: "gitea",
      url: "https://git.acme.com/acme/web.git",
      repo: "acme/web",
      branch: "main",
      connectionId: "gitc_src",
    },
  });

// A Gitea that answers who the token is and records every webhook call.
function giteaAnswering(): { hooks: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const prevUrl = process.env.DEPLO_PUBLIC_URL;
  process.env.DEPLO_PUBLIC_URL = "https://new.deplo.test";
  const hooks: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://git.acme.com")) return real(input, init);
    if (url.includes("/hooks")) {
      hooks.push(url);
      return Response.json(init?.method === "POST" ? { id: 1 } : []);
    }
    return Response.json({ login: "deploy" });
  }) as typeof fetch;
  return {
    hooks,
    restore: () => {
      globalThis.fetch = real;
      if (prevUrl === undefined) delete process.env.DEPLO_PUBLIC_URL;
      else process.env.DEPLO_PUBLIC_URL = prevUrl;
    },
  };
}

const giteaExport = () =>
  deploExport({
    apps: [fromGitea()],
    databases: [],
    gitConnections: [
      {
        id: "gitc_src",
        provider: "gitea",
        label: "Acme git",
        baseUrl: "https://git.acme.com",
        allowPrivateEndpoint: false,
        username: "deploy",
        token: "s3cret-token",
      },
    ],
  });

test("a plain migration adds the push webhook", async () => {
  const gitea = giteaAnswering();
  try {
    await importFromDeplo(giteaExport(), ["prc_shop"]);
  } finally {
    gitea.restore();
  }
  assert.ok(gitea.hooks.length > 0);
});

test("a copy that keeps the source running does not deploy on push, and says where to turn it on", async () => {
  const gitea = giteaAnswering();
  let runId: string;
  try {
    runId = await importFromDeplo(
      giteaExport(),
      ["prc_shop"],
      {},
      {
        liveCopy: true,
      },
    );
  } finally {
    gitea.restore();
  }
  const lines = (await reportLines(runId)).join("\n");
  assert.deepEqual(gitea.hooks, [], lines);
  const [web] = await db.select().from(appsTable);
  assert.equal(web.autoDeploy, false);
  assert.match(lines, /Deploy on push is off for this copy/);
  assert.doesNotMatch(lines, /through a webhook it adds/);

  await releaseMigrating(runId);
  const switchedOver = giteaAnswering();
  try {
    await asOwner(() => setAutoDeploy(web.id, true));
  } finally {
    switchedOver.restore();
  }
  assert.ok(switchedOver.hooks.length > 0, "turning it on adds the webhook");
});
