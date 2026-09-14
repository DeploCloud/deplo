import { notFound } from "next/navigation";

import { getDatabase } from "@/lib/data/databases/rows";
import { PageHeader } from "@/components/shared/page-header";
import { ScopedActivity } from "@/components/activity/scoped-activity";

export const metadata = { title: "Activity" };

// History starts where `activities.database_id` did (migration 0134).
export default async function DatabaseActivityPage(
  props: PageProps<"/[team]/storage/databases/[id]/activity">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  return (
    <div className="space-y-5">
      <PageHeader
        level="section"
        title="Activity"
        docs="team.activity"
        description="Everything that happened to this database, newest first."
      />
      <ScopedActivity
        scope={{ kind: "resource", resourceId: db.id }}
        base={`/storage/databases/${id}/activity`}
        searchParams={await props.searchParams}
        emptyDescription="Every change made here shows up in this list."
        databaseLinks={{
          [db.id]: { name: db.name, logo: db.logo, type: db.type },
        }}
      />
    </div>
  );
}
