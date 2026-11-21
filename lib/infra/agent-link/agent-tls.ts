import "server-only";

import { createHash, X509Certificate } from "node:crypto";
import type { Duplex } from "node:stream";
import tls from "node:tls";

const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
// A certificate's dates are its renewal schedule, never a reason to lock a server out (ADR-0050).
const DATE_ONLY = new Set(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"]);

/** sha256 of a certificate's public key, lowercase hex: the agent's identity (ADR-0050). */
export function keyFingerprint(cert: string | X509Certificate): string {
  const x = typeof cert === "string" ? new X509Certificate(cert) : cert;
  const spki = x.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("hex");
}

/** Why the agent's certificate is not the pinned server's, or null when it is. */
export function agentCertProblem(
  peer: X509Certificate,
  ca: X509Certificate,
  pinnedKey: string,
  chainError?: string | null,
): string | null {
  if (chainError && !DATE_ONLY.has(chainError))
    return `its certificate does not verify (${chainError})`;
  if (!peer.checkIssued(ca) || !peer.verify(ca.publicKey))
    return "its certificate was not signed by this Deplo";
  if (peer.ca) return "it presented a certificate authority";
  if (!(peer.keyUsage ?? []).includes(EKU_SERVER_AUTH))
    return "its certificate is not a server agent's";
  if (keyFingerprint(peer) !== pinnedKey)
    return "its key is not the one Deplo pinned";
  return null;
}

export class AgentTrustError extends Error {}

/** The mTLS handshake inside a link: Deplo's client certificate out, the agent's checked against the pinned key. */
export function agentTls(
  stream: Duplex,
  pinnedKey: string,
  creds: { certPem: string; keyPem: string; caPem: string },
  timeoutMs: number,
): Promise<tls.TLSSocket> {
  const ca = new X509Certificate(creds.caPem);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      socket: stream,
      servername: "localhost",
      ca: creds.caPem,
      cert: creds.certPem,
      key: creds.keyPem,
      minVersion: "TLSv1.2",
      ALPNProtocols: ["h2"],
      // The CA and the pinned key decide, below; Node's own verdict is read there, never ignored.
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    });
    // The caller closes the link with a reason; that ends this session with it.
    const fail = (e: Error) => {
      clearTimeout(timer);
      sock.on("error", () => {});
      reject(e);
    };
    const timer = setTimeout(
      () => fail(new AgentTrustError("the handshake timed out")),
      timeoutMs,
    );
    sock.once("error", fail);
    sock.once("secureConnect", () => {
      const peer = sock.getPeerX509Certificate();
      const problem = peer
        ? agentCertProblem(
            peer,
            ca,
            pinnedKey,
            sock.authorized ? null : String(sock.authorizationError ?? ""),
          )
        : "it presented no certificate";
      if (problem) return fail(new AgentTrustError(problem));
      clearTimeout(timer);
      sock.off("error", fail);
      sock.on("error", () => {});
      resolve(sock);
    });
  });
}
