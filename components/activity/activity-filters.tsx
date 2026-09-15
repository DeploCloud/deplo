"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { Boxes, UserRound, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FacetCombobox } from "@/components/env/env-filters/facet-combobox";
import type { EnvFacet, FacetOption } from "@/components/env/env-filters/types";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import {
  activityHref,
  hasActivityFilters,
  type ActivityParams,
} from "@/lib/activity-filter";
import { cn } from "@/lib/utils";
import type { ActivityType } from "@/lib/types/activity";
import type { DatabaseType } from "@/lib/types/database";
import { DateRangeFilter } from "./date-range-filter";

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

export interface ResourceOption {
  id: string;
  name: string;
  logo?: string | null;
}

export interface DatabaseResourceOption {
  id: string;
  name: string;
  logo: string | null;
  type: DatabaseType;
}

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
  actors?: FacetOption[];
  apps?: ResourceOption[];
  folders?: ResourceOption[];
  projects?: ResourceOption[];
  databases?: DatabaseResourceOption[];
  actorCounts?: Record<string, number>;
  typeCounts?: Record<string, number>;
  layout?: "bar" | "rail";
  base?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

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
        layout === "bar" && "sm:sticky sm:top-14",
        layout === "rail" && "lg:flex-col lg:items-stretch lg:py-0",
        pending && "opacity-60",
      )}
    >
      {actors && (
        <div className="flex min-w-0 flex-1">
          <FacetCombobox
            facet={facet("actor", "User", "Anyone", UserRound, actors)}
            counts={actorCounts}
            values={params.actorUserIds}
            onChange={(actorUserIds) => go({ actorUserIds })}
          />
        </div>
      )}
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
