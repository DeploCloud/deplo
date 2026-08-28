import { Activity as ActivityIcon } from "lucide-react";

import {
  activityMonths,
  listActivity,
  listActivityActors,
} from "@/lib/data/activity";
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
import type { FacetOption } from "@/components/env/env-filters";

/**
 * The team's trail narrowed to ONE app or database - the Activity tab in each
 * one's settings. The same feed as /activity with the resource fixed, so the
 * Resource facet is left out and "Clear filters" comes back here.
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

  const [activities, months, actors] = await Promise.all([
    listActivity(ACTIVITY_PAGE_SIZE, filter),
    activityMonths(filter),
    listActivityActors(),
  ]);

  const filters = (
    <ActivityFilters
      params={params}
      actors={actors.map((a): FacetOption => ({
        value: a.value,
        label: a.label,
        author: a.author ?? undefined,
      }))}
      base={base}
    />
  );

  const narrowed = hasActivityFilters(params);
  if (activities.length === 0)
    return (
      <>
        {narrowed && filters}
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

  return (
    <>
      {filters}
      <ActivityFeed
        // A filter change is a fresh first page, not more of the old one.
        key={activityHref(params, base)}
        initialItems={activities.map(toActivityItem)}
        monthCounts={Object.fromEntries(months.map((m) => [m.month, m.count]))}
        appLinks={appLinks ?? {}}
        databaseLinks={databaseLinks ?? {}}
        variables={{
          actorUserIds: params.actorUserIds.length ? params.actorUserIds : null,
          types: params.types.length ? params.types : null,
          resourceIds: [resourceId],
          from: filter.from ?? null,
          to: filter.to ?? null,
        }}
        pageSize={ACTIVITY_PAGE_SIZE}
      />
    </>
  );
}
