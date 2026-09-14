import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { toStoreTemplate } from "@/components/templates/template-card";
import { TemplateStore } from "@/components/templates/template-store";
import { CatalogOfflineGraphic } from "@/components/templates/catalog-offline-graphic";
import { hasCapability } from "@/lib/membership";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import { placementFromSearchParams } from "@/lib/overview-links";
import { templateAccents } from "@/lib/templates/logo-color";
import { listCatalog } from "@/templates/catalog";

export const metadata = { title: "Templates" };

// `?q=` / `?category=` arrive as a string or, when repeated, an array.
function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function TemplatesPage(
  props: PageProps<"/[team]/templates">,
) {
  const searchParams = await props.searchParams;

  // The catalogue is a catalogue: anyone on the team may read it.
  const [placement, canDeploy] = await Promise.all([
    resolveOverviewPlacement(placementFromSearchParams(searchParams)),
    hasCapability("create_apps"),
  ]);

  // Remote service: no egress, or a bad day, renders this page instead of the section's error boundary.
  const templates = await listCatalog().catch(() => null);
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
      // Not awaited: decoding every logo costs a cold process seconds, so a slow catalogue costs colour, not the page.
      accents={templateAccents(templates).catch(() => ({}))}
      canDeploy={canDeploy}
      placement={placement}
      initialQuery={one(searchParams.q)}
      initialCategory={one(searchParams.category)}
    />
  );
}
