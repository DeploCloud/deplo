import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { makeServer, seedServerRow } from "../infra-test-helpers";
import { AGENT_VERSION, DEPLO_VERSION } from "../../version";
import { __resetReleaseCacheForTests } from "../../agent/release";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { listActivity } from "../activity";
import {
  claimBootRollout,
  fleetAgentStatus,
  markAgentRolloutPending,
  rolloutOrder,
  runAgentRollout,
  unusableServers,
} from "./agent-rollout";

let db: TestDb;
let pg: PGlite;

const SELF_IP = "192.0.2.200";
const EXPECTED = AGENT_VERSION;

// servers.cert_fingerprint is unique, so every seeded host needs its own.
let fingerprints = 0;
const agentAt = (version: string) => ({
  port: 9443,
  certFingerprint: `fp${++fingerprints}`,
  certPem: "pem",
  version,
});

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_PUBLIC_URL = "https://deplo.test";
  process.env.DEPLO_SERVER_IP = SELF_IP;
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table servers, instance_settings, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A }] });
});

const asAdmin = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("rollout order puts the lightest remote first and the Deplo host last", () => {
  const servers = [
    makeServer({
      id: "srv_host",
      ip: SELF_IP,
      host: SELF_IP,
      agent: agentAt("0.1.0"),
    }),
    makeServer({
      id: "srv_busy",
      ip: "10.0.0.2",
      agent: agentAt("0.1.0"),
    }),
    makeServer({
      id: "srv_light",
      ip: "10.0.0.3",
      agent: agentAt("0.1.0"),
    }),
  ];
  const order = rolloutOrder(
    servers,
    new Map([
      ["srv_busy", 9],
      ["srv_light", 1],
    ]),
    new Set([SELF_IP]),
  );
  assert.deepEqual(
    order.map((s) => s.id),
    ["srv_light", "srv_busy", "srv_host"],
  );
});

test("rollout order leaves out an unprovisioned host and a migration source", () => {
  const servers = [
    makeServer({ id: "srv_new", ip: "10.0.0.4" }),
    makeServer({
      id: "srv_import",
      ip: "10.0.0.5",
      importOnly: true,
      agent: agentAt("0.1.0"),
    }),
    makeServer({
      id: "srv_ok",
      ip: "10.0.0.6",
      agent: agentAt("0.1.0"),
    }),
  ];
  const order = rolloutOrder(servers, new Map(), new Set([SELF_IP]));
  assert.deepEqual(
    order.map((s) => s.id),
    ["srv_ok"],
  );
});

test("a first boot records the version and signs nothing", async () => {
  await claimBootRollout();
  const [row] = await db
    .select({
      actor: instanceSettings.agentRolloutBy,
      booted: instanceSettings.bootedVersion,
    })
    .from(instanceSettings);
  assert.equal(row.actor, null);
  assert.equal(row.booted, DEPLO_VERSION);
});

test("a version that moved since the last boot signs the rollout Deplo", async () => {
  await db.insert(instanceSettings).values({
    id: "default",
    bootedVersion: "0.0.1-previous",
    updatedAt: new Date().toISOString(),
  });
  await claimBootRollout();
  const [row] = await db
    .select({ actor: instanceSettings.agentRolloutBy })
    .from(instanceSettings);
  assert.equal(row.actor, "Deplo");
});

test("the click's actor survives the restart that follows it", async () => {
  await markAgentRolloutPending("Ada");
  await claimBootRollout();
  const [row] = await db
    .select({
      actor: instanceSettings.agentRolloutBy,
      booted: instanceSettings.bootedVersion,
    })
    .from(instanceSettings);
  assert.equal(row.actor, "Ada");
  assert.equal(row.booted, DEPLO_VERSION);
});

test("the fleet status names the servers behind, and those only a reinstall brings back", async () => {
  await seedServerRow(db, {
    id: "srv_old",
    name: "neon-s2",
    ip: "10.0.0.8",
    agent: agentAt("0.1.0"),
  });
  await seedServerRow(db, {
    id: "srv_current",
    name: "neon-s1",
    ip: "10.0.0.9",
    agent: agentAt(EXPECTED),
  });
  await seedServerRow(db, {
    id: "srv_unknown",
    name: "neon-s3",
    ip: "10.0.0.11",
    agent: agentAt(""),
  });
  await seedServerRow(db, {
    id: "srv_import",
    name: "other-panel",
    ip: "10.0.0.10",
    importOnly: true,
    agent: agentAt("0.0.1"),
  });

  const status = await asAdmin(() => fleetAgentStatus());
  assert.equal(status.total, 3);
  assert.equal(status.expected, EXPECTED);
  assert.deepEqual(
    status.behind
      .map((s) => [s.name, s.version, s.usable, s.reach])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    [
      ["neon-s2", "0.1.0", false, "reinstall"],
      ["neon-s3", null, false, "updatable"],
    ],
  );
  assert.equal(status.updating, true, "Deplo is on neon-s3");
});

test("a server too old to link, or left behind, is unusable until its server agent is reinstalled", async () => {
  await seedServerRow(db, {
    id: "srv_old",
    name: "neon-s2",
    ip: "10.0.0.8",
    agent: agentAt("0.4.0"),
  });
  await seedServerRow(db, {
    id: "srv_left",
    name: "neon-s4",
    ip: "10.0.0.12",
    agent: agentAt(EXPECTED),
    leftBehindAt: "2026-10-28T00:00:00.000Z",
  });
  // Left behind, then it connected after all: moot.
  await seedServerRow(db, {
    id: "srv_back",
    name: "neon-s5",
    ip: "10.0.0.13",
    agent: agentAt(EXPECTED),
    leftBehindAt: "2026-10-28T00:00:00.000Z",
    firstLinkedAt: "2026-10-29T00:00:00.000Z",
  });

  assert.deepEqual(
    (await asAdmin(() => unusableServers())).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    [
      { id: "srv_old", name: "neon-s2", reach: "reinstall" },
      { id: "srv_left", name: "neon-s4", reach: "reinstall" },
    ],
  );
  const status = await asAdmin(() => fleetAgentStatus());
  assert.equal(status.updating, false, "nothing Deplo does reaches neon-s2");
});

test("the rollout leaves alone a server only a reinstall brings back, and promises nothing", async (t) => {
  (globalThis as Record<symbol, unknown>)[
    Symbol.for("deplo.agent.release.cache")
  ] = {
    value: {
      at: Date.now(),
      release: {
        version: AGENT_VERSION,
        binaries: { amd64: { url: "https://x/a", sha256: "a" }, arm64: null },
      },
    },
  };
  t.after(() => __resetReleaseCacheForTests());
  let reached = 0;
  __setAgentConnectorForTest(async () => {
    reached++;
    return null;
  });
  t.after(() => __setAgentConnectorForTest());
  await seedServerRow(db, {
    id: "srv_old",
    name: "neon-s2",
    ip: "10.0.0.8",
    agent: agentAt("0.4.0"),
  });

  await runAgentRollout();
  assert.equal(reached, 0, "nothing tried to reach it");
  const status = await asAdmin(() => fleetAgentStatus());
  assert.equal(status.behind[0].update, null, "no update in flight or failed");
  const log = await asAdmin(() => listActivity(10));
  assert.deepEqual(log, []);
});
