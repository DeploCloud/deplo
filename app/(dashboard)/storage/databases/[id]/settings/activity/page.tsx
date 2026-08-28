import { notFound } from "next/navigation";
import { Activity } from "lucide-react";

import { getDatabase } from "@/lib/data/databases";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { ResourceActivity } from "@/components/activity/resource-activity";

export const metadata = { title: "Activity" };

/**
 * The app tab's twin: the team's audit trail narrowed to this database. Its
 * history starts where `activities.database_id` did (migration 0134).
 */
export default async function DatabaseActivitySettingsPage(
  props: PageProps<"/storage/databases/[id]/settings/activity">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Activity}
        title="Activity"
        docs="team.activity"
        info="Everything that happened to this database, newest first."
      />
      <ResourceActivity
        resourceId={db.id}
        base={`/storage/databases/${id}/settings/activity`}
        searchParams={await props.searchParams}
        databaseLinks={{
          [db.id]: { name: db.name, logo: db.logo, type: db.type },
        }}
      />
    </section>
  );
}
