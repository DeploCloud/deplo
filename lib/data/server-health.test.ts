import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb, getDb } from "../db/client";
import { servers as serversTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_INFRA, seedServerRow } from "./infra-test-helpers";
import { getServerById } from "./servers";
import {
  checkServerHealth,
  checkAllServerHealth,
  claimProbe,
  recordServerHealth,
} from "./server-health";
import { HEALTH_MESSAGES } from "../infra/server-health";

/**
 * The health prober's DB behaviour, hermetically: no gRPC, no sockets.
 *
 * Everything asserted here is a rule that, if broken, makes the Servers page LIE — the
 * three that matter most:
 *   - a `provisioning` server is never dialed and never demoted (it has no agent yet;
 *     `resolveTarget` throws for it from a pure DB read, and feeding that to the
 *     classifier would paint every brand-new server red);
 *   - a late-landing probe cannot overwrite a newer observation (probes do not finish
 *     in the order they start);
 *   - the throttle actually throttles, so a reload storm cannot fan out dials.
 *
 * The dialing path itself is covered by the pure classifier in
 * lib/infra/server-health.test.ts — there is no mocking seam for `connectAgent`, which
 * is exactly why the decision lives outside it.
 */

let db: TestDb;
let pg: PGlite;

/** A provisioned agent. The fingerprint is UNIQUE-indexed, so each server needs its own. */
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
  // No agent has called home, so there is nothing on the other end to dial. If the
  // prober touched it, `resolveTarget` would throw AgentUnreachableError from a pure DB
  // read and every server awaiting its first call-home would flip to `offline`.
  await seedServerRow(db, { id: "srv_new", status: "provisioning" }); // no agent

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

test("a late-landing older probe cannot overwrite a newer observation", async () => {
  // Probes do not finish in the order they start: a 3s "offline" probe launched first
  // can land after a 50ms "online" probe launched second. Watermarking on probe-START
  // time is what stops the row from settling on the outcome that happened to be slowest.
  await seedServerRow(db, { id: "srv_1", status: "online", agent: AGENT });

  await recordServerHealth("srv_1", { status: "online", message: null }, T2); // newer
  await recordServerHealth("srv_1", { status: "offline", message: "stale" }, T1); // older

  const stored = (await getServerById("srv_1"))!;
  assert.equal(stored.status, "online", "the older probe was ignored");
  assert.equal(stored.statusCheckedAt, T2);
});

test("a successful probe also refreshes the heartbeat; a failed one does not", async () => {
  await seedServerRow(db, { id: "srv_up", status: "online", agent: agent("fp_up") });
  await seedServerRow(db, { id: "srv_down", status: "online", agent: agent("fp_down") });

  await recordServerHealth("srv_up", { status: "online", message: null }, T1);
  await recordServerHealth("srv_down", { status: "offline", message: "x" }, T1);

  assert.equal((await getServerById("srv_up"))!.lastSeenAt, T1, "agent answered = a sighting");
  assert.equal(
    (await getServerById("srv_down"))!.lastSeenAt,
    undefined,
    "an unreachable agent was never seen",
  );
});

test("claimProbe advances the throttle lease but NEVER the freshness watermark", async () => {
  // The load-bearing invariant. status_checked_at is the UI's confidence signal; if the
  // lease advanced it, an inconclusive probe (timeout / skip) would leave a stale status
  // wearing a fresh timestamp — a confident green painted for a host nobody reached.
  await seedServerRow(db, { id: "srv_1", status: "online", agent: AGENT });

  assert.equal(await claimProbe("srv_1", true), true);

  const [row] = await getDb().select().from(serversTable).where(eq(serversTable.id, "srv_1"));
  assert.equal(row.statusCheckedAt, null, "the observation timestamp was NOT touched");
  assert.notEqual(row.statusProbedAt, null, "but the throttle lease WAS taken");
});

test("a fresh observation suppresses a redundant ambient claim", async () => {
  // If the 1s metrics poll just observed the server, the Servers page has no reason to
  // re-dial — the claim skips when status_checked_at is already fresh, even if the lease
  // is stale.
  const justNow = new Date(Date.now() - 1_000).toISOString();
  await seedServerRow(db, {
    id: "srv_1",
    status: "online",
    agent: AGENT,
    statusCheckedAt: justNow,
  });
  assert.equal(await claimProbe("srv_1", false), false, "a fresh observation is enough");
});

test("a trust-revoked server (empty-string fingerprint) is fenced out like an unprovisioned one", async () => {
  // removeServer revokes trust by writing "" (not NULL); the fence must treat that
  // exactly like a never-provisioned row, or a probe would dial a server mid-removal.
  await seedServerRow(db, {
    id: "srv_revoked",
    status: "online",
    agent: { port: 9443, certFingerprint: "", certPem: "", version: "1.0" },
  });

  assert.equal(await claimProbe("srv_revoked", true), false, "no lease on a revoked row");
  await recordServerHealth("srv_revoked", { status: "offline", message: "x" }, T1);
  assert.equal(
    (await getServerById("srv_revoked"))!.status,
    "online",
    "and no health written onto it either",
  );
});

test("the throttle collapses a burst of page loads into ONE dial", async () => {
  await seedServerRow(db, { id: "srv_1", status: "online", agent: AGENT });

  assert.equal(await claimProbe("srv_1", false), true, "first caller wins the claim");
  assert.equal(await claimProbe("srv_1", false), false, "second caller is throttled");
  assert.equal(await claimProbe("srv_1", false), false, "and so is the third");
});

test("a forced check bypasses the ambient throttle but still respects a floor", async () => {
  // "Force" means "ignore the 15s window", not "dial as fast as you can click" — the
  // floor is the only backstop against a mashed button (or a scripted bearer-token
  // caller) turning the control plane into a fan-out dialer.
  //
  // Probed 8 seconds ago: inside the 15s ambient window, outside the 5s force floor.
  const eightSecondsAgo = new Date(Date.now() - 8_000).toISOString();
  await seedServerRow(db, {
    id: "srv_1",
    status: "online",
    agent: AGENT,
    statusCheckedAt: eightSecondsAgo,
  });

  assert.equal(await claimProbe("srv_1", false), false, "the ambient sweep is throttled");
  assert.equal(await claimProbe("srv_1", true), true, "the operator's button is not");
  assert.equal(await claimProbe("srv_1", true), false, "but even it can't hammer the host");
});

test("claimProbe never claims an agent-less server, forced or not", async () => {
  await seedServerRow(db, { id: "srv_new", status: "provisioning" });

  assert.equal(await claimProbe("srv_new", false), false);
  assert.equal(await claimProbe("srv_new", true), false);
});

test("both health checks are instance-admin only, and reject BEFORE any dial", async () => {
  await seedServerRow(db, { id: "srv_1", status: "online", agent: AGENT });

  await assert.rejects(() => asMember(() => checkServerHealth("srv_1")), /instance admin/i);
  await assert.rejects(() => asMember(() => checkAllServerHealth()), /instance admin/i);

  // The gate fired before the prober could claim anything.
  const stored = (await getServerById("srv_1"))!;
  assert.equal(stored.statusCheckedAt, undefined, "no probe was claimed by a non-admin");
});

test("checkServerHealth rejects an unknown server id", async () => {
  await assert.rejects(() => asAdmin(() => checkServerHealth("srv_nope")), /not found/i);
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
