import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import {
  listServerCertificates,
  addServerCertificate,
  removeServerCertificate,
} from "./server-certificates";

/**
 * Data-layer tests for custom certificates. The seeded server has no pinned
 * agent certificate, so every dial is refused before a socket opens - which is
 * the property these rely on: everything asserted here has to happen BEFORE the
 * host is touched, and a call that reaches the dial proves the checks ran first.
 *
 * What they lock:
 *  - INSTANCE-ADMIN on all three entry points. A certificate here fronts every
 *    team's apps on that host, so a team capability is not authority over it.
 *  - the certificate and the key are checked AS A PAIR, and before the host is
 *    dialed. A mismatched pair makes Traefik quietly serve its own self-signed
 *    default, which is the failure nobody diagnoses from the outside.
 *  - an already-expired certificate is refused rather than installed, and the
 *    refusals name the fix instead of reading "server unreachable".
 */

let db: TestDb;
let pg: PGlite;

const SERVER = "srv_certs";

const GOOD_CERT = `-----BEGIN CERTIFICATE-----
MIIBwjCCAWigAwIBAgIUPbDAN6OqpzSEYcvFAM01MdpKq9swCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQYWNtZS5leGFtcGxlLmNvbTAgFw0yNjA4MDUxNTQ0MjFaGA8y
MDUxMDMyNzE1NDQyMVowGzEZMBcGA1UEAwwQYWNtZS5leGFtcGxlLmNvbTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABLd1eAZq0rySOfm0tUIIvWjC5mzuCcInQLRX
UgeJ5h4x+jlVj1kW1BmC/L3Qn8UTNCpeQYYFfFpl7nrlGrmMFuGjgYcwgYQwHQYD
VR0OBBYEFM6nDykL+T4ZNO/+SP25uM7txG2TMB8GA1UdIwQYMBaAFM6nDykL+T4Z
NO/+SP25uM7txG2TMA8GA1UdEwEB/wQFMAMBAf8wMQYDVR0RBCowKIIQYWNtZS5l
eGFtcGxlLmNvbYIUd3d3LmFjbWUuZXhhbXBsZS5jb20wCgYIKoZIzj0EAwIDSAAw
RQIhAPG68SY29VVltPDXJ3/cVTQmhSP1eIP4VkU2CuuCe27SAiAjGRHeKkZla1zU
lDMobM6mUp2E7aZAIhnD86RVLe64fQ==
-----END CERTIFICATE-----
`;

const GOOD_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg7ZiMD+xlQESRAGhR
NWyteGCFri9eZBJnx3HJBlI0ZeGhRANCAAS3dXgGatK8kjn5tLVCCL1owuZs7gnC
J0C0V1IHieYeMfo5VY9ZFtQZgvy90J/FEzQqXkGGBXxaZe565Rq5jBbh
-----END PRIVATE KEY-----
`;

const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgf6zBCJFbJL/iOtdX
BWud5MiglwbeyxzGajCOUgKa9sKhRANCAARS5vUHwuXdFVLyQrQrX/4Z0bgjrpXC
f0UbmaQTUt9qO2jNZBxpskR7F3E3nEuUhDGSoAWzFiI1cAXE7XMKCqef
-----END PRIVATE KEY-----
`;

const EXPIRED_CERT = `-----BEGIN CERTIFICATE-----
MIIBUzCB+qADAgECAhRDIofID39QZMDaAdO2ofApxdjFsTAKBggqhkjOPQQDAjAa
MRgwFgYDVQQDDA9vbGQuZXhhbXBsZS5jb20wHhcNMjAwMTAxMDAwMDAwWhcNMjEw
MTAxMDAwMDAwWjAaMRgwFgYDVQQDDA9vbGQuZXhhbXBsZS5jb20wWTATBgcqhkjO
PQIBBggqhkjOPQMBBwNCAAS+lty0UFeBFO9BldjTUuSfEwuZG6sll4GfChyW2QEm
Ep74+Wi/LMUrzpNQDEMeggbOT15UeGm/axqydPrOmv0Dox4wHDAaBgNVHREEEzAR
gg9vbGQuZXhhbXBsZS5jb20wCgYIKoZIzj0EAwIDSAAwRQIhANyJqVHG8BQZRf2g
u+VB3KFI+fvsV7kZXbhULHEw+N17AiAtBJWNZdGvXnZJiSalG/D9+uWKGuVp1eHZ
HhdWup/Vew==
-----END CERTIFICATE-----
`;

const EXPIRED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgXYHV3D/6ud6nhQRS
ChTi+w3ddLP2XeMxxpMtCrVWK6WhRANCAAS+lty0UFeBFO9BldjTUuSfEwuZG6sl
l4GfChyW2QEmEp74+Wi/LMUrzpNQDEMeggbOT15UeGm/axqydPrOmv0D
-----END PRIVATE KEY-----
`;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_member", teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  // RFC 5737 TEST-NET-1, and deliberately unprovisioned: the dial is refused
  // before a connection is attempted, so nothing here hangs on a real network.
  await seedServerRow(db, {
    id: SERVER,
    name: "remote-1",
    ip: "192.0.2.10",
    host: "192.0.2.10",
  });
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_member", teamId: TEAM_A }, fn);

test("every entry point is instance-admin only", async () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["listServerCertificates", () => listServerCertificates(SERVER)],
    [
      "addServerCertificate",
      () => addServerCertificate(SERVER, { certPem: GOOD_CERT, keyPem: GOOD_KEY }),
    ],
    ["removeServerCertificate", () => removeServerCertificate(SERVER, "AB:CD")],
  ];
  for (const [name, call] of calls) {
    await assert.rejects(() => asMember(call), /instance admin/i, `${name} must be gated`);
  }
});

test("an unknown server is rejected, not dialed", async () => {
  await assert.rejects(
    () => asAdmin(() => listServerCertificates("srv_nope")),
    /not found/i,
  );
});

test("a certificate and key that do not belong together are refused", async () => {
  await assert.rejects(
    () => asAdmin(() => addServerCertificate(SERVER, { certPem: GOOD_CERT, keyPem: OTHER_KEY })),
    /does not belong/i,
  );
});

test("garbage is named as garbage, not reported as an unreachable host", async () => {
  await assert.rejects(
    () => asAdmin(() => addServerCertificate(SERVER, { certPem: "hello", keyPem: GOOD_KEY })),
    /not a certificate/i,
  );
  await assert.rejects(
    () => asAdmin(() => addServerCertificate(SERVER, { certPem: GOOD_CERT, keyPem: "hello" })),
    /could not read that private key/i,
  );
});

test("an expired certificate is refused before it reaches the host", async () => {
  await assert.rejects(
    () =>
      asAdmin(() =>
        addServerCertificate(SERVER, { certPem: EXPIRED_CERT, keyPem: EXPIRED_KEY }),
      ),
    /expired on 2021-01-01/i,
  );
});

test("a valid pair passes validation and only then dials the host", async () => {
  // The dial is what fails here (no pinned agent certificate), which is the
  // proof: the pair was accepted, so the next thing to go wrong is the network.
  await assert.rejects(
    () => asAdmin(() => addServerCertificate(SERVER, { certPem: GOOD_CERT, keyPem: GOOD_KEY })),
    (e: Error) => !/certificate|private key/i.test(e.message),
  );
});
