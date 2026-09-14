import "server-only";

import { requireInstanceAdmin } from "../../membership";
import { isIpv4 } from "../../deploy/domains";
import { classifyDomainDns } from "../../deploy/cloudflare";
import { resolveHostIpv4 } from "../domains/dns-check";
import { getInstanceSettings } from "./settings-store";

// The host shape `lib/public-url.ts` accepts: no metacharacters, ever.
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

// "deplo.example.com" -> "https://deplo.example.com". A bare host gets HTTPS,
// because that is what the certificate will be issued for; an explicit `http://`
// is kept as the advanced opt-out for a panel no certificate can be issued for.
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
  // No certificate authority issues for a bare address, and the panel is not
  // served without one. Deplo generates a hostname rather than offering this.
  if (isIpv4(parsed.hostname))
    throw new Error(
      "The panel address is a domain name, not an IP address. Deplo generates one for you if you have none.",
    );
  return `${parsed.protocol}//${parsed.host}`;
}

// The two halves of an address that decide whether an origin moved.
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

// Why there is no route of ours, in words that name the actual fix: a domain, or
// the installer re-run - and telling one to do the other is worse than nothing.
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

// What DNS says about the address the panel answers on.
export type PanelDnsStatus =
  "valid" | "cloudflare" | "misconfigured" | "pending" | "unknown";

export interface PanelDns {
  status: PanelDnsStatus;
  // The hostname that was resolved, or "" when there was nothing to resolve.
  host: string;
  // The addresses it answered with - what a misconfigured record is pointing at.
  resolved: string[];
}

// Resolve the panel's own hostname and say what it found: the same classification
// a custom domain gets, with `unknown` for the cases there is nothing to check.
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
  // A literal address needs no record, and without the host's own IP there is
  // nothing to compare against.
  if (!host || isIpv4(host) || !target)
    return { status: "unknown", host, resolved: [] };

  const resolved = await resolveHostIpv4(host);
  if (resolved.length === 0) return { status: "pending", host, resolved };
  return { status: classifyDomainDns(resolved, target), host, resolved };
}
