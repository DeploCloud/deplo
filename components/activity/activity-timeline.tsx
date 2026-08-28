import * as React from "react";

import { UserAvatar } from "@/components/shared/user-avatar";
import { ACTIVITY_ICON, UNKNOWN_ACTIVITY_ICON } from "@/lib/activity-types";
import { cn, timeAgo } from "@/lib/utils";
import type { Activity, ActivityType, VarAuthor } from "@/lib/types";

/** One row of the trail, trimmed to what the timeline draws. */
export interface ActivityItem {
  id: string;
  type: ActivityType;
  message: string;
  actor: string;
  actorUser: VarAuthor | null;
  createdAt: string;
  /** Keyset position, for paging past this row. */
  cursor: string;
}

export function toActivityItem(a: Activity): ActivityItem {
  return {
    id: a.id,
    type: a.type,
    message: a.message,
    actor: a.actor,
    actorUser: a.actorUser,
    createdAt: a.createdAt,
    cursor: `${a.createdAt}|${a.seq}`,
  };
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `2026-08` -> `August 2026`. Spelled out rather than localised, so the server
 *  and the browser cannot render two different strings. */
export function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  return `${MONTHS[Number(month) - 1] ?? key} ${year}`;
}

/** The UTC month a row belongs to, matching what `activityMonths` counts. */
export function monthKey(createdAt: string): string {
  return createdAt.slice(0, 7);
}

/**
 * The marker on the rail: the person who acted. Non-human actors ("Deplo",
 * "system", a webhook) have no face, so they get the event's own glyph - and so
 * does a feed that is already ONE person's, where their face ten times over says
 * nothing the page has not already said.
 */
function ActivityMarker({
  item,
  size,
  showActor,
}: {
  item: ActivityItem;
  size: "md" | "lg";
  showActor: boolean;
}) {
  const box = size === "lg" ? "size-8" : "size-6";
  if (item.actorUser && showActor)
    return (
      <UserAvatar
        name={item.actorUser.name}
        username={item.actorUser.username}
        avatarColor={item.actorUser.avatarColor}
        avatarUrl={item.actorUser.avatarUrl}
        size={size}
        className="relative z-10 shrink-0 ring-4 ring-background"
      />
    );
  const Icon = ACTIVITY_ICON[item.type] ?? UNKNOWN_ACTIVITY_ICON;
  return (
    <span
      className={cn(
        "relative z-10 flex shrink-0 items-center justify-center rounded-full border border-border bg-secondary ring-4 ring-background",
        box,
      )}
    >
      <Icon className={size === "lg" ? "size-4" : "size-3"} />
    </span>
  );
}

/** Who did it, when, and what happened - in that order. */
export function ActivityRow({
  item,
  size = "lg",
  showActor = true,
}: {
  item: ActivityItem;
  size?: "md" | "lg";
  /** Off on a page that already names the person, like a member's own tab. */
  showActor?: boolean;
}) {
  return (
    <li className="relative flex items-start gap-3">
      <ActivityMarker item={item} size={size} showActor={showActor} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
          {showActor && (
            <span className="font-medium text-foreground">{item.actor}</span>
          )}
          <time
            dateTime={item.createdAt}
            title={new Date(item.createdAt).toUTCString()}
            className="text-xs text-muted-foreground"
            // The server and the browser render this a moment apart.
            suppressHydrationWarning
          >
            {timeAgo(item.createdAt)}
          </time>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{item.message}</p>
      </div>
    </li>
  );
}

/** The month's own heading, riding the rail. */
function MonthHeading({ month, count }: { month: string; count?: number }) {
  return (
    // Under the topbar (h-14) on a phone, under the filter row (+60px) once that
    // row is itself pinned.
    <li className="sticky top-14 z-10 -mx-1 bg-background/95 px-1 py-2 backdrop-blur-sm sm:top-[7.25rem]">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {monthLabel(month)}
        {count != null && (
          <span className="ml-1.5 normal-case">
            · {count} {count === 1 ? "event" : "events"}
          </span>
        )}
      </h2>
    </li>
  );
}

/**
 * The vertical trail: one rail, the actor's face on it, the sentence beside it.
 * `compact` drops the rail and the month headings for the Overview card and a
 * member's own tab.
 */
export function ActivityTimeline({
  items,
  variant = "full",
  monthCounts,
  showActor = true,
  children,
}: {
  items: ActivityItem[];
  variant?: "full" | "compact";
  /** `{ "2026-08": 42 }`, for the month headings. */
  monthCounts?: Record<string, number>;
  showActor?: boolean;
  /** The loader / end-of-list footer, inside the rail. */
  children?: React.ReactNode;
}) {
  const full = variant === "full";
  const size = full ? "lg" : "md";
  // Built flat rather than nested per month: the rail is ONE line down the whole
  // list, so a month cannot own a container of its own.
  const rows: React.ReactNode[] = [];
  let month = "";
  for (const item of items) {
    const key = monthKey(item.createdAt);
    if (full && key !== month)
      rows.push(
        <MonthHeading
          key={`m-${key}`}
          month={key}
          count={monthCounts?.[key]}
        />,
      );
    month = key;
    rows.push(
      <ActivityRow
        key={item.id}
        item={item}
        size={size}
        showActor={showActor}
      />,
    );
  }
  return (
    <ol className={cn("relative", full ? "space-y-6" : "space-y-4")}>
      {full && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-4 w-px -translate-x-1/2 bg-border"
        />
      )}
      {rows}
      {children}
    </ol>
  );
}
