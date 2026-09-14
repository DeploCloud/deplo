import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { newId, nowIso } from "../../ids";
import {
  isIpv4,
  isLoopbackIp,
  nipEmbeddedIp,
  rehostNip,
} from "../../deploy/domains";
import { certProviderForDns, isRoutableDomain } from "../../deploy/cloudflare";
import { composeServiceReservedClaim } from "../../deploy/compose-lint/networks";
import { usesComposeStack } from "../../utils";
import {
  insertDomain,
  loadDomainsForApp,
  loadAppGraph,
} from "../app-graph-load";
import type { CertProvider, Domain } from "../../types/domain";
import {
  DOMAIN_RE,
  assertHostnameNotAnotherTeams,
  assertNotPanelHost,
  domainNameExists,
  isPanelHost,
  normalizePreferredHost,
  uniqueAutoDomainName,
} from "./hostname-claim";
import { checkDomainDns } from "./dns-check";
import { composeServiceNames, normalizePath } from "./route-config";

// ensureAutoDomain: ensure a project has a registered primary domain and return its hostname.
export async function ensureAutoDomain(
  appId: string,
  opts: {
    slug: string;
    ip: string;
    preferred?: string;
    /** The container port this host routes to. Always written so no auto domain is ever portless. */
    defaultPort: number;
    /** Compose default expose service (null/absent for single-image). */
    defaultApp?: string | null;
    /** TLS choice the domain is born with. Absent ⇒ `none`; createApp passes
     * `letsencrypt` only when the blueprint itself expects HTTPS. */
    certProvider?: CertProvider;
    /** The path this host routes here. An import brings apps that share ONE
     * hostname on different paths, which the stored uniqueness allows. */
    preferredPath?: string;
  },
): Promise<string> {
  const existing = await loadDomainsForApp(appId);
  const primary = existing.find((d) => d.primary) ?? existing[0];
  if (primary) {
    // Self-heal an auto-generated nip.io domain that still encodes a stale or
    // loopback IP, so a corrected IP takes effect without deleting the domain.
    if (
      primary.source === "auto" &&
      isIpv4(opts.ip) &&
      !isLoopbackIp(opts.ip)
    ) {
      const embedded = nipEmbeddedIp(primary.name);
      if (embedded && embedded !== opts.ip) {
        const fixed = rehostNip(primary.name, opts.ip);
        if (fixed !== primary.name) {
          await getDb()
            .update(domainsTable)
            .set({ name: fixed })
            .where(eq(domainsTable.id, primary.id));
          return fixed;
        }
      }
    }
    return primary.name;
  }

  const preferred = normalizePreferredHost(opts.preferred) || undefined;
  // A garbage value is dropped and a fresh nip.io host generated instead of
  // being persisted.
  const preferredOk =
    !!preferred &&
    (nipEmbeddedIp(preferred) != null || DOMAIN_RE.test(preferred));
  const preferredPath = normalizePath(opts.preferredPath);
  let name: string;
  if (preferredOk && !(await domainNameExists(preferred!, preferredPath))) {
    // The same refusals a typed hostname gets: not the panel's own address, and
    // not a name another team routes or holds as its preview zone.
    assertNotPanelHost(preferred!);
    const owner = (
      await getDb()
        .select({ teamId: appsTable.teamId })
        .from(appsTable)
        .where(eq(appsTable.id, appId))
        .limit(1)
    )[0];
    if (owner)
      await assertHostnameNotAnotherTeams(preferred!, owner.teamId, null);
    name = preferred!;
  } else {
    name = await uniqueAutoDomainName(opts.slug, opts.ip);
  }
  // The path only comes across with the host it belongs to.
  const pathPrefix = name === preferred ? preferredPath : "";
  // Our own generated nip.io hosts point at the server IP by construction, so
  // they are born routable ("valid").
  const status =
    nipEmbeddedIp(name) != null
      ? ("valid" as const)
      : await checkDomainDns(name, opts.ip);
  // An absent stored provider reads as letsencrypt at the deploy edge (pre-field
  // back-compat), so the born-without-a-cert default is written explicitly.
  const certProvider = certProviderForDns(status, opts.certProvider ?? "none");
  const domain: Domain = {
    id: newId("dom"),
    appId,
    name,
    status,
    primary: true,
    redirectTo: null,
    ssl: certProvider !== "none" && isRoutableDomain({ status }),
    source: "auto",
    port: opts.defaultPort,
    ...(opts.defaultApp ? { service: opts.defaultApp } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    certProvider,
    createdAt: nowIso(),
  };
  await insertDomain(getDb(), domain);
  return name;
}

// ensureExtraDomain: register a secondary (non-primary) domain, e.g. the extra
// hostnames a multi-domain template exposes.
export async function ensureExtraDomain(
  appId: string,
  rawName: string,
  route: {
    port: number;
    service?: string | null;
    slug: string;
    ip: string;
    /** TLS choice - same rule as {@link ensureAutoDomain}: absent ⇒ `none`. */
    certProvider?: CertProvider;
    /** The path this host routes here. Two rows may share one hostname on
     * different paths, the only way a stack with ONE base URL can be routed. */
    pathPrefix?: string;
  },
): Promise<void> {
  const pathPrefix = normalizePath(route.pathPrefix);
  const asked = normalizePreferredHost(rawName);
  // The two refusals `addDomain` makes, made here too - but a template typo must
  // cost the address, not the whole create, so this skips rather than throws.
  const service = route.service ?? "";
  const project = service ? await loadAppGraph(appId) : null;
  if (project && usesComposeStack(project)) {
    const declared = composeServiceNames(project.compose);
    if (
      !declared.includes(service) ||
      composeServiceReservedClaim(project.compose, service)
    )
      return;
  }
  const existing = await loadDomainsForApp(appId);
  // No host asked for: a PATH means "the app's own address, there"; anything
  // else gets a generated host rather than no address at all.
  const wanted =
    asked && DOMAIN_RE.test(asked)
      ? asked
      : pathPrefix
        ? ((existing.find((d) => d.primary) ?? existing[0])?.name ?? "")
        : "";
  if (
    wanted &&
    existing.some(
      (d) =>
        d.name === wanted && (d.pathPrefix ?? "") === pathPrefix && !d.primary,
    )
  )
    return;
  // Honor the asked-for host when it is free AT THIS PATH - the app's own
  // primary holding it on `/` must not push its `/api` sibling onto an invented
  // address. Taken regenerates a unique one rather than skip.
  const name =
    wanted &&
    !isPanelHost(wanted) &&
    !(await domainNameExists(wanted, pathPrefix))
      ? wanted
      : await uniqueAutoDomainName(
          route.service ? `${route.slug}-${route.service}` : route.slug,
          route.ip,
        );
  // Same explicit-store rule as the primary: absent reads as letsencrypt at the
  // deploy edge, so the born-without-a-cert default is written.
  const certProvider = route.certProvider ?? "none";
  const domain: Domain = {
    id: newId("dom"),
    appId,
    name,
    status: "valid",
    primary: false,
    redirectTo: null,
    ssl: certProvider !== "none",
    source: "auto",
    port: route.port,
    ...(route.service ? { service: route.service } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    certProvider,
    createdAt: nowIso(),
  };
  await insertDomain(getDb(), domain);
}
