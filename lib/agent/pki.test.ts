import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";

import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

import {
  caCertPem,
  issueAgentServerCert,
  issueControlPlaneClientCert,
  signAgentCsr,
  certFingerprint,
} from "./pki";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

// The PKI derives its CA from DEPLO_SECRET; pin one so the tests are stable.
process.env.DEPLO_SECRET = "test-secret-for-agent-mtls-pki-aaaaaaaa";

test("CA is deterministic across calls (no stored key)", async () => {
  const a = await caCertPem();
  const b = await caCertPem();
  assert.equal(a, b, "same secret must rebuild byte-identical CA");
  const cert = new X509Certificate(a);
  assert.match(cert.subject, /CN=Deplo Agent CA/);
  assert.equal(cert.ca, true, "CA cert must have basicConstraints CA:TRUE");
});

test("agent server cert chains to the CA and carries its hosts as SANs", async () => {
  const bundle = await issueAgentServerCert(["10.1.2.3"]);
  const ca = new X509Certificate(bundle.caPem);
  const leaf = new X509Certificate(bundle.certPem);
  assert.equal(
    leaf.checkIssued(ca),
    true,
    "leaf must be issued by the derived CA",
  );
  assert.equal(leaf.verify(ca.publicKey), true, "CA signature must verify");
  // SANs: the requested IP plus the always-added localhost/127.0.0.1.
  assert.match(leaf.subjectAltName ?? "", /10\.1\.2\.3/);
  assert.match(leaf.subjectAltName ?? "", /127\.0\.0\.1/);
});

test("control-plane client cert chains to the same CA", async () => {
  const bundle = await issueControlPlaneClientCert();
  const ca = new X509Certificate(bundle.caPem);
  const leaf = new X509Certificate(bundle.certPem);
  assert.equal(leaf.checkIssued(ca), true);
  assert.match(leaf.subject, /CN=deplo-control-plane/);
});

test("a full mTLS handshake succeeds between minted server and client", async () => {
  const server = await issueAgentServerCert(["127.0.0.1"]);
  const client = await issueControlPlaneClientCert();

  await new Promise<void>((resolve, reject) => {
    const srv = tls.createServer(
      {
        key: server.keyPem,
        cert: server.certPem,
        ca: server.caPem,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (sock) => {
        sock.end("ok");
      },
    );
    srv.on("tlsClientError", (e) =>
      reject(new Error("server rejected client: " + e.message)),
    );
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      const cli = tls.connect(
        {
          host: "127.0.0.1",
          port,
          servername: "localhost",
          key: client.keyPem,
          cert: client.certPem,
          ca: client.caPem,
          rejectUnauthorized: true,
        },
        () => {
          assert.equal(cli.authorized, true, "client must trust the agent");
        },
      );
      cli.on("data", () => {
        cli.end();
        srv.close();
        resolve();
      });
      cli.on("error", reject);
    });
  });
});

test("signAgentCsr: a CSR-signed agent cert chains to the CA and uses control-plane-chosen SANs", async () => {
  // The agent generates its own Ed25519 key pair and a PKCS#10 CSR (the remote
  // bootstrap: its private key NEVER leaves the agent). The CSR carries a SAN
  // the agent should NOT get to choose; the control plane overrides it.
  const agentKeys = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=deplo-agent",
    keys: agentKeys as CryptoKeyPair,
    signingAlgorithm: { name: "Ed25519" },
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: "ip", value: "9.9.9.9" }, // the agent's claim — must be ignored
      ]),
    ],
  });

  const signed = await signAgentCsr(csr.toString("pem"), ["10.20.30.40"]);
  const ca = new X509Certificate(signed.caPem);
  const leaf = new X509Certificate(signed.certPem);
  assert.equal(leaf.checkIssued(ca), true, "CSR-signed leaf must chain to the CA");
  assert.equal(leaf.verify(ca.publicKey), true, "CA signature must verify");
  // SANs come from the control plane's `hosts`, not the CSR's claim.
  assert.match(leaf.subjectAltName ?? "", /10\.20\.30\.40/);
  assert.doesNotMatch(
    leaf.subjectAltName ?? "",
    /9\.9\.9\.9/,
    "the agent must not be able to choose its own SANs",
  );
  // The fingerprint the control plane stores matches the cert it issued.
  assert.equal(signed.fingerprint, await certFingerprint(signed.certPem));
});

test("signAgentCsr: rejects a CSR whose self-signature does not verify", async () => {
  // A CSR signed by key A but presenting key B's public key (proof-of-possession
  // failure) must be refused before any cert is minted.
  const a = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const b = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const good = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=deplo-agent",
    keys: a as CryptoKeyPair,
    signingAlgorithm: { name: "Ed25519" },
  });
  // Tamper: re-encode the CSR with B's public key but A's signature. Easiest
  // reliable forgery in-test is to flip a byte in the DER signature region.
  const der = Buffer.from(good.rawData);
  der[der.length - 1] ^= 0xff; // corrupt the trailing signature byte
  void b;
  await assert.rejects(
    () => signAgentCsr(new x509.Pkcs10CertificateRequest(der).toString("pem"), ["1.2.3.4"]),
    /self-signature/i,
  );
});

test("certFingerprint matches Node's own sha256 fingerprint of the same cert", async () => {
  const bundle = await issueAgentServerCert(["10.1.2.3"]);
  const mine = await certFingerprint(bundle.certPem);
  // Node's X509Certificate.fingerprint256 is "AA:BB:.." uppercase hex; normalise.
  const node = new X509Certificate(bundle.certPem).fingerprint256
    .replace(/:/g, "")
    .toLowerCase();
  assert.equal(mine, node, "fingerprint must be sha256 over the cert DER");
});

test("the CSR-signed agent cert completes a real mTLS handshake with the control-plane client", async () => {
  // End-to-end trust inversion: the agent serves TLS with a cert the control
  // plane signed from the agent's OWN key (which the control plane never saw),
  // and the control-plane client authenticates against the shared CA.
  const agentKeyPem = (() => {
    const { privateKey } = require("node:crypto").generateKeyPairSync("ed25519");
    return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  })();
  // Build a CSR from that exact private key so the issued cert matches it.
  const priv = require("node:crypto").createPrivateKey(agentKeyPem);
  const pub = require("node:crypto").createPublicKey(priv);
  const keys = {
    privateKey: await webcrypto.subtle.importKey(
      "pkcs8",
      priv.export({ format: "der", type: "pkcs8" }),
      { name: "Ed25519" },
      true,
      ["sign"],
    ),
    publicKey: await webcrypto.subtle.importKey(
      "spki",
      pub.export({ format: "der", type: "spki" }),
      { name: "Ed25519" },
      true,
      ["verify"],
    ),
  };
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=deplo-agent",
    keys: keys as CryptoKeyPair,
    signingAlgorithm: { name: "Ed25519" },
  });
  const signed = await signAgentCsr(csr.toString("pem"), ["127.0.0.1"]);
  const client = await issueControlPlaneClientCert();

  await new Promise<void>((resolve, reject) => {
    const srv = tls.createServer(
      {
        key: agentKeyPem, // the agent's own key — never left "the agent"
        cert: signed.certPem,
        ca: signed.caPem,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (sock) => sock.end("ok"),
    );
    srv.on("tlsClientError", (e) => reject(new Error("agent rejected client: " + e.message)));
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      const cli = tls.connect(
        {
          host: "127.0.0.1",
          port,
          servername: "localhost",
          key: client.keyPem,
          cert: client.certPem,
          ca: client.caPem,
          rejectUnauthorized: true,
        },
        () => assert.equal(cli.authorized, true, "client must trust the CSR-signed agent"),
      );
      cli.on("data", () => {
        cli.end();
        srv.close();
        resolve();
      });
      cli.on("error", reject);
    });
  });
});

test("the agent refuses a client that presents no CA-signed cert", async () => {
  const server = await issueAgentServerCert(["127.0.0.1"]);
  // The security property is server-side: a peer without a CA-signed client
  // cert never reaches an AUTHORIZED connection, and the server raises
  // tlsClientError. (Under TLS 1.3 the client's secureConnect can fire before
  // the server validates the missing client cert, so we assert on the server,
  // which is the side that actually enforces trust.)
  await new Promise<void>((resolve, reject) => {
    let authorizedConnections = 0;
    const srv = tls.createServer(
      {
        key: server.keyPem,
        cert: server.certPem,
        ca: server.caPem,
        requestCert: true,
        rejectUnauthorized: true,
      },
      () => {
        authorizedConnections++;
      },
    );
    srv.on("tlsClientError", () => {
      // Expected: the certless client is rejected at handshake.
      srv.close();
      assert.equal(
        authorizedConnections,
        0,
        "no certless client may reach an authorized connection",
      );
      resolve();
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      const cli = tls.connect({
        host: "127.0.0.1",
        port,
        servername: "localhost",
        ca: server.caPem,
        rejectUnauthorized: true,
      });
      // The client may error or briefly connect; either way the server must
      // reject. Swallow the client-side error so it doesn't fail the test.
      cli.on("error", () => cli.destroy());
      cli.on("secureConnect", () => cli.destroy());
      // Safety net so a hung handshake fails loudly instead of timing out.
      setTimeout(() => reject(new Error("server never rejected the client")), 4000).unref();
    });
  });
});
