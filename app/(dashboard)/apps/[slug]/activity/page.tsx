import { notFound } from "next/navigation";

import { getAppBySlug } from "@/lib/data/apps";
import { PageHeader } from "@/components/shared/page-header";
import { ResourceActivity } from "@/components/activity/resource-activity";

export const metadata = { title: "Activity" };

/**
 * The team's audit trail narrowed to this app - who deployed, changed a domain,
 * touched a variable, and when.
 */
export default async function AppActivityPage(
  props: PageProps<"/apps/[slug]/activity">,
) {
  const { slug } = await props.params;
  const app = await getAppBySlug(slug);
  if (!app) notFound();

  return (
    <div className="space-y-5">
      <PageHeader
        level="section"
        title="Activity"
        docs="team.activity"
        description="Everything that happened to this app, newest first."
      />
      <ResourceActivity
        resourceId={app.id}
        base={`/apps/${slug}/activity`}
        searchParams={await props.searchParams}
        appLinks={{ [app.id]: { name: app.name, slug, logo: app.logo } }}
      />
    </div>
  );
}
