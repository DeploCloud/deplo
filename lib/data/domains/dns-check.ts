import "server-only";

import { resolve4 } from "node:dns/promises";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { dispatchAlert } from "../../notify/dispatch";
import { resolveServerIp } from "../../deploy/domains";
import {
  classifyDomainDns,
  certProviderForDns,
  isRoutableDomain,
  type DomainDnsClass,
} from "../../deploy/cloudflare";
import { loadDomain, loadAppGraph } from "../app-graph-load";
import { requireAppCapability } from "../node-access";
import { getServerById } from "../servers/roster";
import type { Domain } from "../../types/domain";
import { syncProductionUrl } from "./primary-domain";

let dnsResolve4: (name: string) => Promise<string[]> = resolve4;

export function __setDnsResolve4ForTest(
  fn: (name: string) => Promise<string[]>,
): void {
  dnsResolve4 = fn;
}

export function __resetDnsResolve4ForTest(): void {
  dnsResolve4 = resolve4;
}

export async function resolveHostIpv4(name: string): Promise<string[]> {
  try {
    return await dnsResolve4(name);
  } catch {
    return [];
  }
}

export async function appServerIp(appId: string): Promise<string> {
  const project = await loadAppGraph(appId);
  const server = project?.serverId
    ? await getServerById(project.serverId)
    : null;
  return resolveServerIp(server ?? undefined);
}

export async function checkDomainDns(
  name: string,
  target: string,
): Promise<"pending" | DomainDnsClass> {
  let ips: string[] = [];
  try {
    ips = await dnsResolve4(name);
  } catch {
    ips = [];
  }
  if (ips.length === 0) return "pending";
  return classifyDomainDns(ips, target);
}

export async function verifyDomain(
  id: string,
): Promise<Domain & { statusChanged: boolean }> {
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  await requireAppCapability(dom.appId, "manage_domains");

  const target = await appServerIp(dom.appId);
  const status = await checkDomainDns(dom.name, target);
  const ssl = isRoutableDomain({ status, proxied: dom.proxied });
  const certProvider = certProviderForDns(status, dom.certProvider);
  const providerChanged = certProvider !== dom.certProvider;
  const statusChanged =
    status !== dom.status || ssl !== dom.ssl || providerChanged;

  const updated = await getDb()
    .update(domainsTable)
    .set({ status, ssl, ...(providerChanged ? { certProvider } : {}) })
    .where(eq(domainsTable.id, id))
    .returning();
  if (updated.length === 0) throw new Error("Not found");
  if (providerChanged) await syncProductionUrl(dom.appId);
  return { ...dom, status, ssl, certProvider, statusChanged };
}

export async function sweepDomainDns(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({
      id: domainsTable.id,
      name: domainsTable.name,
      appId: domainsTable.appId,
      teamId: appsTable.teamId,
      slug: appsTable.slug,
      appName: appsTable.name,
      proxied: domainsTable.proxied,
    })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(eq(domainsTable.status, "valid"));

  for (const row of rows) {
    if (row.proxied) continue;
    try {
      const status = await checkDomainDns(
        row.name,
        await appServerIp(row.appId),
      );
      if (status === "valid") continue;
      await db
        .update(domainsTable)
        .set({ status, ssl: status === "cloudflare" })
        .where(eq(domainsTable.id, row.id));
      dispatchAlert({
        teamId: row.teamId,
        key: "domain_dns_drift",
        dedupe: { id: `dns:${row.id}`, state: status },
        title: `${row.name} no longer points here`,
        body:
          status === "pending"
            ? "It stopped resolving. Traffic and certificate renewals will fail."
            : `Its DNS now answers with an address that is not ${row.appName}'s server.`,
        path: `/apps/${row.slug}`,
      });
    } catch (e) {
      console.warn(`[deplo] dns sweep failed for ${row.name}:`, e);
    }
  }
}
