import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import * as x509 from "@peculiar/x509";
import {
  webcrypto,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";

import {
  caCertPem,
  issueAgentServerCert,
  issueControlPlaneClientCert,
  signAgentCsr,
  certFingerprint,
} from "./pki";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

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
  const agentKeys = await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=deplo-agent",
    keys: agentKeys as unknown as CryptoKeyPair,
    signingAlgorithm: { name: "Ed25519" },
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: "ip", value: "9.9.9.9" },
      ]),
    ],
  });

  const signed = await signAgentCsr(csr.toString("pem"), ["10.20.30.40"]);
  const ca = new X509Certificate(signed.caPem);
  const leaf = new X509Certificate(signed.certPem);
  assert.equal(
    leaf.checkIssued(ca),
    true,
    "CSR-signed leaf must chain to the CA",
  );
  assert.equal(leaf.verify(ca.publicKey), true, "CA signature must verify");
  assert.match(leaf.subjectAltName ?? "", /10\.20\.30\.40/);
  assert.doesNotMatch(
    leaf.subjectAltName ?? "",
    /9\.9\.9\.9/,
    "the agent must not be able to choose its own SANs",
  );
  assert.equal(signed.fingerprint, await certFingerprint(signed.certPem));
});

test("signAgentCsr: rejects a CSR whose self-signature does not verify", async () => {
  const a = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const b = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const good = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=deplo-agent",
    keys: a as unknown as CryptoKeyPair,
    signingAlgorithm: { name: "Ed25519" },
  });
  const der = Buffer.from(good.rawData);
  der[der.length - 1] ^= 0xff;
  void b;
  await assert.rejects(
    () =>
      signAgentCsr(new x509.Pkcs10CertificateRequest(der).toString("pem"), [
        "1.2.3.4",
      ]),
    /self-signature/i,
  );
});

test("certFingerprint matches Node's own sha256 fingerprint of the same cert", async () => {
  const bundle = await issueAgentServerCert(["10.1.2.3"]);
  const mine = await certFingerprint(bundle.certPem);
  const node = new X509Certificate(bundle.certPem).fingerprint256
    .replace(/:/g, "")
    .toLowerCase();
  assert.equal(mine, node, "fingerprint must be sha256 over the cert DER");
});

test("the CSR-signed agent cert completes a real mTLS handshake with the control-plane client", async () => {
  const agentKeyPem = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const priv = createPrivateKey(agentKeyPem);
  const pub = createPublicKey(priv);
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
    keys: keys as unknown as CryptoKeyPair,
    signingAlgorithm: { name: "Ed25519" },
  });
  const signed = await signAgentCsr(csr.toString("pem"), ["127.0.0.1"]);
  const client = await issueControlPlaneClientCert();

  await new Promise<void>((resolve, reject) => {
    const srv = tls.createServer(
      {
        key: agentKeyPem,
        cert: signed.certPem,
        ca: signed.caPem,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (sock) => sock.end("ok"),
    );
    srv.on("tlsClientError", (e) =>
      reject(new Error("agent rejected client: " + e.message)),
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
        () =>
          assert.equal(
            cli.authorized,
            true,
            "client must trust the CSR-signed agent",
          ),
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
      cli.on("error", () => cli.destroy());
      cli.on("secureConnect", () => cli.destroy());
      setTimeout(
        () => reject(new Error("server never rejected the client")),
        4000,
      ).unref();
    });
  });
});

// A second copy splits the ASN.1 schema registry once Next bundles it, and every agent dial
// then dies on "Cannot get schema for 'AlgorithmIdentifier'".
test("the lockfile holds one copy of the certificate packages", () => {
  const lock = readFileSync(new URL("../../bun.lock", import.meta.url), "utf8");
  const nested = lock.match(/"[^"]+\/@peculiar\/(?:x509|asn1-x509)"/g) ?? [];
  assert.deepEqual(nested, []);
});
