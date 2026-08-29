import { Activity as ActivityIcon } from "lucide-react";

import {
  activityCountsByActor,
  activityCountsByType,
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
  ActivitySummary,
  type SummaryCount,
} from "@/components/activity/activity-summary";
import {
  toActivityItem,
  type AppLinks,
  type DatabaseLinks,
} from "@/components/activity/activity-timeline";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import {
  ACTIVITY_PAGE_SIZE,
  activityCountWindow,
  activityCountWindowLabel,
  activityHref,
  activityWindow,
  hasActivityFilters,
  parseActivityParams,
} from "@/lib/activity-filter";
import { reachesWholeTeam } from "@/lib/membership";
import type { FacetOption } from "@/components/env/env-filters";

export const metadata = { title: "Activity" };

/** The feed's own filter row is gone at `lg`, so a month pins under the topbar. */
const HEADING_OFFSET = "top-14 sm:top-[7.25rem] lg:top-14";

export default async function ActivityPage(props: PageProps<"/activity">) {
  const params = parseActivityParams(await props.searchParams);
  const filter = {
    actorUserIds: params.actorUserIds,
    types: params.types,
    resourceIds: params.resourceIds,
    ...activityWindow(params),
  };
  // The counts get a window of their own, and each call below blanks its OWN
  // dimension: picking a person narrows the events beside them without
  // collapsing the people to a list of one.
  const counted = { ...filter, ...activityCountWindow(params) };

  // A database belongs to the team and to no project, so `listDatabases` refuses a
  // role that only reaches part of it - and such a role reaches no database row in
  // the feed either, so there is nothing to name.
  const [
    activities,
    months,
    actors,
    apps,
    folders,
    projects,
    teamWide,
    typeCounts,
    actorCounts,
  ] = await Promise.all([
    listActivity(ACTIVITY_PAGE_SIZE, filter),
    activityMonths(filter),
    listActivityActors(),
    listApps(),
    listFolders(),
    listProjects(),
    reachesWholeTeam(),
    activityCountsByType({ ...counted, types: [] }),
    activityCountsByActor({ ...counted, actorUserIds: [] }),
  ]);
  const databases = teamWide ? await listDatabases() : [];

  const byType = Object.fromEntries(typeCounts.map((c) => [c.type, c.count]));
  const byActor = Object.fromEntries(
    actorCounts.map((c) => [c.actorUserId, c.count]),
  );
  const actorById = new Map(actors.map((a) => [a.value, a]));

  const filtered = hasActivityFilters(params);
  const filters = (layout: "bar" | "rail") => (
    <ActivityFilters
      params={params}
      actors={actorOptions(actors)}
      apps={apps}
      folders={folders}
      projects={projects}
      databases={databases}
      // Zeroes spelled out rather than left absent: an option with no number
      // reads as a bug, one showing 0 reads as "nothing lately".
      actorCounts={zeroed(
        actors.map((a) => a.value),
        byActor,
      )}
      typeCounts={zeroed(
        ACTIVITY_TYPES.map((t) => t.value),
        byType,
      )}
      layout={layout}
    />
  );

  if (activities.length === 0)
    return (
      <>
        {filtered && filters("bar")}
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

  const events: SummaryCount[] = typeCounts.map((c) => ({
    value: c.type,
    label: ACTIVITY_TYPES.find((t) => t.value === c.type)?.label ?? c.type,
    count: c.count,
  }));
  const people: SummaryCount[] = actorCounts.map((c) => ({
    value: c.actorUserId,
    label: actorById.get(c.actorUserId)?.label ?? c.actorUserId,
    count: c.count,
    author: actorById.get(c.actorUserId)?.author,
  }));
  // Static markup, so the phone gets its own copy after the feed rather than the
  // rail moving; the filters, which carry state, stay mounted once.
  const summary = (className: string) => (
    <ActivitySummary
      className={className}
      label={activityCountWindowLabel(params)}
      params={params}
      events={events}
      people={people}
    />
  );

  return (
    <div className="grid items-start gap-6 lg:max-w-6xl lg:grid-cols-[minmax(0,42rem)_20rem] lg:justify-between">
      <aside className="h-fit space-y-4 sm:sticky sm:top-14 sm:z-20 lg:top-20 lg:col-start-2 lg:row-start-1">
        {filters("rail")}
        {summary("hidden lg:block")}
      </aside>
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
        <ActivityFeed
          // A filter change is a fresh first page, not more of the old one.
          key={activityHref(params)}
          initialItems={activities.map(toActivityItem)}
          monthCounts={Object.fromEntries(
            months.map((m) => [m.month, m.count]),
          )}
          appLinks={appLinks(apps)}
          databaseLinks={databaseLinks(databases)}
          headingOffset={HEADING_OFFSET}
          variables={{
            actorUserIds: nonEmpty(params.actorUserIds),
            types: nonEmpty(params.types),
            resourceIds: nonEmpty(params.resourceIds),
            from: filter.from ?? null,
            to: filter.to ?? null,
          }}
          pageSize={ACTIVITY_PAGE_SIZE}
        />
      </div>
      {summary("lg:hidden")}
    </div>
  );
}

function nonEmpty(values: string[]): string[] | null {
  return values.length ? values : null;
}

/** Every option's count, absent ones spelled out as 0. */
function zeroed(
  values: string[],
  counts: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(values.map((v) => [v, counts[v] ?? 0]));
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
