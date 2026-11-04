"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { ChevronDown, ChevronUp, Cog } from "lucide-react";

import { UserAvatar } from "@/components/shared/user-avatar";
import { ACTIVITY_ICON, UNKNOWN_ACTIVITY_ICON } from "@/lib/activity-types";
import { activityHref, type ActivityParams } from "@/lib/activity-filter";
import { Bone } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ActivityType } from "@/lib/types/activity";
import type { VarAuthor } from "@/lib/types/identity";

export interface SummaryCount {
  value: string;
  label: string;
  count: number;
  author?: VarAuthor | null;
}

const SHOWN = 5;

function toggled(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((v) => v !== value)
    : [...values, value];
}

export function ActivitySummary({
  label,
  params,
  base = "/activity",
  events,
  people,
  className,
  loading = false,
}: {
  label: string;
  params: ActivityParams;
  base?: string;
  events: SummaryCount[];
  people: SummaryCount[];
  className?: string;
  loading?: boolean;
}) {
  const empty = events.length === 0 && people.length === 0;
  return (
    <div className={cn("space-y-3", className)} inert={loading || undefined}>
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
            loading={loading}
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
            loading={loading}
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
  loading,
}: {
  title: string;
  rows: SummaryCount[];
  picked: string[];
  href: (value: string) => string;
  mark: (row: SummaryCount) => React.ReactNode;
  loading: boolean;
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
                prefetch={false}
                aria-current={on ? "true" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-sm font-medium hover:bg-accent max-md:min-h-11",
                  on && "bg-accent text-foreground",
                )}
              >
                <Bone box loading={loading} className="shrink-0">
                  {mark(row)}
                </Bone>
                <span className="truncate">
                  <Bone loading={loading}>{row.label}</Bone>
                </span>
                <span className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums">
                  <Bone loading={loading}>{row.count}</Bone>
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
          <Bone loading={loading}>
            {all ? "Show less" : `Show ${hidden} more`}
          </Bone>
        </button>
      )}
    </div>
  );
}
