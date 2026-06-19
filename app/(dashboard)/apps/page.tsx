import { PageHeader } from "@/components/shared/page-header";
import { getAppCatalog, listInstalledApps } from "@/lib/data/apps";
import { appRepoBase } from "@/lib/apps/repository";
import { AppsBrowser } from "@/components/apps/apps-browser";
import type { AppListing } from "@/lib/apps/manifest";

export const metadata = { title: "Apps" };

export default async function AppsPage() {
  // Installed apps are local (store + live status); the catalog is a remote
  // fetch that can fail (repo unreachable). Degrade gracefully: render the
  // installed apps and an inline error banner instead of crashing the page.
  const installed = await listInstalledApps();
  let catalog: AppListing[] = [];
  let catalogError: string | null = null;
  try {
    catalog = await getAppCatalog();
  } catch (e) {
    catalogError = e instanceof Error ? e.message : "Could not reach the app repository";
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Apps"
        description="Install apps from the app repository to extend Deplo. An app runs as a host-managed container, not a project."
      />
      <AppsBrowser
        catalog={catalog}
        installed={installed}
        catalogError={catalogError}
        repoBase={appRepoBase()}
      />
    </div>
  );
}
