import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { isValidLogoValue } from "../../apps/logo-shared";
import { detectAppFavicon } from "../../apps/favicon-detect";
import { faviconSourceKind } from "../../apps/favicon-shared";
import { AgentUnreachableError } from "../../infra/agent-client/errors";
import { appInTeam, loadAppGraph, loadDomainsForApp } from "../app-graph-load";
import { requireAppCapability } from "../node-access";
import { recordActivity } from "../activity";
import { publishAppChanged } from "../../graphql/pubsub";

// updateAppLogo stores the logo INLINE (data-URI or /templates path), never a remote URL, so it renders under the strict CSP.
export async function updateAppLogo(
  id: string,
  logo: string | null,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const next = logo?.trim() ? logo.trim() : null;
  if (next && !isValidLogoValue(next)) {
    throw new Error("Unsupported logo image");
  }

  // Conditional UPDATE: an unchanged logo bumps no `updatedAt` and reorders no dashboard.
  const updated = await getDb()
    .update(appsTable)
    .set({ logo: next, logoTone: null, updatedAt: nowIso() })
    .where(
      and(
        eq(appsTable.id, id),
        eq(appsTable.teamId, membership.teamId),
        next === null
          ? sql`${appsTable.logo} is not null`
          : sql`${appsTable.logo} is distinct from ${next}`,
      ),
    )
    .returning({ id: appsTable.id });

  // Tell "not found / not owned" from "unchanged": verify existence only when nothing changed.
  if (updated.length === 0) {
    const exists = await appInTeam(id, membership.teamId);
    if (!exists) throw new Error("App not found");
    return;
  }
  await recordActivity("app", `Updated app logo`, user.name, id);
}

// A compose app is read twice - its own files AND the running app - so the empty-handed message says which.
function noIconFoundMessage(
  app: Parameters<typeof detectAppFavicon>[0],
): string {
  if (faviconSourceKind(app) === "app-files") {
    return "No icon found. Deplo looked in this app's files and asked the running app for its favicon - check that the app is running and serves one.";
  }
  return "No file named favicon (SVG, PNG or ICO) found in this app's files";
}

// redetectAppLogo overwrites the current logo on demand; the automatic hooks still only fill a NULL one.
export async function redetectAppLogo(id: string): Promise<string> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId) {
    throw new Error("App not found");
  }
  const domains = await loadDomainsForApp(id);
  const routes = domains.map((d) => ({
    name: d.name,
    service: d.service ?? null,
    port: d.port ?? null,
    pathPrefix: d.pathPrefix ?? "",
    stripPrefix: d.stripPrefix ?? false,
  }));
  const primaryHost =
    domains.find((d) => d.primary)?.name ?? domains[0]?.name ?? "";

  // The server not answering must not be reported as "your app has no icon".
  const logo = await detectAppFavicon(project, routes, primaryHost).catch(
    (e) => {
      if (e instanceof AgentUnreachableError) {
        throw new Error(
          "The server that runs this app didn't answer, so Deplo couldn't read its files. It may be offline.",
          { cause: e },
        );
      }
      throw e;
    },
  );
  if (!logo || !isValidLogoValue(logo)) {
    throw new Error(noIconFoundMessage(project));
  }
  await getDb()
    .update(appsTable)
    .set({ logo, logoTone: null, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)));
  await recordActivity("app", `Detected app logo from source`, user.name, id);
  publishAppChanged(id);
  return logo;
}
