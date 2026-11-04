import { ActivityFilters } from "@/components/activity/activity-filters";
import {
  ActivityTimeline,
  placeholderActivity,
} from "@/components/activity/activity-timeline";
import {
  ActivitySummary,
  type SummaryCount,
} from "@/components/activity/activity-summary";
import {
  activityCountWindowLabel,
  parseActivityParams,
} from "@/lib/activity-filter";

const PARAMS = parseActivityParams({});
const FEED = placeholderActivity([
  "Redeployed it from its latest settings",
  "Backup failed: upload to S3 did not complete",
  "Changed a setting",
  "Restarted it",
  "Deployed a new version",
  "Changed an environment variable",
]);
const count = (label: string, i: number): SummaryCount => ({
  value: `${i}`,
  label,
  count: 12,
});
const EVENTS = ["Backups", "Deploys", "Settings"].map(count);
const PEOPLE = ["System", "Someone"].map(count);

/** ScopedActivity's layout: the feed beside a rail of filters and counts. */
export function ScopedActivitySkeleton({
  pinnedActor = false,
}: {
  pinnedActor?: boolean;
}) {
  const summary = (className: string) => (
    <ActivitySummary
      loading
      className={className}
      label={activityCountWindowLabel(PARAMS)}
      params={PARAMS}
      events={EVENTS}
      people={pinnedActor ? [] : PEOPLE}
    />
  );
  return (
    <div className="grid items-start gap-6 lg:max-w-6xl lg:grid-cols-[minmax(0,42rem)_20rem] lg:justify-between">
      <aside
        inert
        className="h-fit space-y-4 sm:sticky sm:top-14 sm:z-20 lg:top-20 lg:col-start-2 lg:row-start-1"
      >
        <ActivityFilters
          params={PARAMS}
          actors={pinnedActor ? undefined : []}
          layout="rail"
        />
        {summary("hidden lg:block")}
      </aside>
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
        <ActivityTimeline
          loading
          items={FEED}
          monthCounts={{ "2026-01": FEED.length }}
          showActor={!pinnedActor}
        />
      </div>
      {summary("lg:hidden")}
    </div>
  );
}
