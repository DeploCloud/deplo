import "server-only";

import { domainTlsConfig, domainScheme } from "../../deploy/domains";
import { isRoutableDomain } from "../../deploy/cloudflare";
import { loadDomainsForApp } from "../app-graph-load";
import type {
  CertProvider,
  Domain,
  DomainEntrypoint,
} from "../../types/domain";

// RoutableDomain: a routable hostname plus everything its Traefik router needs.
export interface RoutableDomain {
  name: string;
  port: number | null;
  entrypoint: string;
  tls: boolean;
  /** Resolved ACME resolver name. Empty when `tls` is false, and also when the
   *  provider is `custom` - a certificate already in the proxy's store asks no
   *  ACME provider for one. */
  certResolver: string;
  middlewares: string[];
  pathPrefix: string;
  stripPrefix: boolean;
  service: string | null;
  /** Absolute base URL this host permanently redirects to, or "" when it serves the app. */
  redirectTo: string;
}

// defaultRoute: a RoutableDomain for a bare hostname carrying no per-domain config.
export function defaultRoute(
  name: string,
  service: string | null = null,
  port: number | null = null,
  tls: { entrypoint?: DomainEntrypoint; certProvider?: CertProvider } = {},
): RoutableDomain {
  return {
    name,
    port,
    ...domainTlsConfig(tls),
    middlewares: [],
    pathPrefix: "",
    stripPrefix: false,
    service,
    redirectTo: "",
  };
}

// routableRoutes: valid, routable hostnames for a project (primary first).
export async function routableRoutes(appId: string): Promise<RoutableDomain[]> {
  const all = await loadDomainsForApp(appId);
  return (
    all
      // Points straight here, or a proxy answers for it (detected or declared);
      // a host with no working DNS and nothing in front is left off the router.
      .filter(isRoutableDomain)
      .sort((a, b) => Number(b.primary) - Number(a.primary))
      // Every row is mapped against the app's FULL domain set, because a
      // redirecting host resolves its target's scheme from the target's own row.
      .map((d) => toRoutableDomain(d, all))
  );
}

// toRoutableDomain: the stored row → the route its Traefik router is rendered from.
export function toRoutableDomain(
  d: Domain,
  siblings: Domain[] = [],
): RoutableDomain {
  return {
    name: d.name,
    port: d.port ?? null,
    ...domainTlsConfig(d),
    middlewares: d.middlewares ?? [],
    pathPrefix: d.pathPrefix ?? "",
    stripPrefix: Boolean(d.stripPrefix),
    service: d.service ?? null,
    redirectTo: redirectTargetUrl(d, siblings),
  };
}

function redirectTargetUrl(d: Domain, siblings: Domain[]): string {
  const target = (d.redirectTo ?? "").trim().toLowerCase();
  if (!target || target === d.name) return "";
  const row = siblings.find((s) => s.name === target);
  if (row?.redirectTo) return "";
  return `${domainScheme(row ?? d)}://${target}`;
}

// pendingPrimaryRoute: the primary's stored row as a route, verified or NOT - the
// fallback a deploy uses before the canonical host has passed its DNS check.
export async function pendingPrimaryRoute(
  appId: string,
  primary: string,
): Promise<RoutableDomain | null> {
  if (!primary) return null;
  const all = await loadDomainsForApp(appId);
  const rows = all.filter((d) => d.name === primary);
  // A hostname can carry SEVERAL rows (one per path), so prefer the one flagged
  // primary rather than routing an arbitrary sibling's path as the canonical host.
  const row = rows.find((d) => d.primary) ?? rows[0];
  return row ? toRoutableDomain(row, all) : null;
}
