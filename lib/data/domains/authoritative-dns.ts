import "server-only";

import { Resolver } from "node:dns/promises";

import { canonicalIpv6 } from "../../host-address";

// A domain's DNS is read where it is written: its zone's own name servers, never a resolver's cache, which can
// hold a record the zone already changed for as long as its TTL (problem 4 of 22 Nov 2026).

type RecordType = "NS" | "A" | "AAAA" | "CNAME";
/** Asks these servers (none: the system's resolver) for a record; [] when it has none, null when asking failed. */
export type DnsAsk = (
  servers: string[],
  name: string,
  type: RecordType,
) => Promise<string[] | null>;

const defaultAsk: DnsAsk = async (servers, name, type) => {
  const r = new Resolver({ timeout: 3_000, tries: 2 });
  if (servers.length) r.setServers(servers);
  try {
    switch (type) {
      case "NS":
        return await r.resolveNs(name);
      case "A":
        return await r.resolve4(name);
      case "AAAA":
        return (await r.resolve6(name)).map((a) => canonicalIpv6(a) ?? a);
      case "CNAME":
        return await r.resolveCname(name);
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code === "ENODATA" || code === "ENOTFOUND" ? [] : null;
  }
};

let ask: DnsAsk = defaultAsk;
export function __setAuthoritativeAskForTest(fn: DnsAsk | null): void {
  ask = fn ?? defaultAsk;
}

/** The addresses of the name servers of the zone a name is in: the nearest of its suffixes that has NS records. */
async function zoneServers(name: string): Promise<string[] | null> {
  const labels = name.replace(/\.$/, "").split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join(".");
    const ns = await ask([], suffix, "NS");
    if (ns === null) return null;
    if (ns.length === 0) continue;
    const addrs = (
      await Promise.all(
        ns.flatMap((n) => [ask([], n, "A"), ask([], n, "AAAA")]),
      )
    ).flatMap((a) => a ?? []);
    return addrs.length ? addrs : null;
  }
  return null;
}

/**
 * A name's A and AAAA records as its zone's own name servers answer them, following CNAMEs into other zones (a
 * cluster domain's CNAME into its zone is answered by the cluster). Null when they could not be asked.
 */
export async function authoritativeAddresses(
  name: string,
): Promise<{ a: string[]; aaaa: string[]; via: string[] } | null> {
  let current = name.replace(/\.$/, "");
  const via: string[] = [];
  for (let hop = 0; hop < 4; hop++) {
    const servers = await zoneServers(current);
    if (!servers) return null;
    const cname = await ask(servers, current, "CNAME");
    if (cname === null) return null;
    if (cname.length) {
      current = cname[0].replace(/\.$/, "");
      via.push(current);
      continue;
    }
    const [a, aaaa] = await Promise.all([
      ask(servers, current, "A"),
      ask(servers, current, "AAAA"),
    ]);
    if (a === null || aaaa === null) return null;
    return { a, aaaa, via };
  }
  return null;
}

/** A name's CNAME as its zone's own name servers answer it: [] for none, null when they could not be asked. */
export async function authoritativeCname(
  name: string,
): Promise<string[] | null> {
  const servers = await zoneServers(name);
  return servers ? ask(servers, name.replace(/\.$/, ""), "CNAME") : null;
}
