import "server-only";

import { and, eq, isNotNull, ne } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { newId } from "../../ids";
import { requireActiveTeamId } from "../../membership";
import {
  panelFallbackHost,
  nipDomain,
  randomWords,
  nipEmbeddedIp,
} from "../../deploy/domains";
import { publicBaseUrl } from "../../public-url";

export const DOMAIN_RE = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)+[a-zA-Z]{2,}$/;

// normalizePreferredHost: a caller-supplied hostname as it would be STORED.
export function normalizePreferredHost(raw: string | null | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

// isHostnameClaim: whether a hostname is a CLAIM on a name - what `manage_domains` gates.
export function isHostnameClaim(raw: string | null | undefined): boolean {
  const host = normalizePreferredHost(raw);
  return host !== "" && DOMAIN_RE.test(host) && nipEmbeddedIp(host) == null;
}

// assertHostnameNotAnotherTeams: refuse a hostname an app in ANOTHER TEAM already routes.
// Uniqueness is stored on `(name, coalesce(path_prefix,''))`, so one team may serve
// `app.com` on `/` and on `/api` from two apps; another team's claim never may.
export async function assertHostnameNotAnotherTeams(
  name: string,
  teamId: string,
  exceptDomainId: string | null,
): Promise<void> {
  const rows = await getDb()
    .select({ id: domainsTable.id, teamId: appsTable.teamId })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(eq(domainsTable.name, name));
  if (rows.some((r) => r.id !== exceptDomainId && r.teamId !== teamId))
    throw new Error(
      `${name} is already routed by another team on this Deplo. A hostname belongs to one team.`,
    );
  // A preview host never enters `domains`, so its zone is claimed by the base.
  for (const base of await foreignPreviewBases(teamId))
    if (name === base || name.endsWith(`.${base}`))
      throw new Error(
        `${name} is under another team's preview domain on this Deplo. A hostname belongs to one team.`,
      );
}

async function foreignPreviewBases(teamId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ base: appsTable.previewBaseDomain })
    .from(appsTable)
    .where(
      and(ne(appsTable.teamId, teamId), isNotNull(appsTable.previewBaseDomain)),
    );
  return [
    ...new Set(
      rows.map((r) => (r.base ?? "").trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

// isPanelHost: the panel's own addresses. An app routed there would answer for the dashboard.
export function isPanelHost(name: string): boolean {
  let own: string | null = null;
  try {
    const url = publicBaseUrl();
    own = url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    /* an unparseable public URL names nothing */
  }
  return name === own || name === panelFallbackHost();
}

export function assertNotPanelHost(name: string): void {
  if (isPanelHost(name))
    throw new Error(
      `${name} is this Deplo's own address, so an app can't be served there.`,
    );
}

// assertPreviewBaseNotAnotherTeams: refuse a PREVIEW BASE DOMAIN under a hostname another team routes.
export async function assertPreviewBaseNotAnotherTeams(
  base: string,
  teamId: string,
): Promise<void> {
  const clean = base.trim().toLowerCase();
  if (!clean) return;
  const rows = await getDb()
    .select({ name: domainsTable.name, teamId: appsTable.teamId })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId));
  const sameZone = (a: string, b: string) =>
    a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  const taken =
    rows.some(
      (r) => r.teamId !== teamId && sameZone(r.name.toLowerCase(), clean),
    ) ||
    // ...and the other teams' preview bases, in both directions too.
    (await foreignPreviewBases(teamId)).some((b) => sameZone(b, clean));
  if (taken)
    throw new Error(
      `${clean} is served by another team on this Deplo, so previews can't be published under it. A preview domain belongs to one team.`,
    );
}

// domainNameExists: whether `name` is unavailable. With a `pathPrefix` the stored
// rule applies - another team's claim still refuses it at any path; without one,
// any row with that name is a taken name (what a generated host has to avoid).
export async function domainNameExists(
  name: string,
  pathPrefix?: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ teamId: appsTable.teamId, pathPrefix: domainsTable.pathPrefix })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(eq(domainsTable.name, name));
  if (rows.length === 0) return false;
  if (pathPrefix === undefined) return true;
  const teamId = await requireActiveTeamId();
  return rows.some(
    (r) => r.teamId !== teamId || (r.pathPrefix ?? "") === pathPrefix,
  );
}

// uniqueAutoDomainName: a generated nip.io hostname for `label` on `ip` that collides with no existing domain.
export async function uniqueAutoDomainName(
  label: string,
  ip: string,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = nipDomain(label, randomWords(), ip);
    if (!(await domainNameExists(candidate))) return candidate;
  }
  // Exhausted retries (effectively impossible) - a random id segment guarantees
  // uniqueness so creation never wedges.
  return nipDomain(label, `${randomWords()}-${newId("").slice(1, 5)}`, ip);
}
