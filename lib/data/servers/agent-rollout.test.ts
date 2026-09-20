import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { makeServer, seedServerRow } from "../infra-test-helpers";
import { DEPLO_VERSION } from "../../version";
import {
  claimBootRollout,
  fleetAgentStatus,
  markAgentRolloutPending,
  rolloutOrder,
} from "./agent-rollout";

let db: TestDb;
let pg: PGlite;

const SELF_IP = "192.0.2.200";
const EXPECTED = "9.9.9";

// The release resolver memoizes on a globalThis symbol; seeding it keeps the suite off GitHub.
function pinExpectedAgentVersion(version: string): void {
  const cell = (globalThis as Record<symbol, unknown>)[
    Symbol.for("deplo.agent.release.cache")
  ] as { value: unknown; lastGood: unknown };
  cell.value = {
    at: Date.now(),
    release: { version, binaries: { amd64: null, arm64: null } },
  };
}

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
  pinExpectedAgentVersion(EXPECTED);
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

test("a first boot records the version and arms nothing", async () => {
  await seedServerRow(db, {
    id: "srv_old",
    ip: "10.0.0.7",
    agent: agentAt("0.1.0"),
  });
  await claimBootRollout();
  const status = await asAdmin(() => fleetAgentStatus());
  assert.equal(status.updating, false);
  assert.equal(status.expected, EXPECTED);
});

test("a version that moved since the last boot arms the rollout", async () => {
  await db.insert(instanceSettings).values({
    id: "default",
    bootedVersion: "0.0.1-previous",
    updatedAt: new Date().toISOString(),
  });
  await claimBootRollout();
  assert.equal((await asAdmin(() => fleetAgentStatus())).updating, true);

  // A plain restart on the same version leaves the fleet alone.
  await db.update(instanceSettings).set({ agentRolloutBy: null });
  await claimBootRollout();
  assert.equal((await asAdmin(() => fleetAgentStatus())).updating, false);
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

test("the fleet status names the servers left behind", async () => {
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
    id: "srv_import",
    name: "other-panel",
    ip: "10.0.0.10",
    importOnly: true,
    agent: agentAt("0.0.1"),
  });

  const status = await asAdmin(() => fleetAgentStatus());
  assert.equal(status.total, 2);
  assert.deepEqual(
    status.behind.map((s) => [s.name, s.version]),
    [["neon-s2", "0.1.0"]],
  );
});
