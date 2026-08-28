import { Activity as ActivityIcon } from "lucide-react";

import {
  activityMonths,
  listActivity,
  listActivityActors,
} from "@/lib/data/activity";
import { listApps } from "@/lib/data/apps";
import { listDatabases } from "@/lib/data/databases";
import { listFolders } from "@/lib/data/folders";
import { listProjects } from "@/lib/data/projects";
import { EmptyState } from "@/components/shared/empty-state";
import { ActivityFilters } from "@/components/activity/activity-filters";
import { ActivityFeed } from "@/components/activity/activity-feed";
import {
  toActivityItem,
  type AppLinks,
  type DatabaseLinks,
} from "@/components/activity/activity-timeline";
import {
  ACTIVITY_PAGE_SIZE,
  activityHref,
  activityWindow,
  hasActivityFilters,
  parseActivityParams,
} from "@/lib/activity-filter";
import { reachesWholeTeam } from "@/lib/membership";
import type { FacetOption } from "@/components/env/env-filters";

export const metadata = { title: "Activity" };

export default async function ActivityPage(props: PageProps<"/activity">) {
  const params = parseActivityParams(await props.searchParams);
  const filter = {
    actorUserIds: params.actorUserIds,
    types: params.types,
    resourceIds: params.resourceIds,
    ...activityWindow(params),
  };

  // A database belongs to the team and to no project, so `listDatabases` refuses a
  // role that only reaches part of it - and such a role reaches no database row in
  // the feed either, so there is nothing to name.
  const [activities, months, actors, apps, folders, projects, teamWide] =
    await Promise.all([
      listActivity(ACTIVITY_PAGE_SIZE, filter),
      activityMonths(filter),
      listActivityActors(),
      listApps(),
      listFolders(),
      listProjects(),
      reachesWholeTeam(),
    ]);
  const databases = teamWide ? await listDatabases() : [];

  const filtered = hasActivityFilters(params);
  const filters = (
    <ActivityFilters
      params={params}
      actors={actorOptions(actors)}
      apps={apps}
      folders={folders}
      projects={projects}
      databases={databases}
    />
  );

  if (activities.length === 0)
    return (
      <>
        {filtered && filters}
        <EmptyState
          icon={ActivityIcon}
          docs="team.activity"
          title={filtered ? "No matching activity" : "No activity yet"}
          description={
            filtered
              ? "No one did any of that in this window. Widen the filters to see more."
              : "As you deploy apps, manage databases and invite members, everything will show up here."
          }
          // No action: when the filters are what emptied the page, the toolbar
          // above is still on screen and already carries "Clear filters".
        />
      </>
    );

  return (
    <>
      {filters}
      <ActivityFeed
        // A filter change is a fresh first page, not more of the old one.
        key={activityHref(params)}
        initialItems={activities.map(toActivityItem)}
        monthCounts={Object.fromEntries(months.map((m) => [m.month, m.count]))}
        appLinks={appLinks(apps)}
        databaseLinks={databaseLinks(databases)}
        variables={{
          actorUserIds: nonEmpty(params.actorUserIds),
          types: nonEmpty(params.types),
          resourceIds: nonEmpty(params.resourceIds),
          from: filter.from ?? null,
          to: filter.to ?? null,
        }}
        pageSize={ACTIVITY_PAGE_SIZE}
      />
    </>
  );
}

function nonEmpty(values: string[]): string[] | null {
  return values.length ? values : null;
}

function actorOptions(
  actors: Awaited<ReturnType<typeof listActivityActors>>,
): FacetOption[] {
  return actors.map((a) => ({
    value: a.value,
    label: a.label,
    author: a.author ?? undefined,
  }));
}

/** Only what `listApps` returned: an app the caller cannot list stays plain text
 *  in the sentence rather than becoming a link into a 404. */
function appLinks(
  apps: { id: string; name: string; slug: string; logo: string | null }[],
): AppLinks {
  return Object.fromEntries(
    apps.map((a) => [a.id, { name: a.name, slug: a.slug, logo: a.logo }]),
  );
}

/** The database twin of {@link appLinks}. */
function databaseLinks(
  databases: Awaited<ReturnType<typeof listDatabases>>,
): DatabaseLinks {
  return Object.fromEntries(
    databases.map((d) => [d.id, { name: d.name, logo: d.logo, type: d.type }]),
  );
}
