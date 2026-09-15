import "server-only";

import { domainTlsConfig, domainScheme } from "../../deploy/domains";
import { isRoutableDomain } from "../../deploy/cloudflare";
import { loadDomainsForApp } from "../app-graph-load";
import type {
  CertProvider,
  Domain,
  DomainEntrypoint,
} from "../../types/domain";

export interface RoutableDomain {
  name: string;
  port: number | null;
  entrypoint: string;
  tls: boolean;
  certResolver: string;
  middlewares: string[];
  pathPrefix: string;
  stripPrefix: boolean;
  service: string | null;
  redirectTo: string;
}

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

export async function routableRoutes(appId: string): Promise<RoutableDomain[]> {
  const all = await loadDomainsForApp(appId);
  return all
    .filter(isRoutableDomain)
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((d) => toRoutableDomain(d, all));
}

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

export async function pendingPrimaryRoute(
  appId: string,
  primary: string,
): Promise<RoutableDomain | null> {
  if (!primary) return null;
  const all = await loadDomainsForApp(appId);
  const rows = all.filter((d) => d.name === primary);
  const row = rows.find((d) => d.primary) ?? rows[0];
  return row ? toRoutableDomain(row, all) : null;
}
