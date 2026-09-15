import yaml from "../../yaml";

import { INFRA_NETWORK, PLATFORM_NETWORKS, isTenantNetwork } from "../network";
import {
  composeTruthy,
  interpolates,
  isInterpolated,
  loadComposeDoc,
  servicesOf,
} from "./document";

export const RESERVED_SHARED_NETWORK_NAMES = new Set([
  "deplo",
  "postgres",
  "traefik",
  "deplo-traefik",
  "deplo-socket-proxy",
  "docker-socket-proxy",
]);

export function isReservedSharedName(name: string): boolean {
  return RESERVED_SHARED_NETWORK_NAMES.has(name.trim().toLowerCase());
}

export function serviceClaimedNames(name: string, svc: unknown): string[] {
  const out = [name];
  const host =
    svc && typeof svc === "object" && !Array.isArray(svc)
      ? (svc as Record<string, unknown>).hostname
      : null;
  if (typeof host === "string" && host.trim() !== "") out.push(host.trim());
  return out;
}

export function composeClaimedNames(composeYaml: string): string[] {
  const doc = loadComposeDoc<{ services?: Record<string, unknown> }>(
    composeYaml,
  );
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return [];
  const out = new Set<string>();
  for (const [name, svc] of Object.entries(services))
    for (const claimed of serviceClaimedNames(name, svc))
      out.add(claimed.toLowerCase());
  return [...out];
}

export function composeServiceReservedClaim(
  composeYaml: string | null | undefined,
  service: string,
): string | null {
  if (!composeYaml) return isReservedSharedName(service) ? service : null;
  let doc: { services?: Record<string, unknown> } | null;
  try {
    doc = yaml.load(composeYaml) as {
      services?: Record<string, unknown>;
    } | null;
  } catch {
    return null;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return isReservedSharedName(service) ? service : null;
  return serviceReservedClaim(service, services[service]);
}

export function serviceReservedClaim(
  name: string,
  svc: unknown,
): string | null {
  return serviceClaimedNames(name, svc).find(isReservedSharedName) ?? null;
}

function resolvedNetworkName(key: string, raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.name === "string" && n.name.trim() !== "") return n.name.trim();
  const ext = n.external;
  if (ext && typeof ext === "object" && !Array.isArray(ext)) {
    const name = (ext as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim() !== "") return name.trim();
    return key;
  }
  return composeTruthy(ext) ? key : null;
}

export function isDeploNetwork(name: string): boolean {
  const n = name.trim();
  if (isTenantNetwork(n)) return true;
  if ((PLATFORM_NETWORKS as readonly string[]).includes(n)) return true;
  if (n.endsWith("_deplo-socket") || n.endsWith("_deplo-internal")) return true;
  return /^deplo-[a-z0-9][a-z0-9_.-]*_default$/i.test(n);
}

export function sharedNetworkKeys(doc: { networks?: unknown }): Set<string> {
  const keys = new Set<string>([INFRA_NETWORK]);
  const declared = doc.networks;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return keys;
  for (const [key, raw] of Object.entries(
    declared as Record<string, unknown>,
  )) {
    const target = resolvedNetworkName(key, raw);
    if (target && isDeploNetwork(target)) keys.add(key);
  }
  return keys;
}

function joinsSharedNetwork(
  svc: Record<string, unknown>,
  shared: Set<string>,
): boolean {
  if (shared.size === 0) return false;
  const n = svc.networks;
  const keys = Array.isArray(n)
    ? n.map(String)
    : n && typeof n === "object"
      ? Object.keys(n as object)
      : null;
  if (keys) return keys.some((k) => shared.has(k) || interpolates(k));
  return shared.has("default");
}

export function composeClaimsReservedName(composeYaml: string): string | null {
  const doc = loadComposeDoc<{
    services?: Record<string, unknown>;
    networks?: unknown;
  }>(composeYaml);
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return null;
  const shared = sharedNetworkKeys(doc ?? {});
  for (const [name, raw] of Object.entries(services)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (!joinsSharedNetwork(raw as Record<string, unknown>, shared)) continue;
    const claim = serviceReservedClaim(name, raw);
    if (claim) return claim;
  }
  return null;
}

export function reservedNameMessage(claimed: string): string {
  return (
    `\`${claimed}\` is a name Deplo's own infrastructure answers to, and the proxy ` +
    `resolves it from inside your network - two containers claiming one name split ` +
    `the traffic between them. Rename the service, or its \`hostname:\` if that is ` +
    `what this names.`
  );
}

export function composeInterpolatedHostname(
  composeYaml: string,
): string | null {
  const services = servicesOf(composeYaml);
  if (!services) return null;
  for (const [name, svc] of Object.entries(services)) {
    const host = (svc as Record<string, unknown> | null)?.hostname;
    if (isInterpolated(host)) return name;
  }
  return null;
}

export function interpolatedHostnameMessage(service: string): string {
  return (
    `\`hostname\` on service \`${service}\` is filled in from a variable, so Deplo ` +
    `cannot tell which name that container answers to on its network. Write the ` +
    `value in the compose file.`
  );
}

function foreignNetworkKeys(networks: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(networks)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    const target = resolvedNetworkName(key, raw);
    if (target !== null && isDeploNetwork(target)) continue;
    const pinnedName =
      typeof n.name === "string" && n.name.trim() !== "" ? n.name.trim() : null;
    const pinned =
      (n.external != null && n.external !== false) ||
      pinnedName !== null ||
      (n.driver_opts != null &&
        typeof n.driver_opts === "object" &&
        Object.keys(n.driver_opts as object).length > 0) ||
      (typeof n.driver === "string" &&
        /^(macvlan|ipvlan|host)$/i.test(n.driver.trim()));
    if (pinned) out.push(key);
  }
  return out;
}

export function composeJoinsForeignNetwork(composeYaml: string): boolean {
  const doc = loadComposeDoc<{
    services?: Record<string, unknown>;
    networks?: unknown;
  }>(composeYaml);
  const declared =
    doc?.networks &&
    typeof doc.networks === "object" &&
    !Array.isArray(doc.networks)
      ? (doc.networks as Record<string, unknown>)
      : {};
  const foreign = new Set(foreignNetworkKeys(declared));
  if (foreign.size === 0) return false;
  const services = doc?.services;
  if (!services || typeof services !== "object") return false;
  for (const raw of Object.values(services)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (joinsSharedNetwork(raw as Record<string, unknown>, foreign))
      return true;
  }
  return false;
}
