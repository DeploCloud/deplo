import "server-only";

import { headers } from "next/headers";
import { and, desc, eq } from "drizzle-orm";

import { getCurrentUser } from "../auth";
import { getDb } from "../db/client";
import {
  installedApps as installedAppsTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { PUBLIC_URL_PLACEHOLDER } from "../public-url";
import { fetchCatalog, fetchManifest } from "../apps/repository";
import { resolveAppEnv } from "../apps/manifest";
import {
  appSlug,
  appStatus,
  appUrl,
  startAppStack,
  startAppContainer,
  stopAppContainer,
  destroyAppContainer,
  resolvePublicBaseUrl,
} from "../apps/runtime";
import type { AppListing } from "../apps/manifest";
import type { InstalledApp } from "../types";

/**
 * App data layer — team-scoped install/uninstall/list/start/stop, modelled on
 * `lib/data/registries.ts`. Reads use `requireActiveTeamId()`; every mutation is
 * gated on `manage_infra` (ADR-0005: the whole app lifecycle). An installed app
 * is a host-managed container, never a project — uninstall tears the container
 * down directly via the app runtime and NEVER calls the `deploy`-gated
 * `deleteService`. Status is read live from the socket, never stored.
 */

/** What the UI/API sees for an installed app — its live status + computed URL. */
export interface InstalledAppDTO {
  id: string;
  catalogId: string;
  version: string;
  /** Live container status, read at query time (never stored). */
  status: "running" | "stopped" | "error";
  /** The app-path URL under Deplo's own host (computed from the slug). */
  url: string;
  createdAt: string;
}

/** The stored fields of an installed app — a `installed_apps` row. */
type AppRow = Pick<
  InstalledApp,
  "id" | "teamId" | "catalogId" | "slug" | "version" | "createdAt"
>;

/** Resolve a team's slug — seeds the deterministic app slug at INSTALL time. */
async function teamSlug(teamId: string): Promise<string> {
  // Team slugs are relational (cut-set b).
  const rows = await getDb()
    .select({ slug: teamsTable.slug })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  const slug = rows[0]?.slug;
  if (!slug) throw new Error("Active team not found");
  return slug;
}

/**
 * The app's frozen slug. Prefer the value persisted at install; fall back to
 * deriving it for legacy rows written before `slug` was stored (the team has
 * not been renamed yet, so the derived value still matches the live container).
 */
async function appSlugFor(app: AppRow): Promise<string> {
  return app.slug || appSlug(app.catalogId, await teamSlug(app.teamId));
}

/** Fetch one installed-app row scoped to the active team, or null. */
async function findApp(id: string, teamId: string): Promise<AppRow | null> {
  const rows = await getDb()
    .select()
    .from(installedAppsTable)
    .where(and(eq(installedAppsTable.id, id), eq(installedAppsTable.teamId, teamId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Deplo's public base URL, preferring DEPLO_PUBLIC_URL, else the request host. */
async function publicBaseUrl(): Promise<string> {
  return resolvePublicBaseUrl(await headers());
}

async function toDTO(app: AppRow): Promise<InstalledAppDTO> {
  const slug = await appSlugFor(app);
  const base = await publicBaseUrl();
  return {
    id: app.id,
    catalogId: app.catalogId,
    version: app.version,
    status: await appStatus(slug),
    url: appUrl(base, slug),
    createdAt: app.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** The remote catalog of installable apps (read-only; loggedIn is enough). */
export async function getAppCatalog(): Promise<AppListing[]> {
  return fetchCatalog();
}

/** All apps the active team has installed, newest first, with live status. */
export async function listInstalledApps(): Promise<InstalledAppDTO[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(installedAppsTable)
    .where(eq(installedAppsTable.teamId, teamId))
    .orderBy(desc(installedAppsTable.createdAt));
  return Promise.all(rows.map(toDTO));
}

/** Live status of one installed app (read; resolves via `appStatus(slug)`). */
export async function appRuntimeStatus(
  id: string,
): Promise<"running" | "stopped" | "error"> {
  const teamId = await requireActiveTeamId();
  const app = await findApp(id, teamId);
  if (!app) throw new Error("App not installed");
  return appStatus(await appSlugFor(app));
}

/* ------------------------------------------------------------------ */
/* Mutations (all gated on manage_infra)                               */
/* ------------------------------------------------------------------ */

/**
 * Install an app from the catalog (`manage_infra`). One install per app per
 * team: if a row already exists, the container is recreated in place rather
 * than duplicating the row (no app-held secret to rotate). Returns the DTO.
 *
 * Flow (ADR-0005, step 5):
 *  1. fetch catalog → find listing → fetch + validate manifest.
 *  2. resolve the manifest's env placeholders — the MCP app's only one is
 *     `${deplo_graphql_url}` → `<public-url>/api/graphql`.
 *  3. render the compose + `docker compose up -d` on the `deplo` network with
 *     the Traefik path labels. No token is minted (the caller supplies their
 *     own `deplo_` token from Settings → API Tokens).
 *  4. persist the `InstalledApp` row (status is live; URL is computed).
 */
export async function installApp(catalogId: string): Promise<InstalledAppDTO> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const teamId = membership.teamId;

  const catalog = await fetchCatalog();
  const listing = catalog.find((l) => l.id === catalogId);
  if (!listing) throw new Error(`App "${catalogId}" is not in the catalog`);
  const manifest = await fetchManifest(listing);

  const base = await publicBaseUrl();
  // Without a real public URL the app would be unroutable: the Traefik Host()
  // rule and the baked DEPLO_GRAPHQL_URL would both point at the placeholder
  // host. Fail loudly before installing a broken stack (mirrors github.ts).
  if (base === PUBLIC_URL_PLACEHOLDER) {
    throw new Error(
      "Set DEPLO_PUBLIC_URL to a public, externally-reachable URL so the app can be routed and reached before installing.",
    );
  }
  const resolvedEnv = resolveAppEnv(manifest.env, {
    deploGraphqlUrl: `${base.replace(/\/+$/, "")}/api/graphql`,
  });

  // One install per app per team: reuse the existing row (recreate-in-place) or
  // create a fresh one. The slug is FROZEN — reuse the existing row's slug so a
  // reinstall after a team rename still targets the original container; only a
  // brand-new install derives the slug from the current team slug.
  const existing = (
    await getDb()
      .select()
      .from(installedAppsTable)
      .where(
        and(
          eq(installedAppsTable.teamId, teamId),
          eq(installedAppsTable.catalogId, catalogId),
        ),
      )
      .limit(1)
  )[0];
  const slug = existing
    ? await appSlugFor(existing)
    : appSlug(catalogId, await teamSlug(teamId));
  await startAppStack({
    slug,
    manifest,
    resolvedEnv,
    publicBaseUrl: base,
    isReinstall: !!existing,
  });

  let row: AppRow;
  if (existing) {
    row = { ...existing, slug, version: manifest.version };
    await getDb()
      .update(installedAppsTable)
      .set({ slug, version: manifest.version })
      .where(eq(installedAppsTable.id, existing.id));
  } else {
    row = {
      id: newId("app"),
      teamId,
      catalogId,
      slug,
      version: manifest.version,
      createdAt: nowIso(),
    };
    await getDb().insert(installedAppsTable).values(row);
  }
  await recordActivity(
    "member",
    `${existing ? "Reinstalled" : "Installed"} app ${listing.name}`,
    user.name,
    null,
    teamId,
  );
  return toDTO(row);
}

/**
 * Uninstall an app (`manage_infra`): destroy the container + its Traefik router
 * and drop the row. No token to revoke (the app held none); does NOT call the
 * `deploy`-gated `deleteService` (there is no project record).
 */
export async function uninstallApp(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const teamId = membership.teamId;
  const app = await findApp(id, teamId);
  if (!app) throw new Error("App not installed");

  await destroyAppContainer(await appSlugFor(app));
  await getDb()
    .delete(installedAppsTable)
    .where(and(eq(installedAppsTable.id, id), eq(installedAppsTable.teamId, teamId)));
  await recordActivity(
    "member",
    `Uninstalled app ${app.catalogId}`,
    user.name,
    null,
    teamId,
  );
}

/** Start a stopped app's container (`manage_infra`). */
export async function startApp(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const app = await findApp(id, membership.teamId);
  if (!app) throw new Error("App not installed");
  await startAppContainer(await appSlugFor(app));
}

/** Stop a running app's container (`manage_infra`). */
export async function stopApp(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const app = await findApp(id, membership.teamId);
  if (!app) throw new Error("App not installed");
  await stopAppContainer(await appSlugFor(app));
}
