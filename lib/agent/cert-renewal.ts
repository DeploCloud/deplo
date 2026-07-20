import "server-only";

import { X509Certificate } from "node:crypto";

import { eq, isNotNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { servers as serversTable } from "../db/schema/control-plane";
import { connectAgent } from "../infra/agent-client";
import { signAgentCsr } from "./pki";

/** Advertised by an agent that implements RenewalCSR + InstallRenewedCert. */
export const CERT_RENEWAL_CAPABILITY = "cert-renewal";

/**
 * Renew a leaf once it has less than this left. The leaf lives 365 days, so a
 * 30-day window gives a transient failure ~30 daily retries before the cert ever
 * expires — a renewal outage can never black out the fleet (the current cert
 * stays valid and pinned throughout).
 */
const RENEWAL_WINDOW_MS = 30 * 24 * 3_600_000;

function leafNotAfter(certPem: string): Date | null {
  try {
    const t = new X509Certificate(certPem).validTo;
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * Renew ONE server's agent mTLS leaf if it is within the renewal window. Drives
 * the two RPCs over the still-valid pinned channel (the agent authenticates with
 * its CURRENT cert), signs the fresh CSR with the CA, and — only if the agent
 * confirms the install — repins the Server row to the new cert + fingerprint.
 *
 * Fail-safe by construction: a not-yet-due cert is a no-op, and ANY failure
 * leaves the current cert live on both sides (it stays valid until expiry), so a
 * bug here degrades to "renew later", never to a dead agent.
 */
export async function renewAgentCertIfDue(
  serverId: string,
): Promise<{ renewed: boolean; reason: string }> {
  const [row] = await getDb()
    .select({
      ip: serversTable.ip,
      host: serversTable.host,
      certPem: serversTable.agentCertPem,
    })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  if (!row?.certPem) return { renewed: false, reason: "no stored agent cert" };
  const notAfter = leafNotAfter(row.certPem);
  if (!notAfter) return { renewed: false, reason: "unparseable stored cert" };
  if (notAfter.getTime() - Date.now() > RENEWAL_WINDOW_MS)
    return { renewed: false, reason: "not due" };

  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(CERT_RENEWAL_CAPABILITY))
      return { renewed: false, reason: "agent lacks the cert-renewal capability" };

    // 1. Agent mints a fresh keypair + CSR (its private key never leaves the host).
    const { csrPem } = await conn.renewalCsr();
    // 2. The CA re-signs, with the SAME dial addresses as SANs the bootstrap uses.
    const dialHosts = [row.ip, row.host].filter(Boolean) as string[];
    const signed = await signAgentCsr(csrPem, dialHosts);
    // 3. Agent installs + hot-swaps; only then do we repin.
    const res = await conn.installRenewedCert({ certPem: signed.certPem, caPem: "" });
    if (!res.ok) return { renewed: false, reason: `agent rejected install: ${res.error}` };
    await getDb()
      .update(serversTable)
      .set({
        agentCertPem: signed.certPem,
        agentCertFingerprint: signed.fingerprint,
      })
      .where(eq(serversTable.id, serverId));
    return { renewed: true, reason: `renewed until ${notAfterOf(signed.certPem)}` };
  } finally {
    conn.close();
  }
}

function notAfterOf(certPem: string): string {
  const d = leafNotAfter(certPem);
  return d ? d.toISOString() : "unknown";
}

/**
 * Renew every provisioned server whose agent leaf is within the window. Called on
 * a slow periodic tick; per-server failures are logged and never abort the sweep.
 */
export async function sweepExpiringAgentCerts(): Promise<void> {
  const rows = await getDb()
    .select({ id: serversTable.id, name: serversTable.name })
    .from(serversTable)
    .where(isNotNull(serversTable.agentCertPem));
  for (const s of rows) {
    try {
      const r = await renewAgentCertIfDue(s.id);
      if (r.renewed) console.log(`[cert-renewal] ${s.name}: ${r.reason}`);
    } catch (e) {
      console.warn(
        `[cert-renewal] ${s.name} (${s.id}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
