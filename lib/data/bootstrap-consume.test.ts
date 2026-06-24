import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { servers as serversTable } from "../db/schema/control-plane";
import { mintBootstrap } from "../agent/bootstrap";
import { serverToRow } from "./infra-rows";
import { completeBootstrap, getServerById } from "./servers";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
// The PKI (signBootstrapCsr) derives its CA from DEPLO_SECRET; pin one.
process.env.DEPLO_SECRET = "test-secret-for-agent-mtls-pki-aaaaaaaa";

/**
 * `completeBootstrap` consume-single-use under concurrency (relational-store PLAN
 * Step 6 — servers are relational now). The check-sign-consume splits the CSR
 * signing (crypto) from a conditional `UPDATE … WHERE bootstrap_used_at IS NULL`,
 * so two concurrent call-homes for the same token can't both provision: the loser
 * updates 0 rows and throws. This replaces the old in-memory `mutate()` re-check.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table servers restart identity cascade;`);
});

/** An agent-side Ed25519 key pair + PKCS#10 CSR (its key never leaves the agent). */
async function makeCsr(): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=deplo-agent",
    keys,
    signingAlgorithm: { name: "Ed25519" },
  });
  return csr.toString("pem");
}

async function seedProvisioning(tokenHash: string, expiresAt: string): Promise<void> {
  await db.insert(serversTable).values(
    serverToRow({
      id: "srv_p", name: "p", host: "10.0.0.1", type: "remote", status: "provisioning",
      ip: "10.0.0.1", dockerVersion: "", traefikEnabled: false, cpuCores: 0, memoryMb: 0,
      diskGb: 0, cpuUsage: 0, memoryUsage: 0, diskUsage: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      bootstrap: { tokenHash, expiresAt, usedAt: null },
    }),
  );
}

test("completeBootstrap provisions a server and pins its agent cert", async () => {
  const { rawToken, stored } = mintBootstrap();
  await seedProvisioning(stored.tokenHash, stored.expiresAt);
  const csrPem = await makeCsr();

  const result = await completeBootstrap({ token: rawToken, csrPem, agentPort: 9443 });
  assert.ok(result.certPem.includes("BEGIN CERTIFICATE"));
  assert.ok(result.caPem.includes("BEGIN CERTIFICATE"));

  const srv = (await getServerById("srv_p"))!;
  assert.equal(srv.status, "online");
  assert.ok(srv.agent?.certFingerprint, "cert fingerprint pinned");
  assert.equal(srv.agent?.port, 9443);
  assert.equal(srv.bootstrap?.usedAt !== null, true, "bootstrap consumed");
});

test("completeBootstrap is single-use: two concurrent call-homes, exactly one wins", async () => {
  const { rawToken, stored } = mintBootstrap();
  await seedProvisioning(stored.tokenHash, stored.expiresAt);
  const [csr1, csr2] = await Promise.all([makeCsr(), makeCsr()]);

  // Fire both consumes concurrently against the same single-use token.
  const results = await Promise.allSettled([
    completeBootstrap({ token: rawToken, csrPem: csr1, agentPort: 9443 }),
    completeBootstrap({ token: rawToken, csrPem: csr2, agentPort: 9443 }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one consume wins");
  assert.equal(rejected.length, 1, "the other is rejected");
  assert.match(
    (rejected[0] as PromiseRejectedResult).reason.message,
    /already consumed/,
  );

  // The server is provisioned exactly once.
  const srv = (await getServerById("srv_p"))!;
  assert.equal(srv.status, "online");
  assert.equal(srv.bootstrap?.usedAt !== null, true);
});

test("completeBootstrap rejects an already-consumed token (sequential)", async () => {
  const { rawToken, stored } = mintBootstrap();
  await seedProvisioning(stored.tokenHash, stored.expiresAt);
  await completeBootstrap({ token: rawToken, csrPem: await makeCsr(), agentPort: 9443 });
  await assert.rejects(
    completeBootstrap({ token: rawToken, csrPem: await makeCsr(), agentPort: 9443 }),
    /already been used|already consumed/,
  );
});
