import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { apiTokens } from "../db/schema/control-plane/api-tokens";
import { gitConnections } from "../db/schema/control-plane/integrations";
import { notificationChannels } from "../db/schema/control-plane/notifications";
import { projects, environments } from "../db/schema/control-plane/projects";
import { teams } from "../db/schema/control-plane/identity";
import { passkey } from "../db/schema/auth";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
} from "../data/identity-test-helpers";
import {
  seedApp,
  seedPreview,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { seedServerRow } from "../data/infra-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedDestination,
  TRUNCATE_BACKUPS,
} from "../data/backup-test-helpers";
import {
  captureFetch,
  type FetchCapture,
} from "../notify/fetch-capture-test-helpers";
import { usageReportState } from "../data/instance-settings/settings-store";
import { FALLBACK_AGENT_VERSION, DEPLO_VERSION } from "../version";
import { USAGE_REPORT_SCHEMA, USAGE_REPORT_URL } from "./report";
import { sendUsageReport } from "./send";

let db: TestDb;
let pg: PGlite;
let capture: FetchCapture;

const OWNER = "owner1";
const OTHER = "user2";
const NOW = new Date("2026-09-21T12:00:00.000Z");
const PROD = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_BACKUPS);
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec(
    "truncate table api_tokens, git_connections, notification_channels, passkey, projects, environments restart identity cascade;",
  );
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "acme-secret" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      {
        id: OWNER,
        teamId: TEAM_A,
        role: "owner",
        isInstanceAdmin: true,
        email: "owner@secret-company.example",
      },
      { id: OTHER, teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
    ],
  });
  await db.insert(instanceSettings).values({
    id: "default",
    ownerUserId: OWNER,
    updatedAt: NOW.toISOString(),
  });
  capture = captureFetch();
});

afterEach(() => capture.restore());

const usageCalls = () =>
  capture.calls.filter((c) => c.url === USAGE_REPORT_URL);

async function seedFleet() {
  await seedServerRow(db, {
    id: "srv_main",
    name: "prod-box-secret",
    ip: "203.0.113.10",
    host: "203.0.113.10",
    dockerVersion: "27.3.1",
    hostArch: "amd64",
    agent: { version: "0.4.0", port: 9443, certFingerprint: "fp", certPem: "" },
  });
  await seedServerRow(db, {
    id: "srv_build",
    name: "builder-secret",
    ip: "198.51.100.7",
    host: "build.secret.example",
    dockerVersion: "26.1.0",
    hostArch: "arm64",
    buildOnly: true,
    agent: {
      version: "0.3.0",
      port: 9443,
      certFingerprint: "fp2",
      certPem: "",
    },
  });
  await seedApp(db, { id: "app_gh", serverId: "srv_main", source: "github" });
  await seedApp(db, {
    id: "app_gl",
    serverId: "srv_main",
    source: "git",
    repo: {
      provider: "gitlab",
      url: "https://gitlab.secret.example/acme/shop",
      repo: "acme/shop",
      branch: "main",
    },
  });
  await seedApp(db, {
    id: "app_img",
    serverId: "srv_main",
    source: "docker-image",
  });
  await seedApp(db, {
    id: "app_up",
    serverId: "srv_main",
    source: "upload",
    teamId: TEAM_B,
  });
  await seedApp(db, {
    id: "app_compose",
    serverId: "srv_main",
    source: "compose",
    teamId: TEAM_B,
    compose: "services:\n  web:\n    image: nginx\n",
  });
  await seedPreview(db, { id: "prev_1", appId: "app_gh", prNumber: 7 });
  await seedDatabase(db, {
    id: "db_1",
    serverId: "srv_main",
    type: "postgres",
    name: "customers-secret",
  });
  await seedDestination(db, { id: "dest_s3", kind: "s3" });
  await seedDestination(db, {
    id: "dest_srv",
    kind: "server",
    serverId: "srv_main",
  });
  await seedBackup(db, {
    id: "bk_1",
    destinationId: "dest_s3",
    databaseId: "db_1",
  });
  await db.insert(projects).values({
    id: "prj_x",
    teamId: TEAM_A,
    name: "Secret Project",
    slug: "secret-project",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await db.insert(environments).values([
    {
      id: "environ_1",
      projectId: "prj_x",
      name: "Production",
      slug: "production",
      kind: "production",
      position: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
    {
      id: "environ_2",
      projectId: "prj_x",
      name: "Staging",
      slug: "staging",
      kind: "staging",
      position: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  ]);
  await db.insert(apiTokens).values({
    id: "tok_1",
    userId: OWNER,
    name: "Claude",
    tokenHash: "hash",
    prefix: "deplo_abc",
    mcpLastUsedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  });
  await db.insert(gitConnections).values({
    id: "gitconn_1",
    teamId: TEAM_A,
    provider: "gitlab",
    label: "Company GitLab",
    baseUrl: "https://gitlab.secret.example",
    username: "ada",
    tokenEnc: "enc",
    webhookSecretEnc: "enc",
    webhookToken: "wh_token",
    createdAt: NOW.toISOString(),
    createdBy: OWNER,
  });
  await db.insert(notificationChannels).values({
    id: "chan_1",
    teamId: TEAM_A,
    kind: "slack",
    url: "https://hooks.slack.com/services/secret",
    createdAt: NOW.toISOString(),
  });
  await db.insert(passkey).values({
    id: "pk_1",
    userId: OWNER,
    publicKey: "public",
    credentialID: "cred_1",
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
  });
  await db
    .update(teams)
    .set({ requireTwoFactor: true })
    .where(eq(teams.id, TEAM_A));
}

test("the report describes the fleet in aggregate and names nothing", async () => {
  await seedFleet();
  const prevIp = process.env.DEPLO_SERVER_IP;
  process.env.DEPLO_SERVER_IP = "203.0.113.10";
  try {
    const outcome = await sendUsageReport({ env: PROD, now: () => NOW });
    assert.equal(outcome, "sent");
  } finally {
    if (prevIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = prevIp;
  }

  const calls = usageCalls();
  assert.equal(calls.length, 1);
  assert.equal(capture.calls.length, 1, "the report is the only call made");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["content-type"], "application/json");

  const state = await usageReportState();
  assert.ok(state.instanceId, "the first send mints an id");
  assert.equal(state.mintedAt, NOW.toISOString());
  assert.equal(state.lastSentAt, NOW.toISOString());

  assert.deepEqual(calls[0].body, {
    schema: USAGE_REPORT_SCHEMA,
    instanceId: state.instanceId,
    deploVersion: DEPLO_VERSION,
    expectedAgentVersion: FALLBACK_AGENT_VERSION,
    installKind: "plain",
    daysSinceFirstReport: 0,
    hosts: [
      {
        agentVersion: "0.4.0",
        dockerVersion: "27.3.1",
        arch: "amd64",
        isDeploHost: true,
        isBuildServer: false,
        importOnly: false,
      },
      {
        agentVersion: "0.3.0",
        dockerVersion: "26.1.0",
        arch: "arm64",
        isDeploHost: false,
        isBuildServer: true,
        importOnly: false,
      },
    ],
    counts: {
      teams: 2,
      users: 2,
      servers: 2,
      environments: 2,
      previews: 1,
      backupSchedules: 1,
      appsBySource: {
        github: 1,
        gitlab: 1,
        image: 1,
        upload: 1,
        compose: 1,
      },
      databasesByEngine: { postgres: 1 },
      destinationsByKind: { bucket: 1, server: 1 },
    },
    features: {
      mcp: true,
      twoFactorPolicy: true,
      passkeys: true,
      gitProvider: true,
      notificationChannel: true,
      gravatar: false,
    },
  });

  const text = JSON.stringify(calls[0].body).toLowerCase();
  for (const forbidden of [
    "secret",
    "203.0.113.10",
    "198.51.100.7",
    "example",
    "acme",
    "owner@",
    "nginx",
    "hooks.slack",
    "customers",
    "prod-box",
    "builder",
    "github.com",
    "app_gh",
    "srv_main",
    "environ_",
  ]) {
    assert.ok(
      !text.includes(forbidden),
      `the report must not carry ${forbidden}`,
    );
  }
});

test("the install kind names the takeover platform", async () => {
  await db.update(instanceSettings).set({ takeoverPlatform: "coolify" });
  await sendUsageReport({ env: PROD, now: () => NOW });
  assert.equal(
    (usageCalls()[0].body as { installKind: string }).installKind,
    "coolify",
  );
});

test("nothing is sent before setup completes", async () => {
  await db.update(instanceSettings).set({ ownerUserId: null });
  assert.equal(await sendUsageReport({ env: PROD, now: () => NOW }), "skipped");
  assert.equal(usageCalls().length, 0);
  assert.equal((await usageReportState()).instanceId, null);
});

test("nothing is sent while the switch is off", async () => {
  await db.update(instanceSettings).set({ usageReportsEnabled: false });
  assert.equal(await sendUsageReport({ env: PROD, now: () => NOW }), "skipped");
  assert.equal(usageCalls().length, 0);
});

test("DO_NOT_TRACK=1 turns it off for the install", async () => {
  assert.equal(
    await sendUsageReport({
      env: { ...PROD, DO_NOT_TRACK: "1" },
      now: () => NOW,
    }),
    "skipped",
  );
  assert.equal(usageCalls().length, 0);
});

test("a development build never reports", async () => {
  assert.equal(
    await sendUsageReport({
      env: { NODE_ENV: "development" } as NodeJS.ProcessEnv,
      now: () => NOW,
    }),
    "skipped",
  );
  assert.equal(
    await sendUsageReport({ env: {} as NodeJS.ProcessEnv, now: () => NOW }),
    "skipped",
  );
  assert.equal(usageCalls().length, 0);
});

test("at most one report per 24 hours, and the id is reused", async () => {
  await sendUsageReport({ env: PROD, now: () => NOW });
  const first = await usageReportState();
  const later = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
  assert.equal(
    await sendUsageReport({ env: PROD, now: () => later }),
    "skipped",
  );
  assert.equal(usageCalls().length, 1);

  const nextDay = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
  assert.equal(
    await sendUsageReport({ env: PROD, now: () => nextDay }),
    "sent",
  );
  assert.equal(usageCalls().length, 2);
  const body = usageCalls()[1].body as {
    instanceId: string;
    daysSinceFirstReport: number;
  };
  assert.equal(body.instanceId, first.instanceId);
  assert.equal(body.daysSinceFirstReport, 1);
  assert.equal((await usageReportState()).lastSentAt, nextDay.toISOString());
});

test("a 204 stamps last-sent", async () => {
  capture.restore();
  capture = captureFetch(() => new Response(null, { status: 204 }));
  assert.equal(await sendUsageReport({ env: PROD, now: () => NOW }), "sent");
  assert.equal((await usageReportState()).lastSentAt, NOW.toISOString());
});

test("any answer that is not a 5xx counts as sent, a 429 included", async () => {
  capture.restore();
  capture = captureFetch((url) =>
    url === USAGE_REPORT_URL
      ? new Response(null, { status: 429 })
      : new Response("{}", { status: 200 }),
  );
  assert.equal(await sendUsageReport({ env: PROD, now: () => NOW }), "sent");
  assert.equal((await usageReportState()).lastSentAt, NOW.toISOString());
});

test("a 5xx warns once and leaves the stamp alone", async () => {
  capture.restore();
  capture = captureFetch((url) =>
    url === USAGE_REPORT_URL
      ? new Response("down", { status: 503 })
      : new Response("{}", { status: 200 }),
  );
  const warns: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => void warns.push(args);
  try {
    assert.equal(
      await sendUsageReport({ env: PROD, now: () => NOW }),
      "failed",
    );
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1);
  const state = await usageReportState();
  assert.equal(state.lastSentAt, null);
  assert.ok(state.instanceId, "the minted id stays for the next attempt");
});

test("a network failure leaves the stamp alone", async () => {
  capture.restore();
  capture = captureFetch((url) => {
    if (url === USAGE_REPORT_URL) throw new TypeError("fetch failed");
    return new Response("{}", { status: 200 });
  });
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      await sendUsageReport({ env: PROD, now: () => NOW }),
      "failed",
    );
  } finally {
    console.warn = orig;
  }
  assert.equal((await usageReportState()).lastSentAt, null);
});
