import { builder } from "../builder";
import {
  getAppCatalog,
  listInstalledApps,
  installApp,
  uninstallApp,
  startApp,
  stopApp,
  type InstalledAppDTO,
} from "@/lib/data/apps";
import type { AppListing } from "@/lib/apps/manifest";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

/** A catalog entry — an installable app fetched from the app repository. */
const AppListingRef = builder.objectRef<AppListing>("AppListing").implement({
  description:
    "An installable app from the remote app repository (read-only catalog). " +
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
 * An app a team installed (ADR-0005: a host-managed container, never a project).
 * `status` is a resolver — read LIVE from the container at query time, never
 * stored — and `url` is computed from the slug (the app path under Deplo's own
 * host). The DTO already carries both, resolved in the data layer.
 */
const InstalledAppRef = builder
  .objectRef<InstalledAppDTO>("InstalledApp")
  .implement({
    description:
      "An app a team installed from the app repository — a host-managed " +
      "container, not a project. Status is read live from the container; the " +
      "URL is the app path under Deplo's own host.",
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
  appCatalog: t.field({
    type: [AppListingRef],
    authScopes: { loggedIn: true },
    description: "The remote catalog of installable apps.",
    resolve: () => getAppCatalog(),
  }),
  installedApps: t.field({
    type: [InstalledAppRef],
    authScopes: { loggedIn: true },
    description:
      "Apps the active team has installed, newest first, with live status.",
    resolve: () => listInstalledApps(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (whole lifecycle gated on manage_infra — ADR-0005)        */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  installApp: t.field({
    type: InstalledAppRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Install an app from the catalog (one per app per team; recreates the " +
      "container in place if already installed). Mints no token — the caller " +
      "supplies their own from Settings → API Tokens.",
    args: { catalogId: t.arg.string({ required: true }) },
    resolve: (_r, { catalogId }) => installApp(catalogId),
  }),
  uninstallApp: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description:
      "Uninstall an app: destroy its container + Traefik router and drop the " +
      "row. Revokes nothing (the app held no token). Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await uninstallApp(id);
      return true;
    },
  }),
  startApp: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Start a stopped app's container. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await startApp(id);
      return true;
    },
  }),
  stopApp: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Stop a running app's container. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await stopApp(id);
      return true;
    },
  }),
}));
