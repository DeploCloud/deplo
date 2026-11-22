import "server-only";

import { X509Certificate } from "node:crypto";

import { eq, isNotNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { connectAgent } from "../infra/agent-client/connect";
import { repinAgentLink } from "../infra/agent-link/registry";
import { dispatchServerAlert } from "../notify/dispatch";
import { signAgentCsr } from "./pki";
import {
  dropNextCert,
  promoteNextCert,
  stageNextCert,
} from "../data/servers/agent-identity";
import { instanceFrozen } from "../data/deplo-move/freeze";
import { pushRostersForServer } from "../data/clusters/relay";

export const CERT_RENEWAL_CAPABILITY = "cert-renewal";

const RENEWAL_WINDOW_MS = 30 * 24 * 3_600_000;
/** The key rotates this often over the link, so a copy that misses one is locked out (ADR-0050). */
export const KEY_ROTATION_MS = 30 * 24 * 3_600_000;

function leafDates(certPem: string): { from: Date; to: Date } | null {
  try {
    const x = new X509Certificate(certPem);
    const from = new Date(x.validFrom);
    const to = new Date(x.validTo);
    return isNaN(from.getTime()) || isNaN(to.getTime()) ? null : { from, to };
  } catch {
    return null;
  }
}

function leafNotAfter(certPem: string): Date | null {
  return leafDates(certPem)?.to ?? null;
}

/** Its dates are a schedule: due once its key is a rotation old, or its date is near or gone. */
export function rotationDue(certPem: string, now = Date.now()): boolean | null {
  const d = leafDates(certPem);
  if (!d) return null;
  return (
    d.to.getTime() - now <= RENEWAL_WINDOW_MS ||
    now - d.from.getTime() >= KEY_ROTATION_MS
  );
}

type Renewal = { renewed: boolean; reason: string };
const renewing = new Map<string, Promise<Renewal>>();

/** One rotation per server at a time: a second would replace the agent's pending key under the first. */
export function renewAgentCertIfDue(serverId: string): Promise<Renewal> {
  const running = renewing.get(serverId);
  if (running) return running;
  const run = renewNow(serverId).finally(() => renewing.delete(serverId));
  renewing.set(serverId, run);
  return run;
}

async function renewNow(serverId: string): Promise<Renewal> {
  const [row] = await getDb()
    .select({
      ip: serversTable.ip,
      host: serversTable.host,
      certPem: serversTable.agentCertPem,
      fingerprint: serversTable.agentCertFingerprint,
    })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  if (!row?.certPem) return { renewed: false, reason: "no stored agent cert" };
  const due = rotationDue(row.certPem);
  if (due === null)
    return { renewed: false, reason: "unparseable stored cert" };
  if (!due) return { renewed: false, reason: "not due" };

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
    // Staged before the agent installs it: a rotation cut halfway leaves a key the door still takes.
    await stageNextCert(serverId, signed);
    const res = await conn.installRenewedCert({
      certPem: signed.certPem,
      caPem: "",
    });
    if (!res.ok) {
      await dropNextCert(serverId, signed.fingerprint);
      return { renewed: false, reason: `agent rejected install: ${res.error}` };
    }
    if (!(await promoteNextCert(serverId, signed.fingerprint)))
      return { renewed: false, reason: "its link promoted the new key first" };
    // The rotation ran over this machine's own link: it stays open, so no call on it is cut; the next link proves the new key.
    if (row.fingerprint)
      repinAgentLink(serverId, row.fingerprint, signed.fingerprint);
    // The old certificate is cut off at every cluster relay at once.
    await pushRostersForServer(serverId);
    return {
      renewed: true,
      reason: `renewed until ${notAfterOf(signed.certPem)}`,
    };
  } finally {
    conn.close();
  }
}

function notAfterOf(certPem: string): string {
  const d = leafNotAfter(certPem);
  return d ? d.toISOString() : "unknown";
}

export async function sweepExpiringAgentCerts(): Promise<void> {
  if (await instanceFrozen()) return;
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
        title: `Could not renew the agent's key on ${s.name}`,
        body: `${why} The server keeps working, and Deplo tries again in 12 hours.`,
        path: "/settings/servers",
      });
    }
  }
}
