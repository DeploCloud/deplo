"use client";

import * as React from "react";
import { Server as ServerIcon, Users } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { ListToolbar, type ListView } from "@/components/shared/list-toolbar";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FilterFacet, useUrlFacets } from "@/components/shared/filter-facet";
import {
  countBy,
  inAny,
  teamFacetOptions,
  type TeamRef,
} from "@/components/shared/facet-filtering";
import {
  SERVER_USES,
  SERVER_USE_IDS,
  type ServerUse,
} from "./server-role-badge";

export type ServerListItem = {
  id: string;
  search: string;
  use: ServerUse;
  // Every team that can deploy here: all of them for a server open to all teams.
  teams: TeamRef[];
  card: React.ReactNode;
  row: React.ReactNode;
};

const FACETS = ["team", "use"] as const;

const USE_OPTIONS = SERVER_USE_IDS.filter((id) => id !== "import").map((id) => {
  const { label, icon: Icon } = SERVER_USES[id];
  return { value: id, label, leading: <Icon className="size-4" /> };
});

export function filterServers(
  items: ServerListItem[],
  { query, teams, uses }: { query: string; teams: string[]; uses: string[] },
): ServerListItem[] {
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

export function ServersList({ items }: { items: ServerListItem[] }) {
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = useUrlFacets(FACETS);
  const [view, setView] = React.useState<ListView>("grid");

  const shown = filterServers(items, {
    query,
    teams: picked.team,
    uses: picked.use,
  });
  const teams = teamFacetOptions(items.map((i) => i.teams));

  return (
    <div className="space-y-4">
      {items.length > 1 && (
        <ServersToolbar
          query={query}
          onQuery={setQuery}
          view={view}
          onView={setView}
          teams={teams}
          useCounts={countBy(items, (i) => i.use)}
          picked={picked}
          onPick={setPicked}
        />
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={ServerIcon}
          title="No matching servers"
          description="No server matches the current search and filter."
        />
      ) : (
        <ServerGroup items={shown} view={view} />
      )}
    </div>
  );
}

function ServersToolbar({
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
  picked: Record<(typeof FACETS)[number], string[]>;
  onPick: (key: (typeof FACETS)[number], values: string[]) => void;
}) {
  return (
    <ListToolbar
      query={query}
      onQuery={onQuery}
      placeholder="Search servers"
      view={view}
      onView={onView}
      listLabel="Table view"
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
export function ServersListSkeleton({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <ServersToolbar
        query=""
        onQuery={noop}
        view="grid"
        onView={noop}
        teams={{ options: PLACEHOLDER_OPTIONS, counts: {} }}
        picked={{ team: [], use: [] }}
        onPick={noop}
      />
      <div className="grid items-start gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function ServerGroup({
  items,
  view,
}: {
  items: ServerListItem[];
  view: ListView;
}) {
  if (view === "grid")
    return (
      <div className="grid items-start gap-4 sm:grid-cols-2">
        {items.map((i) => (
          <React.Fragment key={i.id}>{i.card}</React.Fragment>
        ))}
      </div>
    );
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Server</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Used for</TableHead>
            <TableHead>Proxy</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Access</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((i) => (
            <React.Fragment key={i.id}>{i.row}</React.Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
