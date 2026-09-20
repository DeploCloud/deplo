import { isDatastoreImage } from "../../databases/images";
import { loadComposeDoc, servicesOf } from "./document";
import { isReservedSharedName, serviceReservedClaim } from "./networks";

export function composeServiceNames(composeYaml: string): string[] {
  const doc = loadComposeDoc<{ services?: Record<string, unknown> }>(
    composeYaml,
  );
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return [];
  return Object.keys(services as Record<string, unknown>);
}

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

export function declaredPort(svc: unknown): number | null {
  const s = (svc ?? {}) as { ports?: unknown; expose?: unknown };
  return portFromList(s.ports) ?? portFromList(s.expose);
}

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

export function composeRoutePort(
  compose: string | null | undefined,
  service: string,
): number | null {
  const services = servicesOf(compose ?? null);
  const svc = services?.[service];
  if (!svc) return null;
  return declaredPort(svc) ?? healthCheckPort(svc) ?? 80;
}

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

function routableNames(services: Record<string, unknown>): string[] {
  const names = Object.keys(services).filter((n) => !isReservedSharedName(n));
  const web = names.filter((n) => !isDatastoreImage(imageOf(services[n])));
  return web.length > 0 ? web : names;
}

export function detectDefaultApp(
  compose: string | null,
): { service: string; port: number } | null {
  const services = servicesOf(compose);
  if (!services) return null;
  const names = routableNames(services);
  if (names.length === 0) return null;
  const depended = dependedUpon(services);
  const front = (list: string[]): string =>
    list.find((n) => !depended.has(n)) ?? list[0];
  // No port declared anywhere means no web service: an address here would answer nothing.
  const withPort = names.filter((n) => declaredPort(services[n]));
  if (withPort.length === 0) return null;
  const service = front(withPort);
  return { service, port: declaredPort(services[service])! };
}

export interface ComposeRouteCandidate {
  name: string;
  port: number;
  isDatastore: boolean;
  isReserved: boolean;
  isPrimary: boolean;
}

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
