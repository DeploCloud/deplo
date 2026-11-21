import "server-only";

import { domainTlsConfig, domainScheme } from "../../deploy/domains";
import { ANSWER_ENTRYPOINT } from "../../deploy/answer";
import { DNS_CHALLENGE_RESOLVER } from "../../deploy/dns-challenge";
import { isServedDomain } from "../../deploy/cloudflare";
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
  securityHeaders: boolean;
  corsOrigins: string[];
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
    securityHeaders: false,
    corsOrigins: [],
    pathPrefix: "",
    stripPrefix: false,
    service,
    redirectTo: "",
  };
}

export async function routableRoutes(appId: string): Promise<RoutableDomain[]> {
  const all = await loadDomainsForApp(appId);
  return all
    .filter(isServedDomain)
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((d) => toRoutableDomain(d, all));
}

export function toRoutableDomain(
  d: Domain,
  siblings: Domain[] = [],
): RoutableDomain {
  const tls = domainTlsConfig(d);
  // Passed on by every server of the cluster, it reaches the App's proxy on the internal entrypoint (ADR-0048).
  if (d.answersEverywhere && tls.tls)
    tls.entrypoint = `${tls.entrypoint},${ANSWER_ENTRYPOINT}`;
  // The cluster's zone checks its certificate over DNS: the zone's or its own, renewed by one server and held by
  // every other, or its own ordered by this App's server over DNS.
  if (
    d.answersEverywhere &&
    d.certChallenge &&
    tls.tls &&
    (d.certProvider ?? "letsencrypt") === "letsencrypt"
  )
    tls.certResolver = d.certChallenge === "dns" ? DNS_CHALLENGE_RESOLVER : "";
  return {
    name: d.name,
    port: d.port ?? null,
    ...tls,
    middlewares: d.middlewares ?? [],
    securityHeaders: d.securityHeaders === true,
    corsOrigins: d.corsOrigins ?? [],
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
