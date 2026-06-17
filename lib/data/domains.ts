import "server-only";

import { resolve4, resolveCname } from "node:dns/promises";
import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";
import {
  instanceHost,
  sslipDomain,
  isIpv4,
  isLoopbackIp,
  sslipEmbeddedIp,
  rehostSslip,
} from "../deploy/domains";
import { usesComposeStack } from "../utils";
import type { Domain } from "../types";

const DOMAIN_RE = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)+[a-zA-Z]{2,}$/;

/** Per-domain port overrides only apply to single-image / built projects: a
 * compose/template stack routes per-service via its own expose/exposes model
 * (a single hostname has no one service to re-target), so the deploy path drops
 * the override there. Reject it at the source rather than persist a no-op that
 * the UI would falsely report as applied. */
const PORT_OVERRIDE_UNSUPPORTED =
  "Per-domain ports aren't supported for compose stacks — set the exposed service's port in the compose file.";

/**
 * Generated sslip.io hostname for a project's slug on a given server IP. Pure
 * helper used by both the deploy engine and project creation so the domain
 * baked into a stack always matches the one shown in the Domains section.
 */
export function autoDomainName(slug: string, ip: string): string {
  return sslipDomain(slug, ip);
}

/**
 * Ensure a project has a registered primary domain and return its hostname.
 *
 * Runs without an authenticated user (the deploy pipeline is fire-and-forget),
 * so it talks to the store directly. If a `preferred` name is given (e.g. the
 * domain a template baked into its env), it is used as-is; otherwise the
 * sslip.io hostname for the slug is generated. The first domain on a project is
 * marked primary. Idempotent: returns the existing primary if one exists.
 */
export function ensureAutoDomain(
  projectId: string,
  opts: { slug: string; ip: string; preferred?: string },
): string {
  const existing = read().domains.filter((d) => d.projectId === projectId);
  const primary = existing.find((d) => d.primary) ?? existing[0];
  if (primary) {
    // Self-heal an auto-generated sslip.io domain that still encodes a stale or
    // loopback IP (e.g. created before DEPLO_SERVER_IP was set), so a corrected
    // IP takes effect on the next deploy without the operator deleting the
    // domain by hand. Only auto domains are touched, and never rewritten toward
    // a loopback address.
    if (primary.source === "auto" && isIpv4(opts.ip) && !isLoopbackIp(opts.ip)) {
      const embedded = sslipEmbeddedIp(primary.name);
      if (embedded && embedded !== opts.ip) {
        const fixed = rehostSslip(primary.name, opts.ip);
        if (fixed !== primary.name) {
          mutate((d) => {
            const x = d.domains.find((y) => y.id === primary.id);
            if (x) x.name = fixed;
          });
          return fixed;
        }
      }
    }
    return primary.name;
  }

  const name = (opts.preferred?.trim() || autoDomainName(opts.slug, opts.ip))
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const domain: Domain = {
    id: newId("dom"),
    projectId,
    name,
    status: "valid",
    primary: true,
    redirectTo: null,
    ssl: true,
    source: "auto",
    createdAt: nowIso(),
  };
  mutate((d) => d.domains.push(domain));
  return name;
}

/**
 * Ensure a secondary (non-primary) domain is registered for a project, e.g. the
 * extra hostnames a multi-domain template exposes (garage-with-ui's web UI).
 * Runs without an authenticated user (called from the fire-and-forget deploy).
 * Idempotent: a domain with the same name is left as-is.
 */
export function ensureExtraDomain(projectId: string, rawName: string): void {
  const name = rawName
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!name || !DOMAIN_RE.test(name)) return;
  const exists = read().domains.some(
    (d) => d.projectId === projectId && d.name === name,
  );
  if (exists) return;
  const domain: Domain = {
    id: newId("dom"),
    projectId,
    name,
    status: "valid",
    primary: false,
    redirectTo: null,
    ssl: true,
    source: "auto",
    createdAt: nowIso(),
  };
  mutate((d) => d.domains.push(domain));
}

export async function listDomains(
  projectId?: string,
): Promise<(Domain & { projectName: string; projectSlug: string })[]> {
  await assertUser();
  const d = read();
  return d.domains
    .filter((x) => !projectId || x.projectId === projectId)
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((x) => {
      const p = d.projects.find((pp) => pp.id === x.projectId);
      return { ...x, projectName: p?.name ?? "", projectSlug: p?.slug ?? "" };
    });
}

export async function addDomain(
  projectId: string,
  name: string,
  port?: number | null,
): Promise<Domain> {
  const user = await assertUser();
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!DOMAIN_RE.test(clean)) throw new Error("Enter a valid domain name");
  if (read().domains.some((x) => x.name === clean))
    throw new Error("Domain already added");
  const project = read().projects.find((p) => p.id === projectId);
  if (!project) throw new Error("Project not found");
  if (port != null && usesComposeStack(project))
    throw new Error(PORT_OVERRIDE_UNSUPPORTED);

  const domain: Domain = {
    id: newId("dom"),
    projectId,
    name: clean,
    status: "pending",
    primary:
      read().domains.filter((x) => x.projectId === projectId).length === 0,
    redirectTo: null,
    ssl: false,
    port: port ?? null,
    createdAt: nowIso(),
  };
  mutate((d) => d.domains.push(domain));
  recordActivity("domain", `Added domain ${clean}`, user.name, projectId);
  return domain;
}

/**
 * Set (or clear) the container port a domain's Traefik router targets. `null`
 * reverts the host to the project's default port. Returns the projectId so the
 * caller can re-apply routing — the change only reaches the running container
 * once its stack file is re-rendered (labels are baked at deploy time).
 */
export async function setDomainPort(
  id: string,
  port: number | null,
): Promise<string> {
  const user = await assertUser();
  const current = read().domains.find((x) => x.id === id);
  if (!current) throw new Error("Not found");
  if (port != null) {
    const project = read().projects.find((p) => p.id === current.projectId);
    if (project && usesComposeStack(project))
      throw new Error(PORT_OVERRIDE_UNSUPPORTED);
  }
  const dom = mutate((d) => {
    const x = d.domains.find((y) => y.id === id);
    if (!x) throw new Error("Not found");
    x.port = port;
    return x;
  });
  recordActivity(
    "domain",
    port ? `Routed ${dom.name} to port ${port}` : `Reset port for ${dom.name}`,
    user.name,
    dom.projectId,
  );
  return dom.projectId;
}

/**
 * Verify a domain by checking real DNS: the name must resolve to this server's
 * IP (or have a CNAME). Traefik then issues the Let's Encrypt cert on the next
 * request, so `ssl` is set once DNS is correct.
 */
export async function verifyDomain(id: string): Promise<Domain> {
  await assertUser();
  const dom = read().domains.find((x) => x.id === id);
  if (!dom) throw new Error("Not found");

  const target = instanceHost();
  let ok = false;
  try {
    const ips = await resolve4(dom.name);
    ok = ips.includes(target) || ips.length > 0;
  } catch {
    try {
      const cnames = await resolveCname(dom.name);
      ok = cnames.length > 0;
    } catch {
      ok = false;
    }
  }

  return mutate((d) => {
    const x = d.domains.find((y) => y.id === id);
    if (!x) throw new Error("Not found");
    x.status = ok ? "valid" : "misconfigured";
    x.ssl = ok;
    return x;
  });
}

/**
 * Valid, routable hostnames for a project, primary first.
 *
 * Only `valid` domains are returned: a pending/misconfigured host has no
 * working DNS, so routing to it would make Traefik fail HTTP-01 issuance and
 * (because all hosts share one cert order) could jeopardise the cert for the
 * domains that *do* work. The primary is sorted first so it stays the canonical
 * host. Store-direct (no auth) so the deploy engine can call it like
 * [[ensure-auto-domain]] does. Empty when the project has no valid domain.
 */
export function routableDomains(projectId: string): string[] {
  return routableRoutes(projectId).map((d) => d.name);
}

/** A routable hostname plus its per-domain port override (null ⇒ project
 * default). Same filtering/ordering as {@link routableDomains}; callers that
 * honour per-domain ports group these by effective port into Traefik routers. */
export interface RoutableDomain {
  name: string;
  port: number | null;
}

/**
 * Valid, routable hostnames for a project (primary first), each with its port
 * override. The per-domain port lets one container expose different services on
 * different hostnames; a `null` port means "use the project's default port".
 * Same `valid`-only filtering rationale as {@link routableDomains}.
 */
export function routableRoutes(projectId: string): RoutableDomain[] {
  return read()
    .domains.filter((d) => d.projectId === projectId && d.status === "valid")
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((d) => ({ name: d.name, port: d.port ?? null }));
}

/**
 * Flip which domain is primary for its project. Returns the affected projectId
 * so the caller can re-apply routing (the running container's Traefik labels
 * are baked at deploy time, so the switch only takes effect once the stack is
 * re-rendered and `docker compose up -d` recreates it). `productionUrl` is NOT
 * advanced here — the caller updates it only after routing is confirmed, so the
 * dashboard never points at a host the container isn't serving yet.
 */
export async function setPrimaryDomain(id: string): Promise<string> {
  await assertUser();
  return mutate((d) => {
    const dom = d.domains.find((x) => x.id === id);
    if (!dom) throw new Error("Not found");
    for (const x of d.domains)
      if (x.projectId === dom.projectId) x.primary = x.id === id;
    return dom.projectId;
  });
}

/**
 * Point a project's canonical `productionUrl` at its current primary domain.
 * The primary domain IS the canonical URL the moment the user picks it, so the
 * domain actions call this on every successful change regardless of whether the
 * running container has been rerouted yet — the title-bar URL must reflect the
 * chosen primary immediately, not lag a deploy behind. Falls back to the first
 * remaining domain when none is flagged primary (e.g. the primary was removed),
 * and clears the URL when the last domain is gone.
 */
export function syncProductionUrl(projectId: string): void {
  mutate((d) => {
    const p = d.projects.find((x) => x.id === projectId);
    if (!p) return;
    const domains = d.domains.filter((x) => x.projectId === projectId);
    const primary = domains.find((x) => x.primary) ?? domains[0];
    p.productionUrl = primary ? `https://${primary.name}` : null;
    p.updatedAt = nowIso();
  });
}

export async function removeDomain(id: string): Promise<string> {
  const user = await assertUser();
  const dom = read().domains.find((x) => x.id === id);
  if (!dom) throw new Error("Not found");
  mutate((d) => {
    d.domains = d.domains.filter((x) => x.id !== id);
  });
  recordActivity(
    "domain",
    `Removed domain ${dom.name}`,
    user.name,
    dom.projectId,
  );
  // Caller re-applies routing so the removed host stops being served.
  return dom.projectId;
}
