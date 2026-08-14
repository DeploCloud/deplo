import Link from "next/link";
import { Lock, CloudOff } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { TemplatesBrowser } from "@/components/templates/templates-browser";
import { hasCapability } from "@/lib/membership";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import { placementFromSearchParams } from "@/lib/overview-links";
import { listCatalog } from "@/templates/catalog";

export const metadata = { title: "Templates" };

export default async function TemplatesPage(props: PageProps<"/templates">) {
  // Every card here deploys a new app, so without that permission the whole
  // catalogue is a dead end. Say so up front, exactly as /new does, instead of
  // letting someone pick a template and be refused by the wizard.
  if (!(await hasCapability("create_apps")))
    return (
      <EmptyState
        icon={Lock}
        title="You can't create apps"
        description="Ask a team admin for permission to create apps, or pick an app you already have from the overview."
        action={
          <Button asChild size="sm">
            <Link href="/">Back to overview</Link>
          </Button>
        }
      />
    );

  // The catalogue can be opened from an Overview drill-in ("Add New → From
  // Template" inside a folder). Carry that context on to the wizard so the
  // deployed template is created IN the folder/environment it was started from.
  const placement = await resolveOverviewPlacement(
    placementFromSearchParams(await props.searchParams),
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Templates"
        description={
          `Deploy ${templates.length} popular apps, databases and services to your servers in one click.` +
          (placement ? ` Deploys land in ${placement.label}.` : "")
        }
      />
      <TemplatesBrowser templates={templates} placement={placement} />
    </div>
  );
}
