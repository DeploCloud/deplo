import { CloudOff } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { toStoreTemplate } from "@/components/templates/template-card";
import { TemplateStore } from "@/components/templates/template-store";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import { placementFromSearchParams } from "@/lib/overview-links";
import { templateAccents } from "@/lib/templates/logo-color";
import { listCatalog } from "@/templates/catalog";

export const metadata = { title: "Templates" };

/** `?q=` / `?category=` arrive as strings or repeated params. */
function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function TemplatesPage(props: PageProps<"/templates">) {
  const searchParams = await props.searchParams;

  // The catalogue is a catalogue: anyone on the team may read it. Deploying is
  // the gated action, and its gate lives on the template's own page (and, for
  // real, in `createApp`) — locking the whole store only makes a member ask an
  // admin what is inside it.
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
        <PageHeader title="Templates" />
        <EmptyState
          icon={CloudOff}
          title="The template catalog is unreachable"
          description="Deplo could not reach the template service. Check this server's internet access and try again."
        />
      </div>
    );

  const accents = await templateAccents(templates);

  return (
    <TemplateStore
      templates={templates.map(toStoreTemplate)}
      accents={accents}
      placement={placement}
      initialQuery={one(searchParams.q)}
      initialCategory={one(searchParams.category)}
    />
  );
}
