import "server-only";

import yaml from "../../yaml";

import {
  serviceClaimedNames,
  serviceReservedClaim,
} from "../compose-lint/networks";
import { declaredPort } from "../compose-lint/routing";
import { declaredNetworkKeys, internalNetworkKeys } from "./stack-network";
import type { App, ComposeDoc } from "./types";

export { detectDefaultApp } from "../compose-lint/routing";

export function escapeComposeDollars(encoded: string): string {
  return encoded.replace(/\$/g, "$$$$");
}

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
    if (serviceReservedClaim(name, svc)) continue;
    if (svc.network_mode != null) continue;
    const joined = declaredNetworkKeys(svc) ?? ["default"];
    if (joined.length > 0 && joined.every((k) => internal.has(k))) continue;
    for (const claimed of serviceClaimedNames(name, svc))
      out.add(claimed.toLowerCase());
  }
  return [...out];
}
