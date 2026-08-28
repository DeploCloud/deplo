"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Boxes, UserRound, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  FacetCombobox,
  type EnvFacet,
  type FacetOption,
} from "@/components/env/env-filters";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import {
  activityHref,
  hasActivityFilters,
  type ActivityParams,
} from "@/lib/activity-filter";
import { cn } from "@/lib/utils";
import type { ActivityType } from "@/lib/types";
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

/**
 * The Activity page's filter row. Every pick is a navigation, so the URL is the
 * whole state: a link to "what did Ada do last week" is just this page's address.
 */
export function ActivityFilters({
  params,
  actors,
  resources,
}: {
  params: ActivityParams;
  actors: FacetOption[];
  resources: FacetOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function go(next: Partial<ActivityParams>) {
    startTransition(() => router.replace(activityHref({ ...params, ...next })));
  }

  const on = hasActivityFilters(params);

  return (
    <div
      className={cn(
        // Sticky only once the row fits on ONE line: stacked on a phone it is
        // half the screen, and pinning that leaves nothing to read.
        "z-20 flex flex-col gap-2 bg-background py-3 sm:sticky sm:top-14 sm:flex-row sm:items-center",
        pending && "opacity-60",
      )}
    >
      <div className="flex min-w-0 flex-1">
        <FacetCombobox
          facet={facet("actor", "User", "Anyone", UserRound, actors)}
          values={params.actorUserIds}
          onChange={(actorUserIds) => go({ actorUserIds })}
        />
      </div>
      <DateRangeFilter params={params} onChange={go} />
      <div className="flex min-w-0 flex-1">
        <FacetCombobox
          facet={facet("event", "Event", "Any event", Zap, EVENT_OPTIONS)}
          values={params.types}
          onChange={(types) => go({ types: types as ActivityType[] })}
        />
      </div>
      <div className="flex min-w-0 flex-1">
        <FacetCombobox
          facet={facet("resource", "Resource", "Anything", Boxes, resources)}
          values={params.resourceIds}
          onChange={(resourceIds) => go({ resourceIds })}
        />
      </div>
      <Button
        variant="ghost"
        disabled={!on}
        onClick={() => router.replace("/activity")}
        className="shrink-0"
      >
        Clear filters
      </Button>
    </div>
  );
}
