import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb, getDb } from "../db/client";
import {
  serverTeams as serverTeamsTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_INFRA, seedServerRow } from "./infra-test-helpers";
import { checkServerReadiness } from "./server-readiness";
import { READINESS_DETAILS, READINESS_MESSAGES } from "../infra/server-readiness";
import { __resetReleaseCacheForTests } from "../agent/release";

/**
 * The readiness orchestrator's DB behaviour, hermetically: no gRPC, no sockets.
 *
 * Every case below exercises a path that NEVER dials — the auth gate, the unknown id, the
 * unprovisioned/trust-revoked fence — which is precisely the set of rules that, if broken,
 * would make this feature either a security hole or a liar:
 *   - it is instance-admin only, and the gate fires before any read or dial;
 *   - a server with no agent (or a trust-revoked one, whose fingerprint is "") is never
 *     dialed: there is nothing on the other end, and `resolveTarget` would throw from a pure
 *     DB read, which reported as "the agent did not answer" would paint every brand-new
 *     server as broken;
 *   - IT WRITES NOTHING. `servers.status` belongs to the health prober; a readiness probe has
 *     no confirming retry and no throttle lease, so letting it demote a server would
 *     reintroduce the exact "a blip pins a false offline on the operator's screen" bug that
 *     `probeServer`'s retry exists to prevent.
 *
 * The dialing path's DECISIONS are covered by the pure classifier in
 * lib/infra/server-readiness.test.ts — there is no mocking seam for `connectAgent`, which is
 * exactly why the classifier lives outside it.
 */

let db: TestDb;
let pg: PGlite;

/** A provisioned agent. The fingerprint is UNIQUE-indexed, so each server needs its own. */
const agent = (fp: string) => ({
  port: 9443,
  certFingerprint: fp,
  certPem: "pem",
  version: "1.1.0",
});

/**
 * `resolveExpectedAgentVersion` reaches for the latest GitHub release. Stub it out so the
 * suite is offline-safe and deterministic: an unreachable GitHub degrades to the built-in
 * fallback, which is exactly the documented behaviour.
 */
let restoreFetch: () => void;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = orig;
  };
});

after(async () => {
  restoreFetch();
  __resetReleaseCacheForTests();
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

const rawRow = async (id: string) =>
  (await getDb().select().from(serversTable).where(eq(serversTable.id, id)))[0];

test("checkServerReadiness is instance-admin only, and rejects BEFORE any dial", async () => {
  // Seeded PROVISIONED on purpose: if the gate leaked, the orchestrator would try to dial a
  // host that does not exist and this test would hang rather than fail quietly.
  await seedServerRow(db, { id: "srv_1", status: "online", agent: agent("fp_1") });

  await assert.rejects(() => asMember(() => checkServerReadiness("srv_1")), /instance admin/i);

  const row = await rawRow("srv_1");
  assert.equal(row.statusCheckedAt, null, "nothing was probed by a non-admin");
  assert.equal(row.statusProbedAt, null, "and no throttle lease was taken either");
});

test("checkServerReadiness rejects an unknown server id", async () => {
  await assert.rejects(() => asAdmin(() => checkServerReadiness("srv_nope")), /not found/i);
});

test("an unprovisioned server returns a `provisioning` report without dialing", async () => {
  await seedServerRow(db, { id: "srv_new", name: "eu-west-1", status: "provisioning" });

  const report = await asAdmin(() => checkServerReadiness("srv_new"));

  assert.equal(report.verdict, "provisioning");
  assert.equal(report.serverId, "srv_new");
  assert.equal(report.serverName, "eu-west-1");
  assert.ok(!Number.isNaN(Date.parse(report.checkedAt)), "checkedAt is a real instant");
  // Only the rows whose inputs we actually have: the bootstrap fact + the control-plane facts.
  // No wall of grey "skipped" agent/docker/routing rows for a host nobody has installed yet.
  assert.deepEqual(
    report.checks.map((c) => c.id),
    ["agent.bootstrap", "config.teamAccess", "config.deployConcurrency"],
  );
  assert.equal(
    report.checks.find((c) => c.id === "agent.bootstrap")!.detail,
    READINESS_MESSAGES.notProvisioned,
  );
});

test("a trust-revoked server (empty-string fingerprint) is fenced exactly like an unprovisioned one", async () => {
  // removeServer revokes trust by writing "" (not NULL). Dialing such a row would make
  // resolveTarget throw from a pure DB read — reported as "the agent did not answer", which
  // is a lie: we never asked.
  await seedServerRow(db, {
    id: "srv_revoked",
    status: "online",
    agent: { port: 9443, certFingerprint: "", certPem: "", version: "1.1.0" },
  });

  const report = await asAdmin(() => checkServerReadiness("srv_revoked"));

  assert.equal(report.verdict, "provisioning");
  assert.deepEqual(
    report.checks.map((c) => c.id),
    ["agent.bootstrap", "config.teamAccess", "config.deployConcurrency"],
  );
});

test("a readiness check WRITES NOTHING — status, its timestamps and the heartbeat are untouched", async () => {
  // The load-bearing invariant. Readiness is a DIAGNOSTIC the operator opens *because*
  // something looks wrong; it must not be able to perturb what the page is telling them.
  // `servers.status` stays the health prober's alone.
  await seedServerRow(db, { id: "srv_new", status: "provisioning" });
  await seedServerRow(db, {
    id: "srv_revoked",
    status: "online",
    agent: { port: 9443, certFingerprint: "", certPem: "", version: "1.1.0" },
  });

  await asAdmin(() => checkServerReadiness("srv_new"));
  await asAdmin(() => checkServerReadiness("srv_revoked"));

  const fresh = await rawRow("srv_new");
  assert.equal(fresh.status, "provisioning", "status unchanged");
  assert.equal(fresh.statusMessage, null);
  assert.equal(fresh.statusCheckedAt, null, "no observation was recorded");
  assert.equal(fresh.statusProbedAt, null, "no throttle lease was taken");
  assert.equal(fresh.lastSeenAt, null, "no heartbeat was written");

  const revoked = await rawRow("srv_revoked");
  assert.equal(revoked.status, "online", "a readiness check cannot demote a server");
  assert.equal(revoked.statusMessage, null);
  assert.equal(revoked.statusCheckedAt, null);
  assert.equal(revoked.statusProbedAt, null);
  assert.equal(revoked.lastSeenAt, null);
});

test("grantedTeamCount comes from the real server_teams rows", async () => {
  // A restricted server with zero grants can never receive a deployment, so it FAILS — and a
  // fail outranks `provisioning`, even on a server whose agent has not called home yet.
  await seedServerRow(db, {
    id: "srv_locked",
    status: "provisioning",
    allTeams: false,
  });

  const locked = await asAdmin(() => checkServerReadiness("srv_locked"));
  const lockedAccess = locked.checks.find((c) => c.id === "config.teamAccess")!;
  assert.equal(lockedAccess.severity, "fail");
  assert.equal(lockedAccess.detail, READINESS_MESSAGES.noTeamAccess);
  assert.equal(locked.verdict, "not_ready", "a fail outranks provisioning");

  await getDb()
    .insert(serverTeamsTable)
    .values({ serverId: "srv_locked", teamId: TEAM_A });

  const granted = await asAdmin(() => checkServerReadiness("srv_locked"));
  const grantedAccess = granted.checks.find((c) => c.id === "config.teamAccess")!;
  assert.equal(grantedAccess.severity, "info");
  assert.equal(grantedAccess.detail, READINESS_DETAILS.teamsSome(1));
  assert.equal(grantedAccess.detail, "1 team can deploy to this server.");
  assert.equal(granted.verdict, "provisioning", "the only fail is gone");
});
