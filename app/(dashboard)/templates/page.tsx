import Link from "next/link";
import { Lock } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { hasCapability } from "@/lib/membership";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import { placementFromSearchParams } from "@/lib/overview-links";
import { getTemplates } from "@/templates/actions";

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

  const params = await props.searchParams;
  const value = (key: string) => {
    const param = params[key];
    return Array.isArray(param) ? param[0] : param;
  };
  const search = value("search") ?? "";
  const sort = value("sort");
  const order = value("order");
  const placement = await resolveOverviewPlacement(
    placementFromSearchParams(params),
  );
  const data = await getTemplates({
    page: Number(value("page") ?? 1),
    limit: Number(value("limit") ?? 20),
    search,
    category: value("category") || undefined,
    sort:
      sort === "category" || sort === "createdAt" || sort === "lastUpdate"
        ? sort
        : "name",
    order: order === "desc" ? "desc" : "asc",
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Templates"
        description={
          `Deploy ${data.pagination.total} popular apps, databases and services to your servers in one click.` +
          (placement ? ` Deploys land in ${placement.label}.` : "")
        }
      />

      {data.data.map((t) => t.name).join(", ")}
    </div>
  );
}
