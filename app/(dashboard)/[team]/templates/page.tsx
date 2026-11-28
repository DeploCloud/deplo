import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { toStoreTemplate } from "@/components/templates/template-card";
import { TemplateStore } from "@/components/templates/template-store";
import { CatalogOfflineGraphic } from "@/components/templates/catalog-offline-graphic";
import { hasCapability } from "@/lib/membership";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import { placementFromSearchParams } from "@/lib/overview-links";
import { FEATURED_LIMIT } from "@/components/templates/collections";
import { listCatalog, listFeaturedTemplates } from "@/lib/templates/catalog";

export const metadata = { title: "Templates" };

export default async function TemplatesPage(
  props: PageProps<"/[team]/templates">,
) {
  const searchParams = await props.searchParams;

  const [placement, canDeploy] = await Promise.all([
    resolveOverviewPlacement(placementFromSearchParams(searchParams)),
    hasCapability("create_apps"),
  ]);

  const [templates, featured] = await Promise.all([
    listCatalog().catch(() => null),
    listFeaturedTemplates(FEATURED_LIMIT).catch(() => []),
  ]);
  if (!templates)
    return (
      <div className="space-y-6">
        <PageHeader title="Templates" docs="deploy.fromTemplate" />
        <EmptyState
          graphic={<CatalogOfflineGraphic />}
          title="The template catalog is unreachable"
          description="Deplo could not reach the template service. Check this server's internet access and try again."
        />
      </div>
    );

  return (
    <TemplateStore
      templates={templates.map(toStoreTemplate)}
      featured={featured.map(toStoreTemplate)}
      canDeploy={canDeploy}
      placement={placement}
    />
  );
}
