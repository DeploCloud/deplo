"use client";

import * as React from "react";
import { Server as ServerIcon, Users } from "lucide-react";

import { ListToolbar, type ListView } from "@/components/shared/list-toolbar";
import { FilterFacet } from "@/components/shared/filter-facet";
import {
  inAny,
  type teamFacetOptions,
  type TeamRef,
} from "@/components/shared/facet-filtering";
import {
  SERVER_USES,
  SERVER_USE_IDS,
  type ServerUse,
} from "./server-role-badge";

/** What the search and the filters read of a server. */
export type ServerFilterFields = {
  search: string;
  use: ServerUse;
  // Every team that can deploy here: all of them for a server open to all teams.
  teams: TeamRef[];
};

export const SERVER_FACETS = ["team", "use"] as const;
export type ServerFacet = (typeof SERVER_FACETS)[number];

const USE_OPTIONS = SERVER_USE_IDS.filter((id) => id !== "import").map((id) => {
  const { label, icon: Icon } = SERVER_USES[id];
  return { value: id, label, leading: <Icon className="size-4" /> };
});

export function filterServers<T extends ServerFilterFields>(
  items: T[],
  { query, teams, uses }: { query: string; teams: string[]; uses: string[] },
): T[] {
  const q = query.trim().toLowerCase();
  return items.filter(
    (i) =>
      inAny(uses, [i.use]) &&
      inAny(
        teams,
        i.teams.map((t) => t.slug),
      ) &&
      (!q || i.search.includes(q)),
  );
}

export function gridClass(view: ListView): string {
  return view === "list"
    ? "flex flex-col gap-3"
    : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";
}

export function ServersToolbar({
  query,
  onQuery,
  view,
  onView,
  teams,
  useCounts,
  picked,
  onPick,
}: {
  query: string;
  onQuery: (v: string) => void;
  view: ListView;
  onView: (v: ListView) => void;
  teams: ReturnType<typeof teamFacetOptions>;
  useCounts?: Record<string, number>;
  picked: Record<ServerFacet, string[]>;
  onPick: (key: ServerFacet, values: string[]) => void;
}) {
  return (
    <ListToolbar
      query={query}
      onQuery={onQuery}
      placeholder="Search servers"
      view={view}
      onView={onView}
      filters={
        <>
          <FilterFacet
            id="team"
            label="Team"
            allLabel="Any team"
            icon={Users}
            options={teams.options}
            counts={teams.counts}
            values={picked.team}
            onChange={(v) => onPick("team", v)}
          />
          <FilterFacet
            id="use"
            label="Used for"
            allLabel="Any use"
            icon={ServerIcon}
            options={USE_OPTIONS}
            counts={useCounts}
            values={picked.use}
            onChange={(v) => onPick("use", v)}
          />
        </>
      }
    />
  );
}

// One option, so the facet draws as it will once loaded, not as an empty one.
const PLACEHOLDER_OPTIONS = [{ value: "", label: "" }];
const noop = () => {};

// The grid view with its toolbar; `children` are the skeleton cards.
export function ServersGridSkeleton({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <ServersToolbar
        query=""
        onQuery={noop}
        view="grid"
        onView={noop}
        teams={{ options: PLACEHOLDER_OPTIONS, counts: {} }}
        picked={{ team: [], use: [] }}
        onPick={noop}
      />
      <div className={gridClass("grid")}>{children}</div>
    </div>
  );
}
