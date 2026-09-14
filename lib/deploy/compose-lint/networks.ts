import yaml from "../../yaml";

import { INFRA_NETWORK, PLATFORM_NETWORKS, isTenantNetwork } from "../network";
import {
  composeTruthy,
  interpolates,
  isInterpolated,
  loadComposeDoc,
  servicesOf,
} from "./document";

// The DNS names Deplo's own infrastructure answers to on a shared network: a
// container registers its SERVICE NAME there and Docker round-robins a claimed one,
// so `deplo` collects the panel's admin cookies and `postgres` its password.
export const RESERVED_SHARED_NETWORK_NAMES = new Set([
  "deplo",
  "postgres",
  "traefik",
  "deplo-traefik",
  // Traefik reads its whole routing config from the socket proxy BY NAME
  // (`--providers.docker.endpoint=tcp://…:2375`), and it straddles the shared
  // network, where the shared leg wins the lookup. Both spellings ever installed.
  "deplo-socket-proxy",
  "docker-socket-proxy",
]);

// Whether a name is one the platform answers to. Compared LOWERCASE: Docker's
// embedded DNS is case-insensitive, so a service called `Postgres` answers a
// `postgres` query exactly like the real one.
export function isReservedSharedName(name: string): boolean {
  return RESERVED_SHARED_NETWORK_NAMES.has(name.trim().toLowerCase());
}

// Every name a service answers to on a network: its own, plus `hostname:`, which
// Docker registers in the embedded DNS just like the service name does.
export function serviceClaimedNames(name: string, svc: unknown): string[] {
  const out = [name];
  const host =
    svc && typeof svc === "object" && !Array.isArray(svc)
      ? (svc as Record<string, unknown>).hostname
      : null;
  if (typeof host === "string" && host.trim() !== "") out.push(host.trim());
  return out;
}

// Every name any service in this compose would answer to on a network, lowercased
// and deduped. What a collision check compares against.
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

// The reserved name ONE named service of this compose would claim, or null. Routing
// a service puts it on the shared network, so the domain path asks this before it
// stores a row the renderer would then refuse to wire.
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

// The first reserved name this service would claim, or null.
export function serviceReservedClaim(
  name: string,
  svc: unknown,
): string | null {
  return serviceClaimedNames(name, svc).find(isReservedSharedName) ?? null;
}

// The name a top-level network entry resolves to ON THE HOST, or null when compose
// would create it under this project's own prefix.
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
  // `external: true` attaches the network the KEY names, verbatim - and compose
  // reads `yes`/`on`/`"true"` as true just the same.
  return composeTruthy(ext) ? key : null;
}

// A network Deplo owns: the platform's own, or one it mints for a tenant. The
// platform's names are matched with an optional compose PROJECT PREFIX - Traefik
// comes up from `$AGENT_DATA/traefik`, so its network is `traefik_deplo-socket`.
export function isDeploNetwork(name: string): boolean {
  const n = name.trim();
  if (isTenantNetwork(n)) return true;
  if ((PLATFORM_NETWORKS as readonly string[]).includes(n)) return true;
  // Only the two the Traefik stack DECLARES take a compose project prefix on a
  // host. `deplo` itself is `external:` there, so it never gets one - and matching
  // `_deplo` would read somebody's own `myapp_deplo` as the platform's.
  if (n.endsWith("_deplo-socket") || n.endsWith("_deplo-internal")) return true;
  // The private `default` compose creates for another Deplo stack: `deplo-<slug>`
  // is the project name this platform sets, so `deplo-shop_default` is a tenant's
  // own network under a name anybody can guess from the app's slug.
  return /^deplo-[a-z0-9][a-z0-9_.-]*_default$/i.test(n);
}

// Every top-level network KEY resolving to a network DEPLO owns. Resolved by NAME,
// not by key: `{default: {external: true, name: deplo-env-…}}` put a whole stack on
// another Environment's network. `buildComposeStack` collapses them.
export function sharedNetworkKeys(doc: { networks?: unknown }): Set<string> {
  // Seeded with `deplo` ALONE, the key the renderer itself writes. The other
  // platform names are not keys anybody else may claim: `networks: {deplo-internal:
  // {internal: true}}` is an author's own private network.
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

// True when a service's `networks:` (either shape) joins one of those keys. A
// service that declares NONE joins `default`, which is a key like any other -
// leaving that out let a compose point `default` at another Environment's network.
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
  // A LIST entry is a value, so compose fills `- ${NET}` in from the env-file and
  // it can name any key declared here - including one nothing else may join.
  if (keys) return keys.some((k) => shared.has(k) || interpolates(k));
  return shared.has("default");
}

// The first service claiming a reserved infrastructure name on the shared network,
// or null. Only an EXPLICIT join is visible here; a service the router puts there is
// caught by the same list in `buildComposeStack`.
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

// The message both checks use, so the editor and the deploy say the same thing.
export function reservedNameMessage(claimed: string): string {
  return (
    `\`${claimed}\` is a name Deplo's own infrastructure answers to, and the proxy ` +
    `resolves it from inside your network - two containers claiming one name split ` +
    `the traffic between them. Rename the service, or its \`hostname:\` if that is ` +
    `what this names.`
  );
}

// The first service whose `hostname:` compose fills in from a variable, or null.
// That value decides which name the container answers to - `deplo` included - and
// arrives from the env-file, so no reading of the authored text can see it.
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

// The message both of those checks use.
export function interpolatedHostnameMessage(service: string): string {
  return (
    `\`hostname\` on service \`${service}\` is filled in from a variable, so Deplo ` +
    `cannot tell which name that container answers to on its network. Write the ` +
    `value in the compose file.`
  );
}

// Top-level network KEYS pointing at a network Deplo did not create for this app.
// Project names are deterministic (`deplo-<slug>_default`), and joining one exposes
// every unpublished service AND lets a `postgres` service collect lookups by DNS.
function foreignNetworkKeys(networks: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(networks)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    // A network Deplo owns is governed by its own choke point, not by this gate:
    // `buildComposeStack` collapses every key naming one onto this stack's own
    // network, so joining it reaches nothing.
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
      // A driver that bridges onto the host's own segment rather than a private
      // docker bridge reaches past the app either way.
      (typeof n.driver === "string" &&
        /^(macvlan|ipvlan|host)$/i.test(n.driver.trim()));
    if (pinned) out.push(key);
  }
  return out;
}

// Whether ANY service joins a network this app does not own. Same
// `canMountHostVolumes` grant as its storage sibling: both reach past the
// container's boundary. Only an ACTUAL join counts.
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
    // Same join-shape reader the shared-network rule uses (list OR map form).
    if (joinsSharedNetwork(raw as Record<string, unknown>, foreign))
      return true;
  }
  return false;
}
