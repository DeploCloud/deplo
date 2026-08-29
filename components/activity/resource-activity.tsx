import { Activity as ActivityIcon } from "lucide-react";

import {
  activityCountsByActor,
  activityCountsByType,
  activityMonths,
  listActivity,
  listActivityActors,
} from "@/lib/data/activity";
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
import type { FacetOption } from "@/components/env/env-filters";

/**
 * The team's trail narrowed to ONE app or database. The same feed, rail and
 * counts as /activity with the resource fixed, so the Resource facet is left out
 * and every link comes back here.
 */
export async function ResourceActivity({
  resourceId,
  base,
  searchParams,
  appLinks,
  databaseLinks,
}: {
  resourceId: string;
  /** This tab's own address - where a filter change and "Clear filters" land. */
  base: string;
  searchParams: Record<string, string | string[] | undefined>;
  appLinks?: AppLinks;
  databaseLinks?: DatabaseLinks;
}) {
  const params = parseActivityParams(searchParams);
  const filter = {
    actorUserIds: params.actorUserIds,
    types: params.types,
    resourceIds: [resourceId],
    ...activityWindow(params),
  };
  // Each count call blanks its OWN dimension, so picking a person narrows the
  // events beside them without collapsing the people to a list of one.
  const counted = { ...filter, ...activityCountWindow(params) };

  const [activities, months, actors, typeCounts, actorCounts] =
    await Promise.all([
      listActivity(ACTIVITY_PAGE_SIZE, filter),
      activityMonths(filter),
      listActivityActors(),
      activityCountsByType({ ...counted, types: [] }),
      activityCountsByActor({ ...counted, actorUserIds: [] }),
    ]);

  const byType = Object.fromEntries(typeCounts.map((c) => [c.type, c.count]));
  const byActor = Object.fromEntries(
    actorCounts.map((c) => [c.actorUserId, c.count]),
  );
  const actorById = new Map(actors.map((a) => [a.value, a]));

  const filters = (layout: "bar" | "rail") => (
    <ActivityFilters
      params={params}
      actors={actors.map((a): FacetOption => ({
        value: a.value,
        label: a.label,
        author: a.author ?? undefined,
      }))}
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
      base={base}
    />
  );

  const narrowed = hasActivityFilters(params);
  if (activities.length === 0)
    return (
      <>
        {narrowed && filters("bar")}
        <EmptyState
          icon={ActivityIcon}
          docs="team.activity"
          title={narrowed ? "No matching activity" : "No activity yet"}
          description={
            narrowed
              ? "No one did any of that in this window. Widen the filters to see more."
              : "Every change made here shows up in this list."
          }
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
      base={base}
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
          key={activityHref(params, base)}
          initialItems={activities.map(toActivityItem)}
          monthCounts={Object.fromEntries(
            months.map((m) => [m.month, m.count]),
          )}
          appLinks={appLinks ?? {}}
          databaseLinks={databaseLinks ?? {}}
          variables={{
            actorUserIds: params.actorUserIds.length
              ? params.actorUserIds
              : null,
            types: params.types.length ? params.types : null,
            resourceIds: [resourceId],
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

/** Every option's count, absent ones spelled out as 0. */
function zeroed(
  values: string[],
  counts: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(values.map((v) => [v, counts[v] ?? 0]));
}
