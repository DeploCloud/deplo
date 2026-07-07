import {
  Rocket,
  Box,
  Boxes,
  Database,
  Globe,
  KeyRound,
  Users,
  Archive,
  HardDrive,
  Activity as ActivityIcon,
  type LucideIcon,
} from "lucide-react";
import { listActivity } from "@/lib/data/activity";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { timeAgo } from "@/lib/utils";
import type { Activity, ActivityType } from "@/lib/types";

export const metadata = { title: "Activity" };

const ICON_BY_TYPE: Record<ActivityType, LucideIcon> = {
  deployment: Rocket,
  service: Box,
  project: Boxes,
  database: Database,
  domain: Globe,
  env: KeyRound,
  member: Users,
  backup: Archive,
  s3: HardDrive,
};

function iconFor(type: ActivityType): LucideIcon {
  return ICON_BY_TYPE[type] ?? ActivityIcon;
}

/** Start-of-day timestamp in local time, robust against invalid dates. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown date";

  const dayMs = 86_400_000;
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / dayMs);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year:
      date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

type DayGroup = { label: string; items: Activity[] };

function groupByDay(activities: Activity[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;

  for (const activity of activities) {
    const label = dayLabel(activity.createdAt, now);
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(activity);
  }

  return groups;
}

export default async function ActivityPage() {
  const activities = await listActivity(100);
  const now = new Date();
  const groups = groupByDay(activities, now);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description="A log of everything happening across your workspace."
      />

      {activities.length === 0 ? (
        <EmptyState
          icon={ActivityIcon}
          title="No activity yet"
          description="As you deploy services, manage databases and invite members, everything will show up here."
        />
      ) : (
        <Card>
          <CardContent className="p-6">
            <div className="space-y-8">
              {groups.map((group) => (
                <section key={group.label} className="space-y-4">
                  <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </h2>

                  <ol className="relative space-y-5 pl-2">
                    {/* Vertical timeline connector */}
                    <span
                      aria-hidden
                      className="absolute left-[18px] top-2 bottom-2 w-px bg-border"
                    />

                    {group.items.map((activity) => {
                      const Icon = iconFor(activity.type);
                      return (
                        <li
                          key={activity.id}
                          className="relative flex items-start gap-4"
                        >
                          <div className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
                            <Icon className="size-4 text-muted-foreground" />
                          </div>
                          <div className="min-w-0 flex-1 pt-1">
                            <p className="text-sm text-foreground">
                              {activity.message}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {activity.actor} · {timeAgo(activity.createdAt)}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
