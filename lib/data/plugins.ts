import "server-only";

import { headers } from "next/headers";
import { and, desc, eq } from "drizzle-orm";

import { getCurrentUser } from "../auth";
import { getDb } from "../db/client";
import {
  installedPlugins as installedPluginsTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { PUBLIC_URL_PLACEHOLDER } from "../public-url";
import { fetchCatalog, fetchManifest } from "../plugins/repository";
import { resolvePluginEnv } from "../plugins/manifest";
import {
  pluginSlug,
  pluginStatus,
  pluginUrl,
  startPluginStack,
  startPluginContainer,
  stopPluginContainer,
  destroyPluginContainer,
  resolvePublicBaseUrl,
} from "../plugins/runtime";
import type { PluginListing } from "../plugins/manifest";
import type { InstalledPlugin } from "../types";

/**
 * Plugin data layer — team-scoped install/uninstall/list/start/stop, modelled on
 * `lib/data/registries.ts`. Reads use `requireActiveTeamId()`; every mutation is
 * gated on `manage_infra` (ADR-0005: the whole plugin lifecycle). An installed plugin
 * is a host-managed container, never a project — uninstall tears the container
 * down directly via the plugin runtime and NEVER calls the `deploy`-gated
 * `deleteApp`. Status is read live from the socket, never stored.
 */

/** What the UI/API sees for an installed plugin — its live status + computed URL. */
export interface InstalledPluginDTO {
  id: string;
  catalogId: string;
  version: string;
  /** Live container status, read at query time (never stored). */
  status: "running" | "stopped" | "error";
  /** The plugin-path URL under Deplo's own host (computed from the slug). */
  url: string;
  createdAt: string;
}

/** The stored fields of an installed plugin — a `installed_apps` row. */
type PluginRow = Pick<
  InstalledPlugin,
  "id" | "teamId" | "catalogId" | "slug" | "version" | "createdAt"
>;

/** Resolve a team's slug — seeds the deterministic plugin slug at INSTALL time. */
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
 * The plugin's frozen slug. Prefer the value persisted at install; fall back to
 * deriving it for legacy rows written before `slug` was stored (the team has
 * not been renamed yet, so the derived value still matches the live container).
 */
async function pluginSlugFor(app: PluginRow): Promise<string> {
  return app.slug || pluginSlug(app.catalogId, await teamSlug(app.teamId));
}

/** Fetch one installed-plugin row scoped to the active team, or null. */
async function findPlugin(id: string, teamId: string): Promise<PluginRow | null> {
  const rows = await getDb()
    .select()
    .from(installedPluginsTable)
    .where(and(eq(installedPluginsTable.id, id), eq(installedPluginsTable.teamId, teamId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Deplo's public base URL, preferring DEPLO_PUBLIC_URL, else the request host. */
async function publicBaseUrl(): Promise<string> {
  return resolvePublicBaseUrl(await headers());
}

async function toDTO(app: PluginRow): Promise<InstalledPluginDTO> {
  const slug = await pluginSlugFor(app);
  const base = await publicBaseUrl();
  return {
    id: app.id,
    catalogId: app.catalogId,
    version: app.version,
    status: await pluginStatus(slug),
    url: pluginUrl(base, slug),
    createdAt: app.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** The remote catalog of installable plugins (read-only; loggedIn is enough). */
export async function getPluginCatalog(): Promise<PluginListing[]> {
  return fetchCatalog();
}

/** All plugins the active team has installed, newest first, with live status. */
export async function listInstalledPlugins(): Promise<InstalledPluginDTO[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(installedPluginsTable)
    .where(eq(installedPluginsTable.teamId, teamId))
    .orderBy(desc(installedPluginsTable.createdAt));
  return Promise.all(rows.map(toDTO));
}

/** Live status of one installed plugin (read; resolves via `pluginStatus(slug)`). */
export async function pluginRuntimeStatus(
  id: string,
): Promise<"running" | "stopped" | "error"> {
  const teamId = await requireActiveTeamId();
  const app = await findPlugin(id, teamId);
  if (!app) throw new Error("Plugin not installed");
  return pluginStatus(await pluginSlugFor(app));
}

/* ------------------------------------------------------------------ */
/* Mutations (all gated on manage_infra)                               */
/* ------------------------------------------------------------------ */

/**
 * Install a plugin from the catalog (`manage_infra`). One install per plugin per
 * team: if a row already exists, the container is recreated in place rather
 * than duplicating the row (no plugin-held secret to rotate). Returns the DTO.
 *
 * Flow (ADR-0005, step 5):
 *  1. fetch catalog → find listing → fetch + validate manifest.
 *  2. resolve the manifest's env placeholders — the MCP plugin's only one is
 *     `${deplo_graphql_url}` → `<public-url>/api/graphql`.
 *  3. render the compose + `docker compose up -d` on the `deplo` network with
 *     the Traefik path labels. No token is minted (the caller supplies their
 *     own `deplo_` token from Settings → API Tokens).
 *  4. persist the `InstalledPlugin` row (status is live; URL is computed).
 */
export async function installPlugin(catalogId: string): Promise<InstalledPluginDTO> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const teamId = membership.teamId;

  const catalog = await fetchCatalog();
  const listing = catalog.find((l) => l.id === catalogId);
  if (!listing) throw new Error(`Plugin "${catalogId}" is not in the catalog`);
  const manifest = await fetchManifest(listing);

  const base = await publicBaseUrl();
  // Without a real public URL the plugin would be unroutable: the Traefik Host()
  // rule and the baked DEPLO_GRAPHQL_URL would both point at the placeholder
  // host. Fail loudly before installing a broken stack (mirrors github.ts).
  if (base === PUBLIC_URL_PLACEHOLDER) {
    throw new Error(
      "Set DEPLO_PUBLIC_URL to a public, externally-reachable URL so the plugin can be routed and reached before installing.",
    );
  }
  const resolvedEnv = resolvePluginEnv(manifest.env, {
    deploGraphqlUrl: `${base.replace(/\/+$/, "")}/api/graphql`,
  });

  // One install per plugin per team: reuse the existing row (recreate-in-place) or
  // create a fresh one. The slug is FROZEN — reuse the existing row's slug so a
  // reinstall after a team rename still targets the original container; only a
  // brand-new install derives the slug from the current team slug.
  const existing = (
    await getDb()
      .select()
      .from(installedPluginsTable)
      .where(
        and(
          eq(installedPluginsTable.teamId, teamId),
          eq(installedPluginsTable.catalogId, catalogId),
        ),
      )
      .limit(1)
  )[0];
  const slug = existing
    ? await pluginSlugFor(existing)
    : pluginSlug(catalogId, await teamSlug(teamId));
  await startPluginStack({
    slug,
    manifest,
    resolvedEnv,
    publicBaseUrl: base,
    isReinstall: !!existing,
  });

  let row: PluginRow;
  if (existing) {
    row = { ...existing, slug, version: manifest.version };
    await getDb()
      .update(installedPluginsTable)
      .set({ slug, version: manifest.version })
      .where(eq(installedPluginsTable.id, existing.id));
  } else {
    row = {
      id: newId("app"),
      teamId,
      catalogId,
      slug,
      version: manifest.version,
      createdAt: nowIso(),
    };
    await getDb().insert(installedPluginsTable).values(row);
  }
  await recordActivity(
    "member",
    `${existing ? "Reinstalled" : "Installed"} plugin ${listing.name}`,
    user.name,
    null,
    teamId,
  );
  return toDTO(row);
}

/**
 * Uninstall a plugin (`manage_infra`): destroy the container + its Traefik router
 * and drop the row. No token to revoke (the plugin held none); does NOT call the
 * `deploy`-gated `deleteApp` (there is no project record).
 */
export async function uninstallPlugin(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const teamId = membership.teamId;
  const app = await findPlugin(id, teamId);
  if (!app) throw new Error("Plugin not installed");

  await destroyPluginContainer(await pluginSlugFor(app));
  await getDb()
    .delete(installedPluginsTable)
    .where(and(eq(installedPluginsTable.id, id), eq(installedPluginsTable.teamId, teamId)));
  await recordActivity(
    "member",
    `Uninstalled plugin ${app.catalogId}`,
    user.name,
    null,
    teamId,
  );
}

/** Start a stopped plugin's container (`manage_infra`). */
export async function startPlugin(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const app = await findPlugin(id, membership.teamId);
  if (!app) throw new Error("Plugin not installed");
  await startPluginContainer(await pluginSlugFor(app));
}

/** Stop a running plugin's container (`manage_infra`). */
export async function stopPlugin(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const app = await findPlugin(id, membership.teamId);
  if (!app) throw new Error("Plugin not installed");
  await stopPluginContainer(await pluginSlugFor(app));
}
