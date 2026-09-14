import "server-only";

import yaml from "../../yaml";

import {
  serviceClaimedNames,
  serviceReservedClaim,
} from "../compose-lint/networks";
import { declaredPort } from "../compose-lint/routing";
import { declaredNetworkKeys, internalNetworkKeys } from "./stack-network";
import type { App, ComposeDoc } from "./types";

// The detection reads the AUTHORED compose and has to answer in the wizard too,
// so it lives in the client-safe module; this stays its address for the server.
export { detectDefaultApp } from "../compose-lint/routing";

// escapeComposeDollars escapes a `$` for `docker compose`, which interpolates `$VAR`
// in every value it reads: an authored `$` reached the container gutted, or holding
// the AGENT HOST's own variable. Apply to an already-encoded scalar.
export function escapeComposeDollars(encoded: string): string {
  return encoded.replace(/\$/g, "$$$$");
}

// composeServicePort is the container port ONE named service answers on: the port it
// publishes, else the conventional web port a route with no explicit port falls back
// to (the same `portOf` the renderer uses when wiring Traefik).
export function composeServicePort(
  compose: string | null,
  service: string,
): number | null {
  if (!compose || !compose.trim() || !service) return null;
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return null;
  }
  const svc = doc.services?.[service];
  if (!svc || typeof svc !== "object") return null;
  return declaredPort(svc) ?? 80;
}

// composeServiceNames is the service names a compose app is SUPPOSED to have
// containers for.
export function composeServiceNames(compose: string | null): string[] {
  if (!compose || !compose.trim()) return [];
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return [];
  }
  const services = doc.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return [];
  return Object.keys(services as Record<string, unknown>);
}

// composeDeclaredEnvKeys is the env keys the AUTHORED compose sets itself.
// `mergeEnvironment` leaves those alone, so they keep the compose's value whatever the
// app's variables say - which the Environment tab has to state.
export function composeDeclaredEnvKeys(compose: string | null): string[] {
  if (!compose || !compose.trim()) return [];
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const svc of Object.values(doc.services ?? {})) {
    const env = (svc as App)?.environment;
    if (Array.isArray(env)) {
      for (const e of env) {
        // `KEY=value` sets it; a bare `KEY` is the pass-through Deplo itself writes.
        if (typeof e === "string" && e.includes("="))
          out.add(e.split("=")[0].trim());
      }
    } else if (env && typeof env === "object") {
      for (const [k, v] of Object.entries(env as Record<string, unknown>))
        if (v !== null && v !== undefined) out.add(k);
    }
  }
  return [...out];
}

// composeEnvValues is the `environment:` values a compose file sets ITSELF, keyed by
// variable name. What a cross-network check has to read on top of the resolved env: a
// stack that hardcodes a neighbour's hostname never goes through the env layer at all.
export function composeEnvValues(compose: string): Record<string, string> {
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const svc of Object.values(doc.services ?? {})) {
    const env = (svc as App)?.environment;
    if (Array.isArray(env)) {
      for (const e of env) {
        if (typeof e !== "string" || !e.includes("=")) continue;
        const at = e.indexOf("=");
        out[e.slice(0, at).trim()] = e.slice(at + 1).trim();
      }
    } else if (env && typeof env === "object") {
      for (const [k, v] of Object.entries(env as Record<string, unknown>))
        if (v != null) out[k] = String(v);
    }
  }
  return out;
}

// composeNamesOnNetwork is the DNS names an AUTHORED compose would put on the
// Environment's network - not every service it declares. A clash guard has to ask
// this, or it refuses a move over a `postgres` that never joins.
export function composeNamesOnNetwork(compose: string): string[] {
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return [];
  }
  const services = doc.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return [];
  const internal = internalNetworkKeys(doc);
  const out = new Set<string>();
  for (const [name, raw] of Object.entries(services)) {
    const svc = raw as App | undefined;
    if (!svc || typeof svc !== "object") continue;
    // Off the network for the same three reasons the renderer keeps them off.
    if (serviceReservedClaim(name, svc)) continue;
    if (svc.network_mode != null) continue;
    const joined = declaredNetworkKeys(svc) ?? ["default"];
    if (joined.length > 0 && joined.every((k) => internal.has(k))) continue;
    for (const claimed of serviceClaimedNames(name, svc))
      out.add(claimed.toLowerCase());
  }
  return [...out];
}
