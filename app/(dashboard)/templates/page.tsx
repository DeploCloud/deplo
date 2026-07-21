import { PageHeader } from "@/components/shared/page-header";
import { TemplatesBrowser } from "@/components/templates/templates-browser";
import { TEMPLATES, topTags } from "@/lib/templates";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import { placementFromSearchParams } from "@/lib/overview-links";

export const metadata = { title: "Templates" };

export default async function TemplatesPage(props: PageProps<"/templates">) {
  // The catalogue can be opened from an Overview drill-in ("Add New → From
  // Template" inside a folder). Carry that context on to the wizard so the
  // deployed template is created IN the folder/environment it was started from.
  const placement = await resolveOverviewPlacement(
    placementFromSearchParams(await props.searchParams),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Templates"
        description={
          `Deploy ${TEMPLATES.length} popular apps, databases and services to your servers in one click.` +
          (placement ? ` Deploys land in ${placement.label}.` : "")
        }
      />
      <TemplatesBrowser
        templates={TEMPLATES}
        tags={topTags(16)}
        placement={placement}
      />
    </div>
  );
}
