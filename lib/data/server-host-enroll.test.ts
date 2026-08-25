import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { sha256Hex } from "../crypto";
import { TRUNCATE_INFRA, seedServerRow } from "./infra-test-helpers";
import { ensureDeploHostServer, listAllServers } from "./servers";

/**
 * Enrolling the machine Deplo runs on - "agent 0" - is what stops a fresh install
 * from coming up with an empty server list and no way to deploy without SSH.
 */

const TOKEN = "host-token-for-tests-aaaaaaaaaaaaaaaa";
const HOST_IP = "203.0.113.7";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
  delete process.env.DEPLO_HOST_BOOTSTRAP_TOKEN;
  delete process.env.DEPLO_SERVER_IP;
  delete process.env.DEPLO_HOST_NAME;
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_INFRA);
  process.env.DEPLO_HOST_BOOTSTRAP_TOKEN = TOKEN;
  process.env.DEPLO_SERVER_IP = HOST_IP;
  process.env.DEPLO_HOST_NAME = "vps-fra-1";
});

test("registers this host as a server, armed with the installer's token", async () => {
  await ensureDeploHostServer();

  const servers = await listAllServers();
  assert.equal(servers.length, 1);
  const [s] = servers;
  assert.equal(s!.name, "vps-fra-1", "named after the host, not the container");
  assert.equal(s!.host, HOST_IP);
  assert.equal(s!.ip, HOST_IP);
  assert.equal(s!.status, "provisioning", "waiting for the agent to call home");
  assert.equal(s!.allTeams, true, "the only server a new install has");
  assert.equal(s!.storageOnly, false);
  assert.equal(s!.buildOnly, false);
  assert.equal(s!.importOnly, false);
  assert.equal(
    s!.bootstrap?.tokenHash,
    sha256Hex(TOKEN),
    "the raw token is never stored",
  );
  assert.equal(s!.bootstrap?.usedAt, null);
});

test("runs once - a second boot does not add a second row", async () => {
  await ensureDeploHostServer();
  await ensureDeploHostServer();
  assert.equal((await listAllServers()).length, 1);
});

test("re-arms a host still waiting for its first call-home", async () => {
  await ensureDeploHostServer();
  const before = (await listAllServers())[0]!;

  // The stored token expires in an hour; re-running the installer days later is
  // the documented repair, so the expiry has to move or the retry 401s.
  await db.execute(
    `update servers set bootstrap_expires_at = now() - interval '1 day',
       bootstrap_token_hash = 'stale'`,
  );
  await ensureDeploHostServer();

  const after = (await listAllServers())[0]!;
  assert.equal(after.id, before.id, "the same row, not a replacement");
  assert.equal(after.bootstrap?.tokenHash, sha256Hex(TOKEN));
  assert.ok(
    new Date(after.bootstrap!.expiresAt).getTime() > Date.now(),
    "the window is open again",
  );
});

test("leaves a host that already has an agent alone", async () => {
  await seedServerRow(db, {
    id: "srv_live",
    name: "already here",
    ip: HOST_IP,
    host: HOST_IP,
    status: "online",
    agent: {
      port: 9443,
      certFingerprint: "fp",
      certPem: "pem",
      version: "1.28.0",
    },
  });

  await ensureDeploHostServer();

  const servers = await listAllServers();
  assert.equal(servers.length, 1, "no duplicate for the same machine");
  assert.equal(servers[0]!.status, "online", "a live agent is never disturbed");
  assert.equal(
    servers[0]!.bootstrap?.tokenHash ?? null,
    null,
    "and no bootstrap is armed against it",
  );
});

test("does nothing without the installer's environment", async () => {
  delete process.env.DEPLO_HOST_BOOTSTRAP_TOKEN;
  await ensureDeploHostServer();
  assert.equal((await listAllServers()).length, 0);

  // A row we cannot dial is worse than no row: the agent's cert SANs are pinned
  // to whatever address it declares.
  process.env.DEPLO_HOST_BOOTSTRAP_TOKEN = TOKEN;
  delete process.env.DEPLO_SERVER_IP;
  await ensureDeploHostServer();
  assert.equal((await listAllServers()).length, 0);
});
