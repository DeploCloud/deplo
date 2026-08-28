import { Activity as ActivityIcon } from "lucide-react";

import {
  activityMonths,
  listActivity,
  listActivityActors,
} from "@/lib/data/activity";
import { listApps } from "@/lib/data/apps";
import { listFolders } from "@/lib/data/folders";
import { listProjects } from "@/lib/data/projects";
import { EmptyState } from "@/components/shared/empty-state";
import { ActivityFilters } from "@/components/activity/activity-filters";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { toActivityItem } from "@/components/activity/activity-timeline";
import {
  activityHref,
  activityWindow,
  hasActivityFilters,
  parseActivityParams,
} from "@/lib/activity-filter";
import type { FacetOption } from "@/components/env/env-filters";

export const metadata = { title: "Activity" };

/** How many rows a page of the feed holds, first one included. */
const PAGE_SIZE = 40;

export default async function ActivityPage(props: PageProps<"/activity">) {
  const params = parseActivityParams(await props.searchParams);
  const filter = {
    actorUserIds: params.actorUserIds,
    types: params.types,
    resourceIds: params.resourceIds,
    ...activityWindow(params),
  };

  const [activities, months, actors, apps, folders, projects] =
    await Promise.all([
      listActivity(PAGE_SIZE, filter),
      activityMonths(filter),
      listActivityActors(),
      listApps(),
      listFolders(),
      listProjects(),
    ]);

  const filtered = hasActivityFilters(params);
  if (activities.length === 0)
    return (
      <>
        {filtered && (
          <ActivityFilters
            params={params}
            actors={actorOptions(actors)}
            resources={resourceOptions(apps, folders, projects)}
          />
        )}
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
      <ActivityFilters
        params={params}
        actors={actorOptions(actors)}
        resources={resourceOptions(apps, folders, projects)}
      />
      <ActivityFeed
        // A filter change is a fresh first page, not more of the old one.
        key={activityHref(params)}
        initialItems={activities.map(toActivityItem)}
        monthCounts={Object.fromEntries(months.map((m) => [m.month, m.count]))}
        variables={{
          actorUserIds: nonEmpty(params.actorUserIds),
          types: nonEmpty(params.types),
          resourceIds: nonEmpty(params.resourceIds),
          from: filter.from ?? null,
          to: filter.to ?? null,
        }}
        pageSize={PAGE_SIZE}
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

function resourceOptions(
  apps: { id: string; name: string }[],
  folders: { id: string; name: string }[],
  projects: { id: string; name: string }[],
): FacetOption[] {
  return [
    ...apps.map((a) => ({ value: a.id, label: a.name, group: "Apps" })),
    ...folders.map((f) => ({ value: f.id, label: f.name, group: "Folders" })),
    ...projects.map((p) => ({ value: p.id, label: p.name, group: "Projects" })),
  ];
}
