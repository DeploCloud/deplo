"use client";

import * as React from "react";
import { Blocks, AlertTriangle } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { CatalogPluginCard, InstalledPluginCard } from "./plugin-card";
import type { PluginListing } from "@/lib/plugins/manifest";
import type { InstalledPluginDTO } from "@/lib/data/plugins";

/**
 * The Plugins page body: the team's installed plugins (live status + power +
 * connect + uninstall) above the remote catalog (install). Server-fetched data
 * in, GraphQL mutations out via the cards. Installed rows store only `catalogId`,
 * so their display name/logo are joined from the catalog listing when available.
 */
export function PluginsBrowser({
  catalog,
  installed,
  catalogError,
  repoBase,
}: {
  catalog: PluginListing[];
  installed: InstalledPluginDTO[];
  catalogError: string | null;
  repoBase: string;
}) {
  const byId = React.useMemo(
    () => new Map(catalog.map((l) => [l.id, l])),
    [catalog],
  );
  const installedIds = React.useMemo(
    () => new Set(installed.map((a) => a.catalogId)),
    [installed],
  );

  return (
    <div className="space-y-8">
      {/* Installed ------------------------------------------------------ */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Installed</h2>
          <p className="text-xs text-muted-foreground">
            Plugins running for this team. Status is read live from the container.
          </p>
        </div>
        {installed.length === 0 ? (
          <EmptyState
            icon={Blocks}
            title="No plugins installed"
            description="Install a plugin from the catalog below to extend Deplo."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
            {installed.map((plugin) => {
              const listing = byId.get(plugin.catalogId);
              return (
                <InstalledPluginCard
                  key={plugin.id}
                  plugin={plugin}
                  name={listing?.name ?? plugin.catalogId}
                  logo={listing?.logo}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Catalog ------------------------------------------------------- */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Catalog</h2>
          <p className="text-xs text-muted-foreground">
            Plugins available from{" "}
            <span className="font-mono">{repoBase.replace(/^https?:\/\//, "")}</span>.
          </p>
        </div>

        {catalogError ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-foreground">
                Could not load the plugin catalog
              </p>
              <p className="text-muted-foreground">{catalogError}</p>
            </div>
          </div>
        ) : catalog.length === 0 ? (
          <EmptyState
            icon={Blocks}
            title="The catalog is empty"
            description="No plugins are published in the repository yet."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
            {catalog.map((listing) => (
              <CatalogPluginCard
                key={listing.id}
                listing={listing}
                installed={installedIds.has(listing.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
