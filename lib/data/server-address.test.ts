import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_INFRA, seedServerRow } from "./infra-test-helpers";
import { getServerById, updateServerAddress } from "./servers";

// The verify-first probe mints a real control-plane client cert (lib/agent/pki
// derives its CA from DEPLO_SECRET); pin one so the dial can be built at all.
process.env.DEPLO_SECRET = "test-secret-for-server-address-aaaaaaaa";

/**
 * updateServerAddress is the migration verb: rewrite where Deplo dials an agent
 * without touching its pinned trust. These tests pin the boundary rules - who
 * may call it, what gets validated, and that verify-first really is
 * write-nothing-on-refusal - using an agent "listening" on 127.0.0.1:1, where
 * the kernel refuses the connection immediately (fast, no timeout to sit out).
 * The happy probe path needs a live agent and has no mocking seam on purpose
 * (same stance as server-health.test.ts).
 */

let db: TestDb;
let pg: PGlite;

const PROVISIONED = "srv_addr_prov";
const BARE = "srv_addr_bare";
/** Refused instantly on any box: nothing binds TCP port 1 in a test run. */
const DEAD_LOCAL = "127.0.0.1";

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
    truncate table activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_member", teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await seedServerRow(db, {
    id: PROVISIONED,
    name: "provisioned",
    ip: DEAD_LOCAL,
    host: DEAD_LOCAL,
    agent: {
      port: 1,
      certFingerprint: "sha256:pinned",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.0.0",
    },
  });
  await seedServerRow(db, {
    id: BARE,
    name: "bare",
    ip: "192.0.2.10",
    host: "192.0.2.10",
    status: "provisioning",
  });
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("refuses a caller who is not instance admin", async () => {
  await assert.rejects(() =>
    runWithIdentity({ userId: "user_member", teamId: TEAM_A }, () =>
      updateServerAddress({ id: BARE, address: "192.0.2.20" }),
    ),
  );
  assert.equal((await asAdmin(() => getServerById(BARE)))?.ip, "192.0.2.10");
});

test("refuses a blank address and an out-of-range port", async () => {
  await assert.rejects(
    () => asAdmin(() => updateServerAddress({ id: BARE, address: "   " })),
    /Address is required/,
  );
  await assert.rejects(
    () =>
      asAdmin(() =>
        updateServerAddress({ id: BARE, address: "192.0.2.20", agentPort: 70000 }),
      ),
    /Agent port/,
  );
});

test("an unprovisioned server needs no probe: both columns follow the address", async () => {
  const { warning } = await asAdmin(() =>
    updateServerAddress({ id: BARE, address: "192.0.2.20" }),
  );
  assert.equal(warning, null);
  const server = await asAdmin(() => getServerById(BARE));
  assert.equal(server?.ip, "192.0.2.20");
  assert.equal(server?.host, "192.0.2.20");
});

test("verify-first: an unanswered probe refuses and writes NOTHING", async () => {
  // Loopback, not TEST-NET: the probe must FAIL, and a connection refused is
  // instant where a non-routable SYN sits out the whole Hello deadline.
  await assert.rejects(() =>
    asAdmin(() => updateServerAddress({ id: PROVISIONED, address: "127.0.0.2" })),
  );
  const server = await asAdmin(() => getServerById(PROVISIONED));
  assert.equal(server?.ip, DEAD_LOCAL);
  assert.equal(server?.host, DEAD_LOCAL);
  assert.equal(server?.agent?.port, 1);
});

test("force skips the probe, writes the row, and keeps trust pinned - with the cert warning", async () => {
  const { warning } = await asAdmin(() =>
    updateServerAddress({
      id: PROVISIONED,
      address: "192.0.2.99",
      agentPort: 9443,
      force: true,
    }),
  );
  // The SAN refresh could not reach the (dead) old address; that is exactly the
  // force scenario, so it degrades to a warning rather than a refusal.
  assert.match(warning ?? "", /certificate/i);
  const server = await asAdmin(() => getServerById(PROVISIONED));
  assert.equal(server?.ip, "192.0.2.99");
  assert.equal(server?.host, "192.0.2.99");
  assert.equal(server?.agent?.port, 9443);
  // The address changed; the identity did not.
  assert.equal(server?.agent?.certFingerprint, "sha256:pinned");
});

test("an unchanged address is a no-op - no probe, no error, even on a dead host", async () => {
  const { warning } = await asAdmin(() =>
    updateServerAddress({ id: PROVISIONED, address: DEAD_LOCAL, agentPort: 1 }),
  );
  assert.equal(warning, null);
});
