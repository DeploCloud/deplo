import * as React from "react";
import Link from "next/link";

import { UserAvatar } from "@/components/shared/user-avatar";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { ACTIVITY_ICON, UNKNOWN_ACTIVITY_ICON } from "@/lib/activity-types";
import { cn, timeAgo } from "@/lib/utils";
import type {
  Activity,
  ActivityType,
  DatabaseType,
  VarAuthor,
} from "@/lib/types";

/** One row of the trail, trimmed to what the timeline draws. */
export interface ActivityItem {
  id: string;
  type: ActivityType;
  message: string;
  actor: string;
  actorUser: VarAuthor | null;
  createdAt: string;
  /** The app this happened to, when it happened to one. */
  appId: string | null;
  /** The database this happened to. Never set together with `appId`. */
  databaseId: string | null;
  /** Keyset position, for paging past this row. */
  cursor: string;
}

/**
 * The apps a mention may link to, by id. Built from what the caller can LIST, so
 * an app they cannot see is named in the sentence and stays plain text.
 */
export type AppLinks = Record<
  string,
  { name: string; slug: string; logo?: string | null }
>;

/** The databases a mention may link to, by id - the twin of {@link AppLinks}. */
export type DatabaseLinks = Record<
  string,
  { name: string; logo: string | null; type: DatabaseType }
>;

export function toActivityItem(a: Activity): ActivityItem {
  return {
    id: a.id,
    type: a.type,
    message: a.message,
    actor: a.actor,
    actorUser: a.actorUser,
    createdAt: a.createdAt,
    appId: a.appId,
    databaseId: a.databaseId,
    cursor: `${a.createdAt}|${a.seq}`,
  };
}

/** Where the app's name starts in the sentence, or -1. Whole word only: an app
 *  called `api` must not light up the middle of `api-gateway`. */
export function mentionAt(message: string, name: string): number {
  const edge = (c: string | undefined) => c === undefined || !/[\w-]/.test(c);
  for (let i = message.indexOf(name); i >= 0; i = message.indexOf(name, i + 1))
    if (edge(message[i - 1]) && edge(message[i + name.length])) return i;
  return -1;
}

/** The resource a row happened to, resolved for display, or undefined. */
function mentioned(
  item: ActivityItem,
  appLinks: AppLinks | undefined,
  databaseLinks: DatabaseLinks | undefined,
): { name: string; href: string; mark: React.ReactNode } | undefined {
  const app = item.appId ? appLinks?.[item.appId] : undefined;
  if (app)
    return {
      name: app.name,
      href: `/apps/${app.slug}`,
      mark: <AppLogo logo={app.logo ?? null} size={16} />,
    };
  const db = item.databaseId ? databaseLinks?.[item.databaseId] : undefined;
  if (db)
    return {
      name: db.name,
      href: `/storage/databases/${item.databaseId}`,
      mark: <DatabaseLogo type={db.type} logo={db.logo} size={16} />,
    };
  return undefined;
}

/**
 * The message, with the app or database it names turned into a link carrying that
 * resource's own picture. The sentence is prose written at the call site, so the
 * NAME is the only handle there is - no match, no link, and the row reads as it
 * always did.
 */
function messageWithLink(
  item: ActivityItem,
  appLinks: AppLinks | undefined,
  databaseLinks: DatabaseLinks | undefined,
): React.ReactNode {
  const target = mentioned(item, appLinks, databaseLinks);
  if (!target) return item.message;
  const at = mentionAt(item.message, target.name);
  if (at < 0) return item.message;
  return (
    <>
      {item.message.slice(0, at)}
      <Link
        href={target.href}
        className="font-medium text-foreground underline-offset-2 hover:underline"
      >
        {/* Inline-block on the MARK, not on the link: a flex link takes its
            baseline from the picture and lifts the name off the line. */}
        <span className="mr-1 inline-block align-text-bottom">
          {target.mark}
        </span>
        {target.name}
      </Link>
      {item.message.slice(at + target.name.length)}
    </>
  );
}

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * `2026-08-26T14:32:11Z` -> `26 Aug, 14:32`. Read straight off the ISO string in
 * UTC, like the month headings bucket, so a row can never sit under "August"
 * while its own clock reads September. No `Date`, so the server and the browser
 * cannot disagree; the year is the heading's job.
 */
export function stamp(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return "";
  const [, , month, day, hh, mi] = m;
  return `${Number(day)} ${MONTH_SHORT[Number(month) - 1]}, ${hh}:${mi}`;
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
  // `relative` with NO z-index on purpose: it already paints over the rail (a
  // positioned sibling earlier in the list), and any z of its own would raise it
  // through the sticky month heading on the way past.
  if (item.actorUser && showActor)
    return (
      <UserAvatar
        name={item.actorUser.name}
        username={item.actorUser.username}
        avatarColor={item.actorUser.avatarColor}
        avatarUrl={item.actorUser.avatarUrl}
        size={size}
        className="relative shrink-0 ring-4 ring-background"
      />
    );
  const Icon = ACTIVITY_ICON[item.type] ?? UNKNOWN_ACTIVITY_ICON;
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full border border-border bg-secondary ring-4 ring-background",
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
  repeats,
  size = "lg",
  showActor = true,
  appLinks,
  databaseLinks,
}: {
  item: ActivityItem;
  /** Every `createdAt` in the run this row stands for, newest first. */
  repeats?: string[];
  size?: "md" | "lg";
  /** Off on a page that already names the person, like a member's own tab. */
  showActor?: boolean;
  appLinks?: AppLinks;
  databaseLinks?: DatabaseLinks;
}) {
  const times = repeats ?? [item.createdAt];
  const many = times.length > 1;
  const sentence = messageWithLink(item, appLinks, databaseLinks);
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
          <span className="text-xs text-muted-foreground">
            · {many ? `${times.length} times` : stamp(item.createdAt)}
          </span>
        </p>
        {many ? (
          // The sentence once per occurrence with its own clock beside it: a
          // folded run must not cost the trail a single "what" or "when".
          <ul className="mt-1 space-y-1">
            {times.map((t, i) => (
              <li
                key={`${t}-${i}`}
                className="flex items-baseline justify-between gap-3 text-sm text-muted-foreground"
              >
                <span className="min-w-0">{sentence}</span>
                <span className="shrink-0 text-xs">{stamp(t)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">{sentence}</p>
        )}
      </div>
    </li>
  );
}

/**
 * Fold a run of identical events by the same person into one row. Seven
 * "Deploying docs" from one account is one thing that happened seven times, not
 * seven things, and read as seven rows it buries everything else. Consecutive
 * only, and never across a month heading.
 */
export function foldRuns(
  items: ActivityItem[],
): { item: ActivityItem; times: string[] }[] {
  const runs: { item: ActivityItem; times: string[] }[] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (
      last !== undefined &&
      last.item.actor === item.actor &&
      last.item.message === item.message &&
      last.item.appId === item.appId &&
      last.item.databaseId === item.databaseId &&
      monthKey(last.item.createdAt) === monthKey(item.createdAt)
    )
      last.times.push(item.createdAt);
    else runs.push({ item, times: [item.createdAt] });
  }
  return runs;
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
  appLinks,
  databaseLinks,
  children,
}: {
  items: ActivityItem[];
  variant?: "full" | "compact";
  /** `{ "2026-08": 42 }`, for the month headings. */
  monthCounts?: Record<string, number>;
  showActor?: boolean;
  appLinks?: AppLinks;
  databaseLinks?: DatabaseLinks;
  /** The loader / end-of-list footer, inside the rail. */
  children?: React.ReactNode;
}) {
  const full = variant === "full";
  const size = full ? "lg" : "md";
  // Built flat rather than nested per month: the rail is ONE line down the whole
  // list, so a month cannot own a container of its own.
  const rows: React.ReactNode[] = [];
  let month = "";
  for (const run of foldRuns(items)) {
    const key = monthKey(run.item.createdAt);
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
        key={run.item.id}
        item={run.item}
        repeats={run.times}
        size={size}
        showActor={showActor}
        appLinks={appLinks}
        databaseLinks={databaseLinks}
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
