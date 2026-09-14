import "server-only";

import {
  composeServiceReservedClaim,
  reservedNameMessage,
} from "../../deploy/compose-lint/networks";
import yaml from "../../yaml";

const SERVICE_UNSUPPORTED =
  "Picking a container is only available for compose stacks - a single-image app has exactly one, so use the container port field.";

// normalizePath: a router path prefix in its canonical stored form.
export function normalizePath(input?: string | null): string {
  let p = (input ?? "").trim();
  if (!p) return "";
  // Strip a pasted URL down to its path (`https://host/api` → `/api`).
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      /* not a URL - fall through and treat it as a raw path */
    }
  }
  // The value is interpolated into a Traefik backtick literal inside a router
  // rule, so backticks, quotes and control characters never reach the grammar.
  p = p.replace(/[`"\u0000-\u001f]/g, "");
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, "");
  return p; // "" for a bare "/" (the trailing-slash strip leaves "")
}

// composeServiceNames: the service names declared in a project's compose file, or [] when there is none.
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

// resolveApp: validate + normalise a domain's chosen compose `service` - required
// on a compose stack, refused on a single-image app.
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
  // Routing puts the service on the SHARED network, where these names are the
  // platform's own - refuse here rather than on every later render of the stack.
  const claim = composeServiceReservedClaim(project.compose, service);
  if (claim) throw new Error(reservedNameMessage(claim));
  return service;
}

// normalizeMiddlewares: trim, drop blanks and de-duplicate a middleware list (order-preserving).
export function normalizeMiddlewares(input?: string[] | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input ?? []) {
    const m = raw.trim();
    if (!m || seen.has(m)) continue;
    // A middleware name is emitted verbatim into a Traefik `middlewares=` label.
    if (!/^[A-Za-z0-9._@-]+$/.test(m))
      throw new Error(`Invalid middleware name: ${m}`);
    seen.add(m);
    out.push(m);
  }
  return out;
}
