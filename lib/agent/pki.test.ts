import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";

import {
  caCertPem,
  issueAgentServerCert,
  issueControlPlaneClientCert,
} from "./pki";

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
