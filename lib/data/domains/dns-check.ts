import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { dispatchAlert } from "../../notify/dispatch";
import {
  classifyDnsRecords,
  certProviderForDns,
  isRoutableDomain,
  type DnsTargets,
  type DomainDnsClass,
  type StrayRecord,
} from "../../deploy/cloudflare";
import { loadDomain, loadAppGraph } from "../app-graph-load";
import { hasAppCapability, requireAppCapability } from "../node-access";
import { getServerById } from "../servers/roster";
import { serverAddresses } from "../servers/addresses";
import type { Domain } from "../../types/domain";
import { syncProductionUrl } from "./primary-domain";
import { resolveHostIpv4, resolveHostIpv6 } from "./dns-resolve";

export {
  __resetDnsResolve4ForTest,
  __setDnsResolve4ForTest,
  __setDnsResolve6ForTest,
  resolveHostIpv4,
} from "./dns-resolve";

export async function appServerAddresses(appId: string): Promise<DnsTargets> {
  const project = await loadAppGraph(appId);
  const server = project?.serverId
    ? await getServerById(project.serverId)
    : null;
  return serverAddresses(server);
}

export interface DomainDnsCheck {
  status: "pending" | DomainDnsClass;
  stray: StrayRecord | null;
}

export async function inspectDomainDns(
  name: string,
  targets: DnsTargets,
): Promise<DomainDnsCheck> {
  const [a, aaaa] = await Promise.all([
    resolveHostIpv4(name),
    resolveHostIpv6(name),
  ]);
  if (a.length === 0 && aaaa.length === 0)
    return { status: "pending", stray: null };
  return classifyDnsRecords({ a, aaaa }, targets);
}

export async function checkDomainDns(
  name: string,
  targets: DnsTargets,
): Promise<"pending" | DomainDnsClass> {
  return (await inspectDomainDns(name, targets)).status;
}

export interface DomainDnsHints {
  serverIpv6: string | null;
  strays: Record<string, StrayRecord>;
}

// Read live for the rows that show a DNS problem: the IPv6 to point an AAAA at, and the record that is wrong.
export async function domainDnsHints(
  appId: string,
  domains: Pick<Domain, "id" | "name" | "status" | "proxied">[],
): Promise<DomainDnsHints> {
  const open = domains.filter(
    (d) =>
      !d.proxied && (d.status === "misconfigured" || d.status === "pending"),
  );
  if (open.length === 0 || !(await hasAppCapability(appId, "view")))
    return { serverIpv6: null, strays: {} };
  const targets = await appServerAddresses(appId);
  const strays: Record<string, StrayRecord> = {};
  await Promise.all(
    open
      .filter((d) => d.status === "misconfigured")
      .map(async (d) => {
        const { stray } = await inspectDomainDns(d.name, targets);
        if (stray) strays[d.id] = stray;
      }),
  );
  return { serverIpv6: targets.v6[0] ?? null, strays };
}

export async function verifyDomain(
  id: string,
): Promise<Domain & { statusChanged: boolean }> {
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  await requireAppCapability(dom.appId, "manage_domains");

  const status = await checkDomainDns(
    dom.name,
    await appServerAddresses(dom.appId),
  );
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

  const targets = new Map<string, Promise<DnsTargets>>();
  for (const row of rows) {
    if (row.proxied) continue;
    try {
      if (!targets.has(row.appId))
        targets.set(row.appId, appServerAddresses(row.appId));
      const { status, stray } = await inspectDomainDns(
        row.name,
        await targets.get(row.appId)!,
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
            : stray
              ? `Its ${stray.type} record now points at ${stray.address}, not ${row.appName}'s server.`
              : `Its DNS now answers with an address that is not ${row.appName}'s server.`,
        path: `/apps/${row.slug}`,
      });
    } catch (e) {
      console.warn(`[deplo] dns sweep failed for ${row.name}:`, e);
    }
  }
}
