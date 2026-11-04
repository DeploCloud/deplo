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

const MESSAGES = [
  "Redeployed the app from its latest commit",
  "Added a domain",
  "Backup of database failed: upload to S3 did not complete",
  "Changed an environment variable",
  "Deployed a new version",
  "Restarted the app",
];
// Round robin, so no two neighbours fold into one run.
const FEED = placeholderActivity(
  Array.from({ length: 24 }, (_, i) => MESSAGES[i % MESSAGES.length]!),
);

const PARAMS = parseActivityParams({});
const row = (value: string, label: string): SummaryCount => ({
  value,
  label,
  count: 12,
});
const EVENTS = [
  "Backups",
  "Apps",
  "Deploys",
  "Domains",
  "Members",
  "Tokens",
].map((label, i) => row(`e${i}`, label));
const PEOPLE = ["System", "Someone", "Another"].map((label, i) =>
  row(`p${i}`, label),
);
const RESOURCES = [{ id: "app", name: "app", logo: null }];

function Summary({ className }: { className: string }) {
  return (
    <ActivitySummary
      loading
      className={className}
      label={activityCountWindowLabel(PARAMS)}
      params={PARAMS}
      events={EVENTS}
      people={PEOPLE}
    />
  );
}

/** The Activity page: the feed beside a rail of filters and counts. */
export function ActivitySkeleton() {
  return (
    <div
      aria-busy
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12"
    >
      <aside
        inert
        className="h-fit space-y-4 sm:sticky sm:top-14 sm:z-20 lg:top-20 lg:col-start-2 lg:row-start-1"
      >
        <ActivityFilters
          params={PARAMS}
          actors={[]}
          apps={RESOURCES}
          layout="rail"
        />
        <Summary className="hidden lg:block" />
      </aside>
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
        <ActivityTimeline
          loading
          items={FEED}
          monthCounts={{ "2026-01": FEED.length }}
        />
      </div>
      <Summary className="lg:hidden" />
    </div>
  );
}
