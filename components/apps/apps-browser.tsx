"use client";

import * as React from "react";
import { Blocks, AlertTriangle } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { CatalogAppCard, InstalledAppCard } from "./app-card";
import type { AppListing } from "@/lib/apps/manifest";
import type { InstalledAppDTO } from "@/lib/data/apps";

/**
 * The Apps page body: the team's installed apps (live status + power + connect +
 * uninstall) above the remote catalog (install). Server-fetched data in, GraphQL
 * mutations out via the cards. Installed rows store only `catalogId`, so their
 * display name/logo are joined from the catalog listing when available.
 */
export function AppsBrowser({
  catalog,
  installed,
  catalogError,
  repoBase,
}: {
  catalog: AppListing[];
  installed: InstalledAppDTO[];
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
            Apps running for this team. Status is read live from the container.
          </p>
        </div>
        {installed.length === 0 ? (
          <EmptyState
            icon={Blocks}
            title="No apps installed"
            description="Install an app from the catalog below to extend Deplo."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
            {installed.map((app) => {
              const listing = byId.get(app.catalogId);
              return (
                <InstalledAppCard
                  key={app.id}
                  app={app}
                  name={listing?.name ?? app.catalogId}
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
            Apps available from{" "}
            <span className="font-mono">{repoBase.replace(/^https?:\/\//, "")}</span>.
          </p>
        </div>

        {catalogError ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-foreground">
                Could not load the app catalog
              </p>
              <p className="text-muted-foreground">{catalogError}</p>
            </div>
          </div>
        ) : catalog.length === 0 ? (
          <EmptyState
            icon={Blocks}
            title="The catalog is empty"
            description="No apps are published in the repository yet."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
            {catalog.map((listing) => (
              <CatalogAppCard
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
