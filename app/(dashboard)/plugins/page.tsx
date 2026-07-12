import { PageHeader } from "@/components/shared/page-header";
import { getPluginCatalog, listInstalledPlugins } from "@/lib/data/plugins";
import { pluginRepoBase } from "@/lib/plugins/repository";
import { PluginsBrowser } from "@/components/plugins/plugins-browser";
import type { PluginListing } from "@/lib/plugins/manifest";

export const metadata = { title: "Plugins" };

export default async function PluginsPage() {
  // Installed plugins are local (store + live status); the catalog is a remote
  // fetch that can fail (repo unreachable). Degrade gracefully: render the
  // installed plugins and an inline error banner instead of crashing the page.
  const installed = await listInstalledPlugins();
  let catalog: PluginListing[] = [];
  let catalogError: string | null = null;
  try {
    catalog = await getPluginCatalog();
  } catch (e) {
    catalogError = e instanceof Error ? e.message : "Could not reach the plugin repository";
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plugins"
        description="Install plugins from the plugin repository to extend Deplo. A plugin runs as a host-managed container, not a deployed App."
      />
      <PluginsBrowser
        catalog={catalog}
        installed={installed}
        catalogError={catalogError}
        repoBase={pluginRepoBase()}
      />
    </div>
  );
}
