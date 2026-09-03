import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { toStoreTemplate } from "@/components/templates/template-card";
import { TemplateStore } from "@/components/templates/template-store";
import { CatalogOfflineGraphic } from "@/components/templates/catalog-offline-graphic";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import { placementFromSearchParams } from "@/lib/overview-links";
import { templateAccents } from "@/lib/templates/logo-color";
import { listCatalog } from "@/templates/catalog";

export const metadata = { title: "Templates" };

/** `?q=` / `?category=` arrive as strings or repeated params. */
function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function TemplatesPage(
  props: PageProps<"/[team]/templates">,
) {
  const searchParams = await props.searchParams;

  // The catalogue is a catalogue: anyone on the team may read it.
  const placement = await resolveOverviewPlacement(
    placementFromSearchParams(searchParams),
  );

  // The catalogue lives on a remote service. An instance with no egress (or a
  // service having a bad day) gets a page that says so, not an error boundary
  // over the whole dashboard section.
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
      // Not awaited: reading the accents fetches and decodes every logo in the catalogue,
      // which costs a cold process seconds. A catalogue having a bad day costs colour,
      // never the page.
      accents={templateAccents(templates).catch(() => ({}))}
      placement={placement}
      initialQuery={one(searchParams.q)}
      initialCategory={one(searchParams.category)}
    />
  );
}
