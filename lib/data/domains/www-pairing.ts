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
  if ((self.pathPrefix ?? "").trim())
    throw new Error(
      `${self.name} routes the path ${self.pathPrefix} - a www redirect applies to a whole hostname, so it can't be set on a path route.`,
    );
  const other = all.find((d) => d.name === counterpart);

  if (mode === "none") {
    if (self.redirectTo) await writeRedirectTo(self.id, null);
    if (other && other.redirectTo === self.name) {
      if (other.source === "redirect") await deleteDomainRow(other.id);
      else await writeRedirectTo(other.id, null);
    }
    return;
  }

  if (mode === "toThis") {
    if (self.redirectTo) await writeRedirectTo(self.id, null);
    if (!other) {
      await insertPairedDomain(self, counterpart, {
        redirectTo: self.name,
        source: "redirect",
        teamId,
      });
    } else {
      if ((other.pathPrefix ?? "").trim())
        throw new Error(
          `${counterpart} routes the path ${other.pathPrefix} - remove that domain before redirecting the hostname.`,
        );
      await writeRedirectTo(other.id, self.name);
    }
    await movePrimaryToServingHost(domain.appId, self.name, counterpart);
    return;
  }

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

async function writeRedirectTo(
  id: string,
  target: string | null,
): Promise<void> {
  await getDb()
    .update(domainsTable)
    .set({ redirectTo: target })
    .where(eq(domainsTable.id, id));
}

async function deleteDomainRow(id: string): Promise<void> {
  await getDb().delete(domainsTable).where(eq(domainsTable.id, id));
}

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
    ...(from.proxied ? { proxied: true } : {}),
    createdAt: nowIso(),
  });
}
