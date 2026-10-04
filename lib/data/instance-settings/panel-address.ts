import "server-only";

import { requireInstanceAdmin } from "../../membership";
import { isDeploHostServer } from "../../deploy/domains";
import { classifyDnsRecords, type DnsTargets } from "../../deploy/cloudflare";
import { resolveHostIpv4, resolveHostIpv6 } from "../domains/dns-resolve";
import { isIpLiteral } from "../../host-address";
import { serverAddresses } from "../servers/addresses";
import { listAllServers } from "../servers/roster";
import { getInstanceSettings } from "./settings-store";

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

export function normalizePanelUrl(input: string): string {
  const raw = input.trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      `"${raw}" is not an address. Use a domain like deplo.example.com`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error("The panel address must start with https:// or http://");
  if (parsed.username || parsed.password)
    throw new Error("The panel address cannot carry a username or password");
  if (parsed.pathname !== "/" && parsed.pathname !== "")
    throw new Error("The panel address is a host, without a path after it");
  if (isIpLiteral(parsed.hostname))
    throw new Error(
      "The panel address is a domain name, not an IP address. Deplo generates one for you if you have none.",
    );
  if (!HOST_RE.test(parsed.host))
    throw new Error(`"${parsed.host}" is not a valid hostname`);
  return `${parsed.protocol}//${parsed.host}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function schemeOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

export function noRouteReason(url: string): string | null {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  const routable = host.includes(".") && !isIpLiteral(host);
  return routable
    ? null
    : "This panel is not served through a proxy Deplo manages. Give it a domain address above first.";
}

export type PanelDnsStatus =
  "valid" | "cloudflare" | "misconfigured" | "pending" | "unknown";

export interface PanelDns {
  status: PanelDnsStatus;
  host: string;
  resolved: string[];
  ipv6: string | null;
}

export async function checkPanelDns(): Promise<PanelDns> {
  await requireInstanceAdmin();
  const settings = await getInstanceSettings();
  let host = "";
  try {
    host = new URL(settings.panelUrl).hostname;
  } catch {
    host = "";
  }
  const targets = await panelTargets(settings.deploHostIp);
  const ipv6 = targets.v6[0] ?? null;
  if (
    !host ||
    isIpLiteral(host) ||
    (targets.v4.length === 0 && targets.v6.length === 0)
  )
    return { status: "unknown", host, resolved: [], ipv6 };

  const [a, aaaa] = await Promise.all([
    resolveHostIpv4(host),
    resolveHostIpv6(host),
  ]);
  const resolved = [...a, ...aaaa];
  if (resolved.length === 0) return { status: "pending", host, resolved, ipv6 };
  return {
    status: classifyDnsRecords({ a, aaaa }, targets).status,
    host,
    resolved,
    ipv6,
  };
}

async function panelTargets(deploHostIp: string | null): Promise<DnsTargets> {
  const self = (await listAllServers()).find((s) => isDeploHostServer(s));
  const known = await serverAddresses(self ?? null);
  const v4 = deploHostIp ? [...new Set([deploHostIp, ...known.v4])] : known.v4;
  return { ...known, v4 };
}
