import "server-only";

import {
  composeServiceReservedClaim,
  reservedNameMessage,
} from "../../deploy/compose-lint/networks";
import yaml from "../../yaml";

const SERVICE_UNSUPPORTED =
  "Picking a container is only available for compose stacks - a single-image app has exactly one, so use the container port field.";

export function normalizePath(input?: string | null): string {
  let p = (input ?? "").trim();
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {}
  }
  p = p.replace(/[`"\u0000-\u001f]/g, "");
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, "");
  return p;
}

export function composeServiceNames(compose?: string | null): string[] {
  if (!compose || !compose.trim()) return [];
  try {
    const doc = yaml.load(compose) as
      { services?: Record<string, unknown> } | undefined;
    const svc = doc?.services;
    return svc && typeof svc === "object" && !Array.isArray(svc)
      ? Object.keys(svc)
      : [];
  } catch {
    return [];
  }
}

export function resolveApp(
  raw: string | undefined,
  project: { compose: string | null },
  isCompose: boolean,
): string | null {
  const service = raw?.trim();
  if (!isCompose) {
    if (service) throw new Error(SERVICE_UNSUPPORTED);
    return null;
  }
  if (!service) throw new Error("Select the container this domain routes to");
  const names = composeServiceNames(project.compose);
  if (!names.includes(service))
    throw new Error(`No container named "${service}" in the compose file`);
  const claim = composeServiceReservedClaim(project.compose, service);
  if (claim) throw new Error(reservedNameMessage(claim));
  return service;
}

export function normalizeMiddlewares(input?: string[] | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input ?? []) {
    const m = raw.trim();
    if (!m || seen.has(m)) continue;
    if (!/^[A-Za-z0-9._@-]+$/.test(m))
      throw new Error(`Invalid middleware name: ${m}`);
    seen.add(m);
    out.push(m);
  }
  return out;
}
