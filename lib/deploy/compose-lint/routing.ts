import { isDatastoreImage } from "../../databases/images";
import { loadComposeDoc, servicesOf } from "./document";
import { isReservedSharedName, serviceReservedClaim } from "./networks";

// The services a stack declares, in the order it declares them. Empty for anything
// that doesn't parse - the linter is what reports that.
export function composeServiceNames(composeYaml: string): string[] {
  const doc = loadComposeDoc<{ services?: Record<string, unknown> }>(
    composeYaml,
  );
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return [];
  return Object.keys(services as Record<string, unknown>);
}

// First entry of a `ports:`/`expose:` list as a container port (`"8080:80"` -> 80).
function portFromList(raw: unknown): number | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  let n = NaN;
  if (typeof first === "number") n = first;
  else if (typeof first === "string") {
    const parts = first.split(":");
    const target = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    n = Number(target.replace(/\/.*$/, "").trim());
  } else if (first && typeof first === "object")
    n = Number((first as Record<string, unknown>).target);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The container port a service answers on: the port it publishes, else the one it
// only `expose:`s - which is all a template has left, since the catalog strips
// `ports:` from every blueprint.
export function declaredPort(svc: unknown): number | null {
  const s = (svc ?? {}) as { ports?: unknown; expose?: unknown };
  return portFromList(s.ports) ?? portFromList(s.expose);
}

// A port a healthcheck dials (`curl -f http://localhost:3000/`). The last thing a
// service says about the port it answers on when it publishes none - and one-click
// templates say it far more often than they `expose:`.
function healthCheckPort(svc: unknown): number | null {
  const test = (svc as { healthcheck?: { test?: unknown } })?.healthcheck?.test;
  const text = Array.isArray(test)
    ? test.map(String).join(" ")
    : typeof test === "string"
      ? test
      : "";
  const n = Number(/:(\d{2,5})(?=[/\s"']|$)/.exec(text)?.[1]);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
}

// The container port a route to ONE compose service should reach: what it publishes,
// what its healthcheck dials, else the conventional web port - the renderer's own
// answer said out loud, so an imported domain carries a real port.
export function composeRoutePort(
  compose: string | null | undefined,
  service: string,
): number | null {
  const services = servicesOf(compose ?? null);
  const svc = services?.[service];
  if (!svc) return null;
  return declaredPort(svc) ?? healthCheckPort(svc) ?? 80;
}

// Every service another service names in `depends_on` (list form and map form).
function dependedUpon(services: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const svc of Object.values(services)) {
    const dep = (svc as { depends_on?: unknown })?.depends_on;
    if (Array.isArray(dep)) {
      for (const d of dep) if (typeof d === "string") out.add(d);
    } else if (dep && typeof dep === "object") {
      for (const k of Object.keys(dep)) out.add(k);
    }
  }
  return out;
}

function imageOf(svc: unknown): string | null {
  const img = (svc as { image?: unknown })?.image;
  return typeof img === "string" ? img : null;
}

// The services a domain may point at: not a name the platform answers to on the
// shared network, and not a database. A stack of nothing BUT databases keeps the
// whole list - routing at a datastore is then the only answer there is.
function routableNames(services: Record<string, unknown>): string[] {
  const names = Object.keys(services).filter((n) => !isReservedSharedName(n));
  const web = names.filter((n) => !isDatastoreImage(imageOf(services[n])));
  return web.length > 0 ? web : names;
}

// Pick a default `{service, port}` to seed a compose project's FIRST domain when
// neither the template nor the user named one. Used at project creation only -
// after that the `domains` table (each row's `service`) is authoritative.
export function detectDefaultApp(
  compose: string | null,
): { service: string; port: number } | null {
  const services = servicesOf(compose);
  if (!services) return null;
  const names = routableNames(services);
  if (names.length === 0) return null;
  // A declared port is the author saying "here", so those candidates come first;
  // among equals, the front door is the service no other one waits on.
  const depended = dependedUpon(services);
  const front = (list: string[]): string =>
    list.find((n) => !depended.has(n)) ?? list[0];
  const withPort = names.filter((n) => declaredPort(services[n]));
  const service = front(withPort.length > 0 ? withPort : names);
  return { service, port: declaredPort(services[service]) ?? 80 };
}

// One row of the wizard's "which services get a domain" list.
export interface ComposeRouteCandidate {
  name: string;
  port: number;
  // Runs one of the engines Deplo provisions - offered, but never pre-selected.
  isDatastore: boolean;
  // Deplo's own name on the shared network: it can never hold a domain.
  isReserved: boolean;
  // The one the auto domain is born on.
  isPrimary: boolean;
}

// Every service of a stack with what the new-app wizard needs to offer it a domain.
// Same reading as {@link detectDefaultApp}, so the row marked primary is the one the
// server would have picked on its own.
export function composeRouteCandidates(
  compose: string | null,
): ComposeRouteCandidate[] {
  const services = servicesOf(compose);
  if (!services) return [];
  const primary = detectDefaultApp(compose)?.service ?? null;
  return Object.keys(services).map((name) => ({
    name,
    port: declaredPort(services[name]) ?? 80,
    isDatastore: isDatastoreImage(imageOf(services[name])),
    isReserved: serviceReservedClaim(name, services[name]) != null,
    isPrimary: name === primary,
  }));
}
