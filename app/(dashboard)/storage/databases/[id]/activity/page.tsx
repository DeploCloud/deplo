// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";

import { getDatabase } from "@/lib/data/databases";
import { PageHeader } from "@/components/shared/page-header";
import { ResourceActivity } from "@/components/activity/resource-activity";

export const metadata = { title: "Activity" };

/**
 * The app page's twin: the team's audit trail narrowed to this database. Its
 * history starts where `activities.database_id` did (migration 0134).
 */
export default async function DatabaseActivityPage(
  props: PageProps<"/storage/databases/[id]/activity">,
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
      <ResourceActivity
        resourceId={db.id}
        base={`/storage/databases/${id}/activity`}
        searchParams={await props.searchParams}
        databaseLinks={{
          [db.id]: { name: db.name, logo: db.logo, type: db.type },
        }}
      />
    </div>
  );
}
