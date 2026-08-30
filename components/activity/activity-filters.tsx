"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";
import { Boxes, UserRound, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  FacetCombobox,
  type EnvFacet,
  type FacetOption,
} from "@/components/env/env-filters";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import {
  activityHref,
  hasActivityFilters,
  type ActivityParams,
} from "@/lib/activity-filter";
import { cn } from "@/lib/utils";
import type { ActivityType, DatabaseType } from "@/lib/types";
import { DateRangeFilter } from "./date-range-filter";

/** A filter's options never depend on the rows on screen - the query does the
 *  narrowing - so nothing here matches client-side. */
const MATCH_ALL = () => true;

function facet(
  id: string,
  label: string,
  allLabel: string,
  icon: EnvFacet<never>["icon"],
  options: FacetOption[],
): EnvFacet<never> {
  return {
    id,
    label,
    allLabel,
    icon,
    options,
    match: MATCH_ALL,
    persistent: true,
    searchable: true,
  };
}

const EVENT_OPTIONS: FacetOption[] = ACTIVITY_TYPES.map((t) => ({
  value: t.value,
  label: t.label,
  hint: t.hint,
  group: t.group,
}));

/** One named thing the trail can be narrowed to. */
export interface ResourceOption {
  id: string;
  name: string;
  /** Apps only: the same logo the Overview grid shows. */
  logo?: string | null;
}

/** A database in the Resource facet - its engine decides the brand mark. */
export interface DatabaseResourceOption {
  id: string;
  name: string;
  logo: string | null;
  type: DatabaseType;
}

/**
 * The Activity page's filter row. Every pick is a navigation, so the URL is the
 * whole state: a link to "what did Ada do last week" is just this page's address.
 * On one app's or one database's own tab the resource is fixed, so that facet is
 * left out and `base` points back at the tab instead of the team-wide page.
 */
export function ActivityFilters({
  params,
  actors,
  apps,
  folders,
  projects,
  databases,
  actorCounts,
  typeCounts,
  layout = "bar",
  base = "/activity",
}: {
  params: ActivityParams;
  actors: FacetOption[];
  /** Omitted on a resource's own tab, where the Resource facet is left out. */
  apps?: ResourceOption[];
  folders?: ResourceOption[];
  projects?: ResourceOption[];
  databases?: DatabaseResourceOption[];
  /** How many events each option covers in the window the rail counts over. */
  actorCounts?: Record<string, number>;
  typeCounts?: Record<string, number>;
  /** `rail` turns the row into the Activity page's right-hand column at `lg`. */
  layout?: "bar" | "rail";
  base?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  // Built here rather than on the server: an option's picture is a component,
  // and the page has no business shipping JSX across for it.
  const resources: FacetOption[] = React.useMemo(
    () => [
      ...(apps ?? []).map((a) => ({
        value: a.id,
        label: a.name,
        group: "Apps",
        leading: <AppLogo logo={a.logo ?? null} size={16} />,
      })),
      ...(folders ?? []).map((f) => ({
        value: f.id,
        label: f.name,
        group: "Folders",
      })),
      ...(projects ?? []).map((p) => ({
        value: p.id,
        label: p.name,
        group: "Projects",
      })),
      ...(databases ?? []).map((d) => ({
        value: d.id,
        label: d.name,
        group: "Databases",
        leading: <DatabaseLogo type={d.type} logo={d.logo} size={16} />,
      })),
    ],
    [apps, folders, projects, databases],
  );

  function go(next: Partial<ActivityParams>) {
    startTransition(() =>
      router.replace(activityHref({ ...params, ...next }, base)),
    );
  }

  const on = hasActivityFilters(params);

  return (
    <div
      className={cn(
        "z-20 flex flex-col gap-2 bg-background py-3 sm:flex-row sm:items-center",
        // Sticky only once the row fits on ONE line: stacked on a phone it is
        // half the screen, and pinning that leaves nothing to read. In the rail
        // the pinned element is the COLUMN, which is as tall as this row - a
        // sticky child of it would have nowhere to travel.
        layout === "bar" && "sm:sticky sm:top-14",
        // Stretch is what squares the date button and Clear up with the
        // comboboxes above them.
        layout === "rail" && "lg:flex-col lg:items-stretch lg:py-0",
        pending && "opacity-60",
      )}
    >
      <div className="flex min-w-0 flex-1">
        <FacetCombobox
          facet={facet("actor", "User", "Anyone", UserRound, actors)}
          counts={actorCounts}
          values={params.actorUserIds}
          onChange={(actorUserIds) => go({ actorUserIds })}
        />
      </div>
      <DateRangeFilter params={params} onChange={go} />
      <div className="flex min-w-0 flex-1">
        <FacetCombobox
          facet={facet("event", "Event", "Any event", Zap, EVENT_OPTIONS)}
          counts={typeCounts}
          values={params.types}
          onChange={(types) => go({ types: types as ActivityType[] })}
        />
      </div>
      {resources.length > 0 && (
        <div className="flex min-w-0 flex-1">
          <FacetCombobox
            facet={facet("resource", "Resource", "Anything", Boxes, resources)}
            values={params.resourceIds}
            onChange={(resourceIds) => go({ resourceIds })}
          />
        </div>
      )}
      {on && (
        <Button
          variant="ghost"
          onClick={() => router.replace(base)}
          className={cn("shrink-0", layout === "rail" && "lg:justify-start")}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
