"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { gqlAction } from "@/lib/graphql-client";
import {
  ActivityTimeline,
  type ActivityItem,
  type AppLinks,
  type DatabaseLinks,
} from "./activity-timeline";

const PAGE = /* GraphQL */ `
  query ActivityPage(
    $limit: Int
    $cursor: String
    $actorUserIds: [ID!]
    $types: [ActivityType!]
    $from: String
    $to: String
    $resourceIds: [ID!]
  ) {
    activity(
      limit: $limit
      cursor: $cursor
      actorUserIds: $actorUserIds
      types: $types
      from: $from
      to: $to
      resourceIds: $resourceIds
    ) {
      id
      type
      message
      actor
      actorProvider
      createdAt
      appId
      databaseId
      cursor
      actorUser {
        id
        name
        username
        avatarColor
        avatarUrl
      }
    }
  }
`;

/**
 * The trail, extended as it is scrolled. The first page is rendered by the
 * server; every later one is a keyset read past the last row we hold, so a row
 * written while you scroll can never shift the page under you.
 */
export function ActivityFeed({
  initialItems,
  monthCounts,
  appLinks,
  databaseLinks,
  variables,
  pageSize,
}: {
  initialItems: ActivityItem[];
  monthCounts: Record<string, number>;
  appLinks: AppLinks;
  databaseLinks: DatabaseLinks;
  /** The filter arguments, repeated verbatim for every later page. */
  variables: Record<string, unknown>;
  pageSize: number;
}) {
  const [items, setItems] = React.useState(initialItems);
  const [done, setDone] = React.useState(initialItems.length < pageSize);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const sentinel = React.useRef<HTMLDivElement>(null);

  const loadMore = React.useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await gqlAction<{ activity: ActivityItem[] }>(PAGE, {
      ...variables,
      limit: pageSize,
      cursor: items[items.length - 1]?.cursor,
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const page = res.data?.activity ?? [];
    setItems((prev) => [...prev, ...page]);
    if (page.length < pageSize) setDone(true);
  }, [items, pageSize, variables]);

  React.useEffect(() => {
    const node = sentinel.current;
    if (!node || done || loading || error) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: "400px" },
    );
    io.observe(node);
    return () => io.disconnect();
    // `items` is in here on purpose: a sentinel still in view after a batch lands
    // never fires again, so a tall viewport would stall one page in.
  }, [done, loading, error, loadMore, items]);

  return (
    <ActivityTimeline
      items={items}
      monthCounts={monthCounts}
      appLinks={appLinks}
      databaseLinks={databaseLinks}
    >
      {!done && (
        <li className="relative flex items-start gap-3">
          <div
            ref={sentinel}
            aria-hidden
            className="absolute inset-x-0 -top-px h-px"
          />
          {error ? (
            <p className="flex flex-wrap items-center gap-3 pl-11 text-sm text-muted-foreground">
              {error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadMore()}
              >
                Load more
              </Button>
            </p>
          ) : (
            <>
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-64" />
              </div>
            </>
          )}
        </li>
      )}
    </ActivityTimeline>
  );
}
