import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import type { PGlite } from "@electric-sql/pglite";

import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb, getDb } from "../db/client";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_INFRA, seedServerRow } from "./infra-test-helpers";
import { getServerById } from "./servers/roster";
import {
  checkServerHealth,
  checkAllServerHealth,
  claimProbe,
  recordServerHealth,
} from "./server-health";
import { HEALTH_MESSAGES } from "../infra/server-health";
import { __resetCooldowns, shouldFire } from "../notify/cooldown";
import { captureFetch } from "../notify/fetch-capture-test-helpers";
import { instanceFrozen } from "./deplo-move/freeze";
import { saveNotificationChannel } from "./notifications";

let db: TestDb;
let pg: PGlite;

const agent = (fp: string) => ({
  port: 9443,
  certFingerprint: fp,
  certPem: "pem",
  version: "1.0",
});
const AGENT = agent("fp_1");
const T1 = "2026-07-13T10:00:00.000Z";
const T2 = "2026-07-13T10:00:05.000Z";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_INFRA}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: "user_member", teamId: TEAM_A, role: "member" },
    ],
  });
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_member", teamId: TEAM_A }, fn);

test("a provisioning server is never probed and never demoted", async () => {
  await seedServerRow(db, { id: "srv_new", status: "provisioning" });

  const server = await asAdmin(() => checkServerHealth("srv_new"));

  assert.equal(server.status, "provisioning");
  assert.equal(server.statusCheckedAt, undefined, "no probe was claimed");
  const stored = (await getServerById("srv_new"))!;
  assert.equal(stored.status, "provisioning");
  assert.equal(stored.statusCheckedAt, undefined);
});

test("recordServerHealth refuses to write health onto an agent-less row", async () => {
  await seedServerRow(db, { id: "srv_new", status: "provisioning" });

  await recordServerHealth("srv_new", { status: "offline", message: "x" }, T1);

  const stored = (await getServerById("srv_new"))!;
  assert.equal(stored.status, "provisioning", "the fence held");
  assert.equal(stored.statusCheckedAt, undefined);
});

test("recordServerHealth persists the status, the reason and the observation time", async () => {
  await seedServerRow(db, { id: "srv_1", status: "online", agent: AGENT });

  await recordServerHealth(
    "srv_1",
    { status: "warning", message: HEALTH_MESSAGES.dockerDown },
    T1,
  );

  const stored = (await getServerById("srv_1"))!;
  assert.equal(stored.status, "warning");
  assert.equal(stored.statusMessage, HEALTH_MESSAGES.dockerDown);
  assert.equal(stored.statusCheckedAt, T1);
});

test("only a persisted offline-to-online transition sends a recovery alert", async (t) => {
  __resetCooldowns();
  t.after(__resetCooldowns);
  const id = "srv_recovery";
  await seedServerRow(db, {
    id,
    status: "offline",
    agent: AGENT,
    statusCheckedAt: T2,
  });
  await seedServerRow(db, {
    id: "srv_provisioning",
    status: "provisioning",
    agent: agent("fp_provisioning"),
  });
  await asAdmin(() =>
    saveNotificationChannel(null, {
      kind: "discord",
      name: "",
      enabled: true,
      url: "https://discord/hook",
      target: "",
      emailFrom: "",
      emailProvider: "resend",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      alerts: ["server_online"],
    }),
  );
  const capture = captureFetch();
  t.after(capture.restore);
  let now = Date.parse(T2);
  t.mock.method(Date, "now", () => now);
  const online = { status: "online", message: null } as const;
  await instanceFrozen();

  await recordServerHealth(id, online, T1);
  assert.equal((await getServerById(id))?.status, "offline");
  assert.ok(shouldFire("server_online", `server:${id}`, "online"));
  await recordServerHealth("srv_provisioning", online, T2);
  assert.equal((await getServerById("srv_provisioning"))?.status, "online");
  assert.ok(shouldFire("server_online", "server:srv_provisioning", "online"));
  __resetCooldowns();

  await Promise.all([
    recordServerHealth(id, online, T2),
    recordServerHealth(id, online, T2),
  ]);
  for (let attempt = 0; attempt < 100 && !capture.calls.length; attempt++)
    await sleep(10);
  assert.equal(capture.calls.length, 1);

  now += 31 * 60_000;
  const later = new Date(now).toISOString();
  await instanceFrozen();
  await recordServerHealth(id, online, later);
  const stored = await getServerById(id);
  assert.equal(stored?.statusCheckedAt, later);
  assert.equal(stored?.lastSeenAt, later);
  assert.ok(shouldFire("server_online", `server:${id}`, "online"));
  assert.equal(capture.calls.length, 1);
});

test("a late-landing older probe cannot overwrite a newer observation", async () => {
  await seedServerRow(db, { id: "srv_1", status: "online", agent: AGENT });

  await recordServerHealth("srv_1", { status: "online", message: null }, T2);
  await recordServerHealth(
    "srv_1",
    { status: "offline", message: "stale" },
    T1,
  );

  const stored = (await getServerById("srv_1"))!;
  assert.equal(stored.status, "online", "the older probe was ignored");
  assert.equal(stored.statusCheckedAt, T2);
});

test("a successful probe also refreshes the heartbeat; a failed one does not", async () => {
  await seedServerRow(db, {
    id: "srv_up",
    status: "online",
    agent: agent("fp_up"),
  });
  await seedServerRow(db, {
    id: "srv_down",
    status: "online",
    agent: agent("fp_down"),
  });

  await recordServerHealth("srv_up", { status: "online", message: null }, T1);
  await recordServerHealth("srv_down", { status: "offline", message: "x" }, T1);

  assert.equal(
    (await getServerById("srv_up"))!.lastSeenAt,
    T1,
    "agent answered = a sighting",
  );
  assert.equal(
    (await getServerById("srv_down"))!.lastSeenAt,
    undefined,
    "an unreachable agent was never seen",
  );
});

test("claimProbe advances the throttle lease but NEVER the freshness watermark", async () => {
  await seedServerRow(db, { id: "srv_1", status: "online", agent: AGENT });

  assert.equal(await claimProbe("srv_1", true), true);

  const [row] = await getDb()
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, "srv_1"));
  assert.equal(
    row.statusCheckedAt,
    null,
    "the observation timestamp was NOT touched",
  );
  assert.notEqual(row.statusProbedAt, null, "but the throttle lease WAS taken");
});

test("a fresh observation suppresses a redundant ambient claim", async () => {
  const justNow = new Date(Date.now() - 1_000).toISOString();
  await seedServerRow(db, {
    id: "srv_1",
    status: "online",
    agent: AGENT,
    statusCheckedAt: justNow,
  });
  assert.equal(
    await claimProbe("srv_1", false),
    false,
    "a fresh observation is enough",
  );
});

test("a trust-revoked server (empty-string fingerprint) is fenced out like an unprovisioned one", async () => {
  await seedServerRow(db, {
    id: "srv_revoked",
    status: "online",
    agent: { certFingerprint: "", certPem: "", version: "1.0" },
  });

  assert.equal(
    await claimProbe("srv_revoked", true),
    false,
    "no lease on a revoked row",
  );
  await recordServerHealth(
    "srv_revoked",
    { status: "offline", message: "x" },
    T1,
  );
  assert.equal(
    (await getServerById("srv_revoked"))!.status,
    "online",
    "and no health written onto it either",
  );
});

test("the throttle collapses a burst of page loads into ONE dial", async () => {
  await seedServerRow(db, { id: "srv_1", status: "online", agent: AGENT });

  assert.equal(
    await claimProbe("srv_1", false),
    true,
    "first caller wins the claim",
  );
  assert.equal(
    await claimProbe("srv_1", false),
    false,
    "second caller is throttled",
  );
  assert.equal(await claimProbe("srv_1", false), false, "and so is the third");
});

test("a forced check bypasses the ambient throttle but still respects a floor", async () => {
  const eightSecondsAgo = new Date(Date.now() - 8_000).toISOString();
  await seedServerRow(db, {
    id: "srv_1",
    status: "online",
    agent: AGENT,
    statusCheckedAt: eightSecondsAgo,
  });

  assert.equal(
    await claimProbe("srv_1", false),
    false,
    "the ambient sweep is throttled",
  );
  assert.equal(
    await claimProbe("srv_1", true),
    true,
    "the operator's button is not",
  );
  assert.equal(
    await claimProbe("srv_1", true),
    false,
    "but even it can't hammer the host",
  );
});

test("claimProbe never claims an agent-less server, forced or not", async () => {
  await seedServerRow(db, { id: "srv_new", status: "provisioning" });

  assert.equal(await claimProbe("srv_new", false), false);
  assert.equal(await claimProbe("srv_new", true), false);
});

test("both health checks are instance-admin only, and reject BEFORE any dial", async () => {
  await seedServerRow(db, { id: "srv_1", status: "online", agent: AGENT });

  await assert.rejects(
    () => asMember(() => checkServerHealth("srv_1")),
    /instance admin/i,
  );
  await assert.rejects(
    () => asMember(() => checkAllServerHealth()),
    /instance admin/i,
  );

  const stored = (await getServerById("srv_1"))!;
  assert.equal(
    stored.statusCheckedAt,
    undefined,
    "no probe was claimed by a non-admin",
  );
});

test("checkServerHealth rejects an unknown server id", async () => {
  await assert.rejects(
    () => asAdmin(() => checkServerHealth("srv_nope")),
    /not found/i,
  );
});

test("checkAllServerHealth passes unprovisioned servers through untouched", async () => {
  await seedServerRow(db, { id: "srv_a", status: "provisioning" });
  await seedServerRow(db, { id: "srv_b", status: "provisioning" });

  const servers = await asAdmin(() => checkAllServerHealth());

  assert.equal(servers.length, 2);
  assert.deepEqual(
    servers.map((s) => s.status),
    ["provisioning", "provisioning"],
  );
  assert.ok(
    servers.every((s) => s.statusCheckedAt === undefined),
    "nothing was probed",
  );
});
