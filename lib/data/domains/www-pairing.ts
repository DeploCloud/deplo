import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { newId, nowIso } from "../../ids";
import { certProviderForDns, isRoutableDomain } from "../../deploy/cloudflare";
import { insertDomain, loadDomainsForApp } from "../app-graph-load";
import {
  wwwCounterpart,
  deriveWwwRedirect,
  type WwwRedirect,
} from "../../www-redirect";
import type { Domain } from "../../types/domain";
import { domainNameExists } from "./hostname-claim";
import { appServerIp, checkDomainDns } from "./dns-check";
import { assertTeamLetsencryptQuota } from "./letsencrypt-quota";

// applyWwwRedirect: pair a hostname with its `www`/non-`www` counterpart so one of
// the two serves the app and the other permanently redirects to it. `mode` is
// expressed relative to `domain`, the row the user is editing.
export async function applyWwwRedirect(
  domain: Domain,
  mode: WwwRedirect,
  teamId: string,
): Promise<void> {
  const all = await loadDomainsForApp(domain.appId);
  const self = all.find((d) => d.id === domain.id) ?? domain;
  if (deriveWwwRedirect(self.name, all) === mode) return;

  const counterpart = wwwCounterpart(self.name);
  if (!counterpart)
    throw new Error(
      `${self.name} has no www variant to pair with - the www redirect is for a site's own domain, e.g. example.com.`,
    );
  // A path-routed row serves ONE path of its host, not the site, so pairing it
  // with a whole-host redirect would send the rest of the host nowhere.
  if ((self.pathPrefix ?? "").trim())
    throw new Error(
      `${self.name} routes the path ${self.pathPrefix} - a www redirect applies to a whole hostname, so it can't be set on a path route.`,
    );
  const other = all.find((d) => d.name === counterpart);

  if (mode === "none") {
    if (self.redirectTo) await writeRedirectTo(self.id, null);
    if (other && other.redirectTo === self.name) {
      // Ours to delete only if we created it; a hostname the user added is left
      // in place, serving the app again.
      if (other.source === "redirect") await deleteDomainRow(other.id);
      else await writeRedirectTo(other.id, null);
    }
    return;
  }

  if (mode === "toThis") {
    // This row serves from now on, so it can't also be redirecting away.
    if (self.redirectTo) await writeRedirectTo(self.id, null);
    if (!other) {
      await insertPairedDomain(self, counterpart, {
        redirectTo: self.name,
        source: "redirect",
        teamId,
      });
    } else {
      // A path route serves ONE path of its host; turning it into a whole-host
      // redirect would send the rest of that hostname nowhere.
      if ((other.pathPrefix ?? "").trim())
        throw new Error(
          `${counterpart} routes the path ${other.pathPrefix} - remove that domain before redirecting the hostname.`,
        );
      await writeRedirectTo(other.id, self.name);
    }
    await movePrimaryToServingHost(domain.appId, self.name, counterpart);
    return;
  }

  // toCounterpart: the counterpart serves, this row redirects to it.
  if (!other) {
    await insertPairedDomain(self, counterpart, {
      redirectTo: null,
      source: "custom",
      teamId,
    });
  } else if (other.redirectTo) {
    await writeRedirectTo(other.id, null);
  }
  await writeRedirectTo(self.id, counterpart);
  await movePrimaryToServingHost(domain.appId, counterpart, self.name);
}

async function movePrimaryToServingHost(
  appId: string,
  servingName: string,
  redirectingName: string,
): Promise<void> {
  const rows = await loadDomainsForApp(appId);
  const redirecting = rows.find((d) => d.name === redirectingName);
  if (!redirecting?.primary) return;
  const serving = rows.find((d) => d.name === servingName);
  if (!serving) return;
  await getDb().transaction(async (tx) => {
    await tx
      .update(domainsTable)
      .set({ isPrimary: false })
      .where(
        and(eq(domainsTable.appId, appId), eq(domainsTable.isPrimary, true)),
      );
    await tx
      .update(domainsTable)
      .set({ isPrimary: true })
      .where(eq(domainsTable.id, serving.id));
  });
}

// repointRedirects: follow a renamed hostname with everything that redirects to it.
export async function repointRedirects(
  appId: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const dependents = (await loadDomainsForApp(appId)).filter(
    (d) => d.redirectTo === oldName,
  );
  if (dependents.length === 0) return;
  const nextCounterpart = wwwCounterpart(newName);
  for (const dep of dependents) {
    const rename =
      dep.source === "redirect" &&
      dep.name === wwwCounterpart(oldName) &&
      nextCounterpart != null &&
      nextCounterpart !== dep.name &&
      !(await domainNameExists(nextCounterpart));
    if (!rename) {
      await writeRedirectTo(dep.id, newName);
      continue;
    }
    const status = await checkDomainDns(
      nextCounterpart!,
      await appServerIp(appId),
    );
    await getDb()
      .update(domainsTable)
      .set({
        name: nextCounterpart!,
        redirectTo: newName,
        status,
        ssl:
          (dep.certProvider ?? "letsencrypt") !== "none" &&
          isRoutableDomain({ status, proxied: dep.proxied }),
      })
      .where(eq(domainsTable.id, dep.id));
  }
}

// The single writer of `redirect_to`, so every path through the pairing above
// stays one statement and one meaning.
async function writeRedirectTo(
  id: string,
  target: string | null,
): Promise<void> {
  await getDb()
    .update(domainsTable)
    .set({ redirectTo: target })
    .where(eq(domainsTable.id, id));
}

// Drop a domain row (its `domain_middlewares` children CASCADE).
async function deleteDomainRow(id: string): Promise<void> {
  await getDb().delete(domainsTable).where(eq(domainsTable.id, id));
}

// The other half of a `www` pair, cloned from the row being edited: a redirect
// answering on `https://www.…` needs its own certificate, or the browser errors first.
async function insertPairedDomain(
  from: Domain,
  name: string,
  opts: {
    redirectTo: string | null;
    source: "redirect" | "custom";
    teamId: string;
  },
): Promise<void> {
  if (await domainNameExists(name))
    throw new Error(
      `${name} is already routed by another app - remove it there first.`,
    );
  const status = await checkDomainDns(name, await appServerIp(from.appId));
  // Mirror the canonical host's certificate choice, upgrading to `cloudflare`
  // when the check finds THIS hostname proxied (the same rule an add follows).
  const certProvider = certProviderForDns(status, from.certProvider ?? "none");
  await assertTeamLetsencryptQuota(opts.teamId, certProvider);
  await insertDomain(getDb(), {
    id: newId("dom"),
    appId: from.appId,
    name,
    status,
    primary: false,
    redirectTo: opts.redirectTo,
    ssl:
      certProvider !== "none" &&
      isRoutableDomain({ status, proxied: from.proxied }),
    source: opts.source,
    port: from.port ?? null,
    ...(from.entrypoint ? { entrypoint: from.entrypoint } : {}),
    certProvider,
    ...(from.service ? { service: from.service } : {}),
    // Whatever fronts the canonical host fronts its www twin too.
    ...(from.proxied ? { proxied: true } : {}),
    createdAt: nowIso(),
  });
}
