import { notFound } from "next/navigation";
import { Activity } from "lucide-react";

import { getAppBySlug } from "@/lib/data/apps";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { ResourceActivity } from "@/components/activity/resource-activity";

export const metadata = { title: "Activity" };

/**
 * The team's audit trail narrowed to this app - who deployed, changed a domain,
 * touched a variable, and when.
 */
export default async function AppActivitySettingsPage(
  props: PageProps<"/apps/[slug]/settings/activity">,
) {
  const { slug } = await props.params;
  const app = await getAppBySlug(slug);
  if (!app) notFound();

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Activity}
        title="Activity"
        docs="team.activity"
        info="Everything that happened to this app, newest first."
      />
      <ResourceActivity
        resourceId={app.id}
        base={`/apps/${slug}/settings/activity`}
        searchParams={await props.searchParams}
        appLinks={{ [app.id]: { name: app.name, slug, logo: app.logo } }}
      />
    </section>
  );
}
