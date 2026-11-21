import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";

import {
  caCertPem,
  issueAgentServerCert,
  issueControlPlaneClientCert,
} from "../../agent/pki";
import { agentCertProblem, certLapsed, keyFingerprint } from "./agent-tls";

// ADR-0050: the CA's signature and the pinned key decide; a certificate's dates never do.
const day = 24 * 3_600_000;

test("an agent certificate passes on its key and Deplo's signature, past its date too", async () => {
  const ca = new X509Certificate(await caCertPem());
  const lapsed = await issueAgentServerCert(["127.0.0.1"], {
    notBefore: new Date(Date.now() - 400 * day),
    notAfter: new Date(Date.now() - day),
  });
  const peer = new X509Certificate(lapsed.certPem);
  assert.equal(certLapsed(lapsed.certPem), true);
  assert.equal(
    agentCertProblem(peer, ca, keyFingerprint(peer), "CERT_HAS_EXPIRED"),
    null,
  );
  const fresh = await issueAgentServerCert(["127.0.0.1"]);
  assert.equal(certLapsed(fresh.certPem), false);
});

test("anything else is refused, with the reason", async () => {
  const ca = new X509Certificate(await caCertPem());
  const mine = new X509Certificate((await issueAgentServerCert([])).certPem);
  const other = new X509Certificate((await issueAgentServerCert([])).certPem);
  assert.equal(
    agentCertProblem(other, ca, keyFingerprint(mine)),
    "its key is not the one Deplo pinned",
  );
  assert.match(
    agentCertProblem(
      mine,
      ca,
      keyFingerprint(mine),
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    )!,
    /does not verify/,
  );
  assert.equal(
    agentCertProblem(ca, ca, keyFingerprint(ca)),
    "it presented a certificate authority",
  );
  const client = new X509Certificate(
    (await issueControlPlaneClientCert()).certPem,
  );
  assert.equal(
    agentCertProblem(client, ca, keyFingerprint(client)),
    "its certificate is not a server agent's",
  );
});
