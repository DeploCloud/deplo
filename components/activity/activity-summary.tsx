"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, Cog } from "lucide-react";

import { UserAvatar } from "@/components/shared/user-avatar";
import { ACTIVITY_ICON, UNKNOWN_ACTIVITY_ICON } from "@/lib/activity-types";
import { activityHref, type ActivityParams } from "@/lib/activity-filter";
import { cn } from "@/lib/utils";
import type { ActivityType, VarAuthor } from "@/lib/types";

/** One line of a block: something to narrow by, and how often it happened. */
export interface SummaryCount {
  value: string;
  label: string;
  count: number;
  /** People only. Null for the system bucket, which has no face. */
  author?: VarAuthor | null;
}

/** How many lines a block shows before "Show N more". */
const SHOWN = 5;

function toggled(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((v) => v !== value)
    : [...values, value];
}

/**
 * How the window breaks down, by kind of event and by person. Every line is a
 * filter: the counts and the feed answer the same question from two ends.
 */
export function ActivitySummary({
  label,
  params,
  base = "/activity",
  events,
  people,
  className,
}: {
  /** The window the counts describe, stated because it need not match the feed. */
  label: string;
  params: ActivityParams;
  base?: string;
  events: SummaryCount[];
  people: SummaryCount[];
  className?: string;
}) {
  const empty = events.length === 0 && people.length === 0;
  return (
    <div className={cn("space-y-3", className)}>
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h2>
      {empty ? (
        <p className="text-sm text-muted-foreground">
          Nothing happened in this window.
        </p>
      ) : (
        <>
          <Block
            title="Events"
            rows={events}
            picked={params.types}
            href={(value) =>
              activityHref(
                {
                  ...params,
                  types: toggled(params.types, value) as ActivityType[],
                },
                base,
              )
            }
            mark={(row) => {
              const Icon =
                ACTIVITY_ICON[row.value as ActivityType] ??
                UNKNOWN_ACTIVITY_ICON;
              return <Icon className="size-4 shrink-0 text-muted-foreground" />;
            }}
          />
          <Block
            title="People"
            rows={people}
            picked={params.actorUserIds}
            href={(value) =>
              activityHref(
                {
                  ...params,
                  actorUserIds: toggled(params.actorUserIds, value),
                },
                base,
              )
            }
            mark={(row) =>
              row.author ? (
                <UserAvatar
                  name={row.author.name}
                  username={row.author.username}
                  avatarUrl={row.author.avatarUrl}
                  size="sm"
                  className="shrink-0"
                />
              ) : (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
                  <Cog className="size-3 text-muted-foreground" />
                </span>
              )
            }
          />
        </>
      )}
    </div>
  );
}

function Block({
  title,
  rows,
  picked,
  href,
  mark,
}: {
  title: string;
  rows: SummaryCount[];
  picked: string[];
  href: (value: string) => string;
  mark: (row: SummaryCount) => React.ReactNode;
}) {
  const [all, setAll] = React.useState(false);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, SHOWN);
  const hidden = rows.length - shown.length;
  return (
    <div>
      <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      <ul>
        {shown.map((row) => {
          const on = picked.includes(row.value);
          return (
            <li key={row.value}>
              <Link
                href={href(row.value)}
                replace
                // Ten variants of this page, none of them likely to be opened.
                prefetch={false}
                aria-current={on ? "true" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent",
                  on && "bg-accent font-medium text-foreground",
                )}
              >
                {mark(row)}
                <span className="truncate">{row.label}</span>
                <span className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums">
                  {row.count}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {(hidden > 0 || all) && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
        >
          {all ? (
            <ChevronUp className="size-4 shrink-0" />
          ) : (
            <ChevronDown className="size-4 shrink-0" />
          )}
          {all ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}
