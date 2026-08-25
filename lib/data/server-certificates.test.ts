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
  supersedes,
  type ServerCertificate,
} from "./server-certificates";

/**
 * Data-layer tests for custom certificates. - the certificate and the key are
 * checked AS A PAIR, and before the host is dialed.
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
      {
        id: "user_member",
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
      },
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
      () =>
        addServerCertificate(SERVER, { certPem: GOOD_CERT, keyPem: GOOD_KEY }),
    ],
    ["removeServerCertificate", () => removeServerCertificate(SERVER, "AB:CD")],
  ];
  for (const [name, call] of calls) {
    await assert.rejects(
      () => asMember(call),
      /instance admin/i,
      `${name} must be gated`,
    );
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
    () =>
      asAdmin(() =>
        addServerCertificate(SERVER, { certPem: GOOD_CERT, keyPem: OTHER_KEY }),
      ),
    /does not belong/i,
  );
});

test("garbage is named as garbage, not reported as an unreachable host", async () => {
  await assert.rejects(
    () =>
      asAdmin(() =>
        addServerCertificate(SERVER, { certPem: "hello", keyPem: GOOD_KEY }),
      ),
    /not a certificate/i,
  );
  await assert.rejects(
    () =>
      asAdmin(() =>
        addServerCertificate(SERVER, { certPem: GOOD_CERT, keyPem: "hello" }),
      ),
    /could not read that private key/i,
  );
});

test("an expired certificate is refused before it reaches the host", async () => {
  await assert.rejects(
    () =>
      asAdmin(() =>
        addServerCertificate(SERVER, {
          certPem: EXPIRED_CERT,
          keyPem: EXPIRED_KEY,
        }),
      ),
    /expired on 2021-01-01/i,
  );
});

test("a valid pair passes validation and only then dials the host", async () => {
  // The dial is what fails here (no pinned agent certificate), which is the
  // proof: the pair was accepted, so the next thing to go wrong is the network.
  await assert.rejects(
    () =>
      asAdmin(() =>
        addServerCertificate(SERVER, { certPem: GOOD_CERT, keyPem: GOOD_KEY }),
      ),
    (e: Error) => !/certificate|private key/i.test(e.message),
  );
});

const FUTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT6gAwIBAgIUIRZbAioso09iPv7EXn20HiCadwowCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNZGVwbG8tdGVzdC1jYTAeFw0yNzAxMDEwMDAwMDBaFw0yODAx
MDEwMDAwMDBaMB0xGzAZBgNVBAMMEmZ1dHVyZS5leGFtcGxlLmNvbTBZMBMGByqG
SM49AgEGCCqGSM49AwEHA0IABLzPwJRrbcXLhqlIR9v6o+IH4aAnSzNLZl0jz0KP
r/OYdsotpopmhNxAOKXi6kZWqv7CaFupSrkpWW4y7GxEAnCjYTBfMB0GA1UdEQQW
MBSCEmZ1dHVyZS5leGFtcGxlLmNvbTAdBgNVHQ4EFgQUTobxJt/M7SIHV7JRSC+A
ZbbnNwswHwYDVR0jBBgwFoAU4EukX9taWXq3t2IT1ZmVxleVSiQwCgYIKoZIzj0E
AwIDSQAwRgIhANbKBXLJKR+45vYzxaL0N6MQJ7Vj15zWEYoDGP1UtGMjAiEA9v9i
JEcNxl+xD9BuOr5JRwNKhKcih1/Ng5OQNWrDfmo=
-----END CERTIFICATE-----
`;

const FUTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgXz6IQfzS+WcP9jDr
a/v4Jg6ha70B5JvVYY8XOWpiPMWhRANCAAS8z8CUa23Fy4apSEfb+qPiB+GgJ0sz
S2ZdI89Cj6/zmHbKLaaKZoTcQDil4upGVqr+wmhbqUq5KVluMuxsRAJw
-----END PRIVATE KEY-----
`;

test("a certificate dated in the future is refused, like an expired one", () => {
  // Traefik would serve it and every browser would reject it, with nothing on
  // this side saying why.
  return assert.rejects(
    () =>
      asAdmin(() =>
        addServerCertificate(SERVER, {
          certPem: FUTURE_CERT,
          keyPem: FUTURE_KEY,
        }),
      ),
    /not valid until 2027-01-01/i,
  );
});

test("a chain pasted upside down says so, instead of blaming the key", () => {
  // Traefik serves the FIRST certificate in the file. With the intermediate on
  // top, the key genuinely does not match it - and "wrong key" would send someone
  // hunting through key files for the key they already pasted.
  return assert.rejects(
    () =>
      asAdmin(() =>
        addServerCertificate(SERVER, {
          certPem: `${EXPIRED_CERT}${GOOD_CERT}`,
          keyPem: GOOD_KEY,
        }),
      ),
    /upside down/i,
  );
});

/**
 * Which installed certificate a new one replaces. Exact-domain equality was not
 * enough: renewing a certificate after adding a hostname to it left BOTH on the
 * host, and Traefik answers a request for a shared name with either of them.
 */
test("supersedes: a certificate replaces one whose every domain it covers", () => {
  const installed = (domains: string[]): ServerCertificate => ({
    id: "x",
    subject: domains[0] ?? "",
    domains,
    issuer: "y",
    notBefore: "",
    notAfter: "",
    expired: false,
    expiresInDays: 30,
  });

  // The same domains: a renewal.
  assert.equal(supersedes(new Set(["a.com"]), installed(["a.com"])), true);
  // A name added to an existing certificate: the old one is strictly redundant.
  assert.equal(
    supersedes(new Set(["a.com", "b.com"]), installed(["a.com"])),
    true,
  );
  // A partial overlap keeps BOTH: evicting the old one would take away b.com,
  // which the new certificate does not cover.
  assert.equal(
    supersedes(new Set(["a.com"]), installed(["a.com", "b.com"])),
    false,
  );
  // Unrelated certificates never touch each other.
  assert.equal(supersedes(new Set(["a.com"]), installed(["z.com"])), false);
  // A certificate naming nothing is never claimed to be covered.
  assert.equal(supersedes(new Set(["a.com"]), installed([])), false);
});
