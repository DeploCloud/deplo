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

export interface ActivityItem {
  id: string;
  type: ActivityType;
  message: string;
  actor: string;
  actorUser: VarAuthor | null;
  actorProvider: string | null;
  createdAt: string;
  appId: string | null;
  databaseId: string | null;
  cursor: string;
}

export type AppLinks = Record<
  string,
  { name: string; slug: string; logo?: string | null }
>;

export type DatabaseLinks = Record<
  string,
  { name: string; logo: string | null; type: DatabaseType }
>;

export function toAppLinks(
  apps: { id: string; name: string; slug: string; logo: string | null }[],
): AppLinks {
  return Object.fromEntries(
    apps.map((a) => [a.id, { name: a.name, slug: a.slug, logo: a.logo }]),
  );
}

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

export function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  return `${MONTHS[Number(month) - 1] ?? key} ${year}`;
}

export function monthKey(createdAt: string): string {
  return createdAt.slice(0, 7);
}

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
  const rail = size === "lg" ? "ring-4 ring-background" : "";
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
  repeats?: string[];
  size?: "md" | "lg";
  showActor?: boolean;
  showMark?: boolean;
  appLinks?: AppLinks;
  databaseLinks?: DatabaseLinks;
}) {
  const times = repeats ?? [item.createdAt];
  const many = times.length > 1;
  const sentence = messageWithLink(item, appLinks, databaseLinks, showMark);
  const stampAtEnd = size === "lg";
  const headerLine = cn(
    "flex flex-wrap content-center items-baseline gap-x-1.5 text-sm",
    size === "lg" ? "min-h-8" : "min-h-6",
  );
  const header = (
    <>
      {showActor &&
        (item.actorProvider ? (
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

const HEADING_OFFSET = "top-14 sm:top-[7.25rem] lg:top-14";

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
  monthCounts?: Record<string, number>;
  showActor?: boolean;
  showMark?: boolean;
  appLinks?: AppLinks;
  databaseLinks?: DatabaseLinks;
  children?: React.ReactNode;
}) {
  const full = variant === "full";
  const size = full ? "lg" : "md";
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
