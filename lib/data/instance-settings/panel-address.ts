import "server-only";

import { requireInstanceAdmin } from "../../membership";
import { isIpv4 } from "../../deploy/domains";
import { classifyDomainDns } from "../../deploy/cloudflare";
import { resolveHostIpv4 } from "../domains/dns-check";
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
  if (!HOST_RE.test(parsed.host))
    throw new Error(`"${parsed.host}" is not a valid hostname`);
  if (isIpv4(parsed.hostname))
    throw new Error(
      "The panel address is a domain name, not an IP address. Deplo generates one for you if you have none.",
    );
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
  const routable = host.includes(".") && !isIpv4(host);
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
  const target = settings.deploHostIp;
  if (!host || isIpv4(host) || !target)
    return { status: "unknown", host, resolved: [] };

  const resolved = await resolveHostIpv4(host);
  if (resolved.length === 0) return { status: "pending", host, resolved };
  return { status: classifyDomainDns(resolved, target), host, resolved };
}
