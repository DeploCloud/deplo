import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { POST as bootstrapRoute } from "@/app/api/agent/bootstrap/route";
import { mintBootstrap, verifyResponse } from "../agent/bootstrap";
import { __setRunsInContainerForTest } from "../deploy/domains";
import { serverToRow } from "./infra-rows";
import { completeBootstrap } from "./servers/agent-handshake";
import { getServerById } from "./servers/roster";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
process.env.DEPLO_SECRET = "test-secret-for-agent-mtls-pki-aaaaaaaa";

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

async function makeCsr(): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=deplo-agent",
    keys,
    signingAlgorithm: { name: "Ed25519" },
  });
  return csr.toString("pem");
}

async function seedProvisioning(
  tokenHash: string,
  expiresAt: string,
  address = "10.0.0.1",
): Promise<void> {
  await db.insert(serversTable).values(
    serverToRow({
      id: "srv_p",
      name: "p",
      host: address,
      type: "remote",
      status: "provisioning",
      ip: address,
      dockerVersion: "",
      traefikEnabled: false,
      cpuCores: 0,
      memoryMb: 0,
      diskGb: 0,
      allTeams: true,
      storageOnly: false,
      buildOnly: false,
      buildFallback: null,
      generatedAddressFamily: null,
      importOnly: false,
      hostArch: "amd64",
      uninstallPending: false,
      uninstallError: "",
      deployConcurrency: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      bootstrap: { tokenHash, expiresAt, usedAt: null },
    }),
  );
}

test("completeBootstrap provisions a server and pins its agent cert", async () => {
  const { rawToken, stored } = mintBootstrap();
  await seedProvisioning(stored.tokenHash, stored.expiresAt);
  const csrPem = await makeCsr();

  const result = await completeBootstrap({ token: rawToken, csrPem });
  assert.ok(result.certPem.includes("BEGIN CERTIFICATE"));
  assert.ok(result.caPem.includes("BEGIN CERTIFICATE"));

  const srv = (await getServerById("srv_p"))!;
  assert.equal(srv.status, "online");
  assert.ok(srv.agent?.certFingerprint, "cert fingerprint pinned");
  assert.equal(srv.bootstrap?.usedAt !== null, true, "bootstrap consumed");
});

test("completeBootstrap is single-use: two concurrent call-homes, exactly one wins", async () => {
  const { rawToken, stored } = mintBootstrap();
  await seedProvisioning(stored.tokenHash, stored.expiresAt);
  const [csr1, csr2] = await Promise.all([makeCsr(), makeCsr()]);

  const results = await Promise.allSettled([
    completeBootstrap({ token: rawToken, csrPem: csr1 }),
    completeBootstrap({ token: rawToken, csrPem: csr2 }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one consume wins");
  assert.equal(rejected.length, 1, "the other is rejected");
  assert.match(
    (rejected[0] as PromiseRejectedResult).reason.message,
    /already consumed/,
  );

  const srv = (await getServerById("srv_p"))!;
  assert.equal(srv.status, "online");
  assert.equal(srv.bootstrap?.usedAt !== null, true);
});

test("completeBootstrap rejects an already-consumed token (sequential)", async () => {
  const { rawToken, stored } = mintBootstrap();
  await seedProvisioning(stored.tokenHash, stored.expiresAt);
  await completeBootstrap({ token: rawToken, csrPem: await makeCsr() });
  await assert.rejects(
    completeBootstrap({ token: rawToken, csrPem: await makeCsr() }),
    /already been used|already consumed/,
  );
});

async function callHome(address: string): Promise<{ linkUrl?: string }> {
  const { rawToken, stored } = mintBootstrap();
  await seedProvisioning(stored.tokenHash, stored.expiresAt, address);
  const res = await bootstrapRoute(
    new Request("http://127.0.0.1:3000/api/agent/bootstrap", {
      method: "POST",
      body: JSON.stringify({ token: rawToken, csrPem: await makeCsr() }),
    }),
  );
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.ok(
    verifyResponse(rawToken, raw, res.headers.get("x-deplo-bootstrap-mac")!),
    "the address is signed with the certificate, so nobody on the way can change it",
  );
  return JSON.parse(raw) as { linkUrl?: string };
}

const SELF = "203.0.113.7";

test("the panel's own server is told to link over loopback, on the port the installer published", async () => {
  process.env.DEPLO_SERVER_IP = SELF;
  process.env.DEPLO_PUBLIC_URL = "https://deplo.example.com";
  process.env.DEPLO_LINK_PORT = "3102";
  assert.equal((await callHome(SELF)).linkUrl, "http://127.0.0.1:3102");
});

test("with no port declared, the panel's own server links to the listener's own port", async () => {
  process.env.DEPLO_SERVER_IP = SELF;
  delete process.env.DEPLO_LINK_PORT;
  assert.equal((await callHome(SELF)).linkUrl, "http://127.0.0.1:3001");
});

test("every other server is told to link to the panel's public address", async () => {
  process.env.DEPLO_SERVER_IP = SELF;
  process.env.DEPLO_PUBLIC_URL = "https://deplo.example.com";
  process.env.DEPLO_LINK_PORT = "3102";
  assert.equal(
    (await callHome("198.51.100.9")).linkUrl,
    "https://deplo.example.com",
  );
});

test("a server named by the panel's domain links through it, whatever machine that domain is on", async () => {
  process.env.DEPLO_SERVER_IP = SELF;
  process.env.DEPLO_PUBLIC_URL = "https://deplo.example.com";
  process.env.DEPLO_LINK_PORT = "3102";
  assert.equal(
    (await callHome("deplo.example.com")).linkUrl,
    "https://deplo.example.com",
  );
});

test("a panel in a container with no link port on the host never sends loopback", async (t) => {
  __setRunsInContainerForTest(true);
  t.after(() => __setRunsInContainerForTest());
  process.env.DEPLO_SERVER_IP = SELF;
  process.env.DEPLO_PUBLIC_URL = "https://deplo.example.com";
  delete process.env.DEPLO_LINK_PORT;
  assert.equal((await callHome(SELF)).linkUrl, "https://deplo.example.com");
});
