import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import type { MappedDomain } from "../../migration/map/domains";
import { type DomainPatch, addDomain, updateDomain } from "../domains/crud";
import {
  addImportedDomains,
  applyImportedRoute,
  type ImportedRoute,
} from "../domains/imported-routes";
import { setAppEnv } from "../env";
import { getServerById } from "../servers/roster";
import { resolveServerIp } from "../../deploy/domains";
import type { createApp } from "../apps/create";

// Every occurrence of a re-hosted address, replaced by the one it became. A plain
// substring swap, because that is how these values are shaped: the host sits inside a
// URL, a comma-separated list, a connection string.
function rewriteHosts(value: string, hosts: Map<string, string>): string {
  let out = value;
  for (const [from, to] of [...hosts].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    if (!from) continue;
    out = out.replace(
      new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      to,
    );
  }
  return out;
}

// A mapped domain as the domain writers take it, so the primary and the extras can
// never describe the same source domain differently.
export function importedRoute(d: MappedDomain): ImportedRoute {
  return {
    sourceHost: d.host,
    port: d.port,
    pathPrefix: d.pathPrefix,
    stripPrefix: d.stripPrefix,
    certProvider: d.certProvider,
    entrypoint: d.entrypoint,
    service: d.service,
  };
}

// An extra (non-primary) hostname, with everything the panel knew about it.
async function addExtraDomain(
  appId: string,
  d: MappedDomain,
  notes: string[],
): Promise<boolean> {
  try {
    await addDomain(appId, d.host, {
      port: d.port,
      pathPrefix: d.pathPrefix,
      stripPrefix: d.stripPrefix,
      certProvider: d.certProvider,
      entrypoint: d.entrypoint,
      service: d.service ?? undefined,
    });
    return true;
  } catch (e) {
    notes.push(
      `${d.host} could not be taken here: ${e instanceof Error ? e.message : "refused"}.`,
    );
    return false;
  }
}

// EVERY address the app answered on over there has to be an address it answers on
// here: a throwaway host, or a real one another team already serves, is re-hosted
// onto one of Deplo's own with the same routes.
export async function rehostAppDomains(
  created: Awaited<ReturnType<typeof createApp>>,
  domains: { value: MappedDomain[] },
  primary: MappedDomain | null,
  env: { key: string; value: string }[],
  notes: string[],
): Promise<void> {
  const rehosted = new Map<string, string>();
  // Kept apart from `notes` so the warning about what the app stores about itself can
  // ride the last of them: as its own note it repeated what the line above had just said.
  const rehostNotes: string[] = [];
  if (domains.value.length === 0)
    notes.push(
      "It answered on no address on {panel}, so it arrives with none here either. Add one under Domains if it should be reachable from outside.",
    );
  if (primary) {
    const landed = await getDb()
      .select({
        id: domainsTable.id,
        name: domainsTable.name,
        certProvider: domainsTable.certProvider,
        pathPrefix: domainsTable.pathPrefix,
        stripPrefix: domainsTable.stripPrefix,
        entrypoint: domainsTable.entrypoint,
      })
      .from(domainsTable)
      .where(
        and(
          eq(domainsTable.appId, created.id),
          eq(domainsTable.isPrimary, true),
        ),
      );
    const row = landed[0];
    if (row && row.name.toLowerCase() !== primary.host) {
      // The address changed - because it was a throwaway, or because the real one was
      // taken.
      await applyImportedRoute(row.id, importedRoute(primary));
      rehosted.set(primary.host, row.name);
      rehostNotes.push(
        primary.generated
          ? `${primary.host} was {panel}'s own temporary address, so this app answers on ${row.name} here - same port, same route.`
          : `${primary.host} could not be taken, so the app answers on ${row.name} instead.`,
      );
    } else if (row) {
      // createApp mints the primary domain itself and knows only its NAME, so everything
      // else about the route has to be applied afterwards.
      const patch: DomainPatch = {};
      if (row.certProvider !== primary.certProvider)
        patch.certProvider = primary.certProvider;
      if ((row.pathPrefix ?? "") !== primary.pathPrefix)
        patch.pathPrefix = primary.pathPrefix;
      if (primary.pathPrefix && !!row.stripPrefix !== primary.stripPrefix)
        patch.stripPrefix = primary.stripPrefix;
      if ((row.entrypoint ?? "") !== primary.entrypoint)
        patch.entrypoint = primary.entrypoint;
      if (Object.keys(patch).length > 0)
        try {
          await updateDomain(row.id, patch);
        } catch (e) {
          notes.push(
            `${primary.host} did not keep its route (${primary.pathPrefix || "/"}, ${primary.certProvider}): ${e instanceof Error ? e.message : "refused"}. Set it under Domains.`,
          );
        }
    }
  }

  const rest = domains.value.filter((d) => d !== primary);
  // A real hostname is asked for first. One that cannot be taken - another team here
  // already serves it, or this member may not claim names - is NOT dropped either: it
  // joins the re-hosting below, for the same reason a throwaway does.
  const refused: MappedDomain[] = [];
  for (const d of rest.filter((d) => !d.generated))
    if (!(await addExtraDomain(created.id, d, notes))) refused.push(d);

  const toRehost = [...rest.filter((d) => d.generated), ...refused];
  if (toRehost.length > 0) {
    try {
      const server = await getServerById(created.serverId);
      const landed = await addImportedDomains(
        created.id,
        toRehost.map(importedRoute),
        {
          slug: created.slug,
          ip: resolveServerIp(server ?? undefined),
          seed: rehosted,
        },
      );
      const wasThrowaway = new Set(
        rest.filter((d) => d.generated).map((d) => d.host),
      );
      for (const [source, host] of landed)
        if (!rehosted.has(source)) {
          rehosted.set(source, host);
          rehostNotes.push(
            wasThrowaway.has(source)
              ? `${source} was {panel}'s own temporary address, so it comes across as ${host} here - same port, same route.`
              : `${source} answers on ${host} here instead - same port, same route. Point it at this server and add it under Domains to use the real name.`,
          );
        }
    } catch (e) {
      notes.push(
        `The temporary addresses this app answered on were not recreated: ${
          e instanceof Error ? e.message : "refused"
        }. Add a domain under Domains.`,
      );
    }
  }

  // The one place a re-hosted address cannot be fixed from out here: INSIDE the
  // app's own data. Said on the same line that names the new address.
  if (rehostNotes.length > 0) {
    const landedOn = [...new Set(rehosted.values())].join(", ");
    rehostNotes[rehostNotes.length - 1] +=
      ` If it stores its own address (a trusted_domains, a saved site URL), the copied data still holds the old one - open its Console and set it to ${landedOn}.`;
    notes.push(...rehostNotes);
  }

  // An address that could not come across is a DEAD address, and the app is usually
  // still carrying it in its own configuration: `NEXTCLOUD_DOMAIN`, `SITE_URL`, a
  // CORS origin, a callback URL.
  if (rehosted.size > 0) {
    const rewritten = env.map((e) => ({
      key: e.key,
      value: rewriteHosts(e.value, rehosted),
    }));
    const touched = rewritten
      .filter((r, i) => r.value !== env[i]!.value)
      .map((r) => r.key);
    if (touched.length > 0) {
      try {
        // Secrets included: an address arrives write-only as often as not, and this
        // is the import correcting a value it wrote itself a moment ago.
        await setAppEnv(created.id, rewritten, undefined, {
          overwriteSecrets: true,
        });
        notes.push(
          `${touched.join(", ")} named the old address, so ${
            touched.length === 1 ? "it now names" : "they now name"
          } the new one.`,
        );
      } catch (e) {
        notes.push(
          `${touched.join(", ")} still name the old address (${
            e instanceof Error ? e.message : "refused"
          }) - update them under Variables.`,
        );
      }
    }
  }
}
