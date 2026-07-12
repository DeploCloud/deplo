import { builder } from "../builder";
import {
  getPluginCatalog,
  listInstalledPlugins,
  installPlugin,
  uninstallPlugin,
  startPlugin,
  stopPlugin,
  type InstalledPluginDTO,
} from "@/lib/data/plugins";
import type { PluginListing } from "@/lib/plugins/manifest";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

/** A catalog entry — an installable plugin fetched from the plugin repository. */
const PluginListingRef = builder.objectRef<PluginListing>("PluginListing").implement({
  description:
    "An installable plugin from the remote plugin repository (read-only catalog). " +
    "Distinct from a Template, which ships inside Deplo.",
  fields: (t) => ({
    id: t.exposeString("id"),
    name: t.exposeString("name"),
    description: t.exposeString("description"),
    version: t.exposeString("version"),
    logo: t.exposeString("logo", { nullable: true }),
    tags: t.exposeStringList("tags"),
  }),
});

/**
 * A plugin a team installed (ADR-0005: a host-managed container, never an app).
 * `status` is a resolver — read LIVE from the container at query time, never
 * stored — and `url` is computed from the slug (the plugin path under Deplo's own
 * host). The DTO already carries both, resolved in the data layer.
 */
const InstalledPluginRef = builder
  .objectRef<InstalledPluginDTO>("InstalledPlugin")
  .implement({
    description:
      "A plugin a team installed from the plugin repository — a host-managed " +
      "container, not an app. Status is read live from the container; the " +
      "URL is the plugin path under Deplo's own host.",
    fields: (t) => ({
      id: t.exposeID("id"),
      catalogId: t.exposeString("catalogId"),
      version: t.exposeString("version"),
      // Live status — resolved in the data layer via `docker inspect`, exposed
      // here as a string field (the DTO already holds the live value).
      status: t.exposeString("status"),
      url: t.exposeString("url"),
      createdAt: t.exposeString("createdAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  pluginCatalog: t.field({
    type: [PluginListingRef],
    authScopes: { loggedIn: true },
    description: "The remote catalog of installable plugins.",
    resolve: () => getPluginCatalog(),
  }),
  installedPlugins: t.field({
    type: [InstalledPluginRef],
    authScopes: { loggedIn: true },
    description:
      "Plugins the active team has installed, newest first, with live status.",
    resolve: () => listInstalledPlugins(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (whole lifecycle gated on manage_infra — ADR-0005)        */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  installPlugin: t.field({
    type: InstalledPluginRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Install a plugin from the catalog (one per plugin per team; recreates the " +
      "container in place if already installed). Mints no token — the caller " +
      "supplies their own from Settings → API Tokens.",
    args: { catalogId: t.arg.string({ required: true }) },
    resolve: (_r, { catalogId }) => installPlugin(catalogId),
  }),
  uninstallPlugin: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description:
      "Uninstall a plugin: destroy its container + Traefik router and drop the " +
      "row. Revokes nothing (the plugin held no token). Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await uninstallPlugin(id);
      return true;
    },
  }),
  startPlugin: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Start a stopped plugin's container. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await startPlugin(id);
      return true;
    },
  }),
  stopPlugin: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Stop a running plugin's container. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await stopPlugin(id);
      return true;
    },
  }),
}));
