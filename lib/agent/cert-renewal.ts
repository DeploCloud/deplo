import "server-only";

import { X509Certificate } from "node:crypto";

import { eq, isNotNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { connectAgent, connectAgentAt } from "../infra/agent-client/connect";
import { dispatchServerAlert } from "../notify/dispatch";
import { signAgentCsr } from "./pki";

export const CERT_RENEWAL_CAPABILITY = "cert-renewal";

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
      return {
        renewed: false,
        reason: "agent lacks the cert-renewal capability",
      };

    const { csrPem } = await conn.renewalCsr();
    const dialHosts = [row.ip, row.host].filter(Boolean) as string[];
    const signed = await signAgentCsr(csrPem, dialHosts);
    // Install and hot-swap first, repin after: repinning a cert the agent never installed locks Deplo out.
    const res = await conn.installRenewedCert({
      certPem: signed.certPem,
      caPem: "",
    });
    if (!res.ok)
      return { renewed: false, reason: `agent rejected install: ${res.error}` };
    await getDb()
      .update(serversTable)
      .set({
        agentCertPem: signed.certPem,
        agentCertFingerprint: signed.fingerprint,
      })
      .where(eq(serversTable.id, serverId));
    return {
      renewed: true,
      reason: `renewed until ${notAfterOf(signed.certPem)}`,
    };
  } finally {
    conn.close();
  }
}

export async function renewAgentCert(
  serverId: string,
  dialHosts: string[],
  at?: { ip?: string; host?: string; agentPort?: number },
): Promise<void> {
  const conn = at
    ? await connectAgentAt(serverId, at)
    : await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(CERT_RENEWAL_CAPABILITY))
      throw new Error(
        "the agent does not support certificate renewal - update it first",
      );
    const { csrPem } = await conn.renewalCsr();
    const signed = await signAgentCsr(csrPem, dialHosts);
    const res = await conn.installRenewedCert({
      certPem: signed.certPem,
      caPem: "",
    });
    if (!res.ok)
      throw new Error(`agent rejected the renewed certificate: ${res.error}`);
    await getDb()
      .update(serversTable)
      .set({
        agentCertPem: signed.certPem,
        agentCertFingerprint: signed.fingerprint,
      })
      .where(eq(serversTable.id, serverId));
  } finally {
    conn.close();
  }
}

function notAfterOf(certPem: string): string {
  const d = leafNotAfter(certPem);
  return d ? d.toISOString() : "unknown";
}

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
      const why = e instanceof Error ? e.message : String(e);
      console.warn(`[cert-renewal] ${s.name} (${s.id}): ${why}`);
      dispatchServerAlert(s.id, {
        key: "agent_certificate_failed",
        dedupe: { id: `certrenew:${s.id}`, state: "failed" },
        title: `Could not renew the agent certificate on ${s.name}`,
        body: `${why} Deplo will lose access to this server when it expires.`,
        path: "/settings/servers",
      });
    }
  }
}
