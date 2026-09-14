import * as React from "react";
import Link from "@/components/ui/link";
import { ChevronRight } from "lucide-react";

import { GitAccount } from "@/components/shared/git-account";
import { UserAvatar } from "@/components/shared/user-avatar";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { ACTIVITY_ICON, UNKNOWN_ACTIVITY_ICON } from "@/lib/activity-types";
import { MONTH_SHORT } from "@/lib/activity-filter";
import { cn, gitProfileUrl, timeAgoShort } from "@/lib/utils";
import type { Activity, ActivityType } from "@/lib/types/activity";
import type { DatabaseType } from "@/lib/types/database";
import type { VarAuthor } from "@/lib/types/identity";

// One row of the trail, trimmed to what the timeline draws.
export interface ActivityItem {
  id: string;
  type: ActivityType;
  message: string;
  actor: string;
  actorUser: VarAuthor | null;
  // The git host `actor` is a login on - a webhook push. Null for a member and for `system`.
  actorProvider: string | null;
  createdAt: string;
  appId: string | null;
  // Never set together with `appId`.
  databaseId: string | null;
  // Keyset position, for paging past this row.
  cursor: string;
}

// The apps a mention may link to, by id: built from what the caller can LIST, so an app they cannot see stays plain text.
export type AppLinks = Record<
  string,
  { name: string; slug: string; logo?: string | null }
>;

// The databases a mention may link to, by id - the twin of AppLinks.
export type DatabaseLinks = Record<
  string,
  { name: string; logo: string | null; type: DatabaseType }
>;

// Only what the caller could list: an app they cannot reach must not become a link into a 404.
export function toAppLinks(
  apps: { id: string; name: string; slug: string; logo: string | null }[],
): AppLinks {
  return Object.fromEntries(
    apps.map((a) => [a.id, { name: a.name, slug: a.slug, logo: a.logo }]),
  );
}

// The database twin of toAppLinks.
export function toDatabaseLinks(
  databases: {
    id: string;
    name: string;
    logo: string | null;
    type: DatabaseType;
  }[],
): DatabaseLinks {
  return Object.fromEntries(
    databases.map((d) => [d.id, { name: d.name, logo: d.logo, type: d.type }]),
  );
}

export function toActivityItem(a: Activity): ActivityItem {
  return {
    id: a.id,
    type: a.type,
    message: a.message,
    actor: a.actor,
    actorUser: a.actorUser,
    actorProvider: a.actorProvider,
    createdAt: a.createdAt,
    appId: a.appId,
    databaseId: a.databaseId,
    cursor: `${a.createdAt}|${a.seq}`,
  };
}

// Where the name starts in the sentence, or -1. Whole word only: `api` must not light up inside `api-gateway`.
export function mentionAt(message: string, name: string): number {
  const edge = (c: string | undefined) => c === undefined || !/[\w-]/.test(c);
  for (let i = message.indexOf(name); i >= 0; i = message.indexOf(name, i + 1))
    if (edge(message[i - 1]) && edge(message[i + name.length])) return i;
  return -1;
}

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

// The sentence is prose written at the call site, so the NAME is the only handle: no match, no link.
function messageWithLink(
  item: ActivityItem,
  appLinks: AppLinks | undefined,
  databaseLinks: DatabaseLinks | undefined,
  showMark: boolean,
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
        {/* Inline-block on the MARK, not the link: a flex link takes its baseline from the picture and lifts the name off the line. */}
        {showMark && (
          <span className="mr-1 inline-block align-text-bottom">
            {target.mark}
          </span>
        )}
        {target.name}
      </Link>
      {item.message.slice(at + target.name.length)}
    </>
  );
}

// `2026-08-26T14:32:11Z` -> `26 Aug, 14:32`, read in UTC off the string: no `Date`, so server and browser cannot
// disagree, and a row can never sit under "August" with a September clock.
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

// `2026-08` -> `August 2026`, spelled out rather than localised: server and browser must not render two strings.
export function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  return `${MONTHS[Number(month) - 1] ?? key} ${year}`;
}

// The UTC month a row belongs to, matching what `activityMonths` counts.
export function monthKey(createdAt: string): string {
  return createdAt.slice(0, 7);
}

// Non-human actors ("Deplo", "system", a webhook) carry no `actorUser`, so they fall through to the event's own glyph.
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
  // The ring masks the rail behind the marker, so it only belongs where there is a rail.
  const rail = size === "lg" ? "ring-4 ring-background" : "";
  // `relative` with NO z-index: it already paints over the rail, and a z of its own would raise it through the sticky month heading.
  if (item.actorUser && showActor)
    return (
      <UserAvatar
        name={item.actorUser.name}
        username={item.actorUser.username}
        avatarUrl={item.actorUser.avatarUrl}
        size={size}
        className={cn("relative shrink-0", rail)}
      />
    );
  const Icon = ACTIVITY_ICON[item.type] ?? UNKNOWN_ACTIVITY_ICON;
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full border border-border bg-secondary",
        rail,
        box,
      )}
    >
      <Icon className={size === "lg" ? "size-4" : "size-3"} />
    </span>
  );
}

// Who did it, when, and what happened - in that order.
export function ActivityRow({
  item,
  repeats,
  size = "lg",
  showActor = true,
  showMark = true,
  appLinks,
  databaseLinks,
}: {
  item: ActivityItem;
  // Every `createdAt` in the run this row stands for, newest first.
  repeats?: string[];
  size?: "md" | "lg";
  // Off on a page that already names the person, like a member's own tab.
  showActor?: boolean;
  // The resource's own picture beside its name. Off where the row is already small, like the Overview card.
  showMark?: boolean;
  appLinks?: AppLinks;
  databaseLinks?: DatabaseLinks;
}) {
  const times = repeats ?? [item.createdAt];
  const many = times.length > 1;
  const sentence = messageWithLink(item, appLinks, databaseLinks, showMark);
  // Only where there is a page's width for it: in a card the sentence wraps and a right-pinned stamp lands mid-sentence.
  const stampAtEnd = size === "lg";
  // Unfolding a row must move nothing, so the first line keeps the marker's height and rides its centre, folded or not.
  const headerLine = cn(
    "flex flex-wrap content-center items-baseline gap-x-1.5 text-sm",
    size === "lg" ? "min-h-8" : "min-h-6",
  );
  const header = (
    <>
      {showActor &&
        (item.actorProvider ? (
          // A push's actor is a git-host login, not a member here, so it gets the host's mark.
          <GitAccount
            login={item.actor}
            provider={item.actorProvider}
            url={gitProfileUrl(item.actorProvider, item.actor)}
            size="xs"
            className="font-medium text-foreground"
          />
        ) : (
          <span className="font-medium text-foreground">{item.actor}</span>
        ))}
      <time
        dateTime={item.createdAt}
        title={new Date(item.createdAt).toUTCString()}
        className="text-xs text-muted-foreground"
        // The server and the browser render this a moment apart.
        suppressHydrationWarning
      >
        {timeAgoShort(item.createdAt)}
      </time>
      {(many || !stampAtEnd) && (
        <span className="text-xs text-muted-foreground">
          · {many ? `${times.length} times` : stamp(item.createdAt)}
        </span>
      )}
    </>
  );
  return (
    <li className="relative flex items-start gap-3">
      <ActivityMarker item={item} size={size} showActor={showActor} />
      <div className="min-w-0 flex-1">
        {many ? (
          // `details` rather than React state: folding needs no JavaScript, which keeps this row renderable from an RSC.
          <details open className="group">
            <summary
              className={cn(
                headerLine,
                "cursor-pointer list-none [&::-webkit-details-marker]:hidden",
              )}
            >
              {header}
              <ChevronRight className="size-3.5 self-center text-muted-foreground transition-transform group-open:rotate-90" />
            </summary>
            {/* Once per occurrence: a folded run must not cost the trail a single "what" or "when". */}
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
          </details>
        ) : (
          <>
            <p className={headerLine}>{header}</p>
            {stampAtEnd ? (
              <p className="mt-1 flex items-baseline justify-between gap-3 text-sm text-muted-foreground">
                <span className="min-w-0">{sentence}</span>
                <span className="shrink-0 text-xs">
                  {stamp(item.createdAt)}
                </span>
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{sentence}</p>
            )}
          </>
        )}
      </div>
    </li>
  );
}

// Fold consecutive identical events by one person into one row - never across a month heading.
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

function MonthHeading({
  month,
  count,
  offset,
}: {
  month: string;
  count?: number;
  offset: string;
}) {
  return (
    <li
      className={cn(
        "sticky z-10 -mx-1 bg-background/95 px-1 py-2 backdrop-blur-sm",
        offset,
      )}
    >
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

// Under the topbar (h-14) plus the 60px filter row; from `lg` the filters move into the rail, so it rides the topbar again.
const HEADING_OFFSET = "top-14 sm:top-[7.25rem] lg:top-14";

// The vertical trail. `compact` drops the rail and the month headings for the Overview card and a member's own tab.
export function ActivityTimeline({
  items,
  variant = "full",
  monthCounts,
  showActor = true,
  showMark = true,
  appLinks,
  databaseLinks,
  children,
}: {
  items: ActivityItem[];
  variant?: "full" | "compact";
  // `{ "2026-08": 42 }`, for the month headings.
  monthCounts?: Record<string, number>;
  showActor?: boolean;
  showMark?: boolean;
  appLinks?: AppLinks;
  databaseLinks?: DatabaseLinks;
  // The loader / end-of-list footer, inside the rail.
  children?: React.ReactNode;
}) {
  const full = variant === "full";
  const size = full ? "lg" : "md";
  // Built flat rather than nested per month: the rail is ONE line down the whole list, so a month owns no container.
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
          offset={HEADING_OFFSET}
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
        showMark={showMark}
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
