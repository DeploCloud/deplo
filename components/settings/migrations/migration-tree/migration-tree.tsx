"use client";

import * as React from "react";
import { FolderTree, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  importableOf,
  type Placement,
  type PlanProject,
  type PlanService,
  type ServerChoice,
} from "../types";
import { EnvironmentRows } from "./environment-rows";
import { BuildSelect } from "./placement-selects";
import type { PortConflict } from "./port-conflict-row";
import { Row } from "./row";
import { useTreeSearch } from "./search";
import { countLabel, placeAll, shared, tickAll, tristate } from "./selection";

export function MigrationTree({
  projects,
  chosen,
  onChange,
  servers,
  buildServers,
  placements,
  onPlacementsChange,
  portConflicts,
  showPorts,
}: {
  projects: PlanProject[];
  chosen: Set<string>;
  onChange: (next: Set<string>) => void;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  placements: Record<string, Placement>;
  onPlacementsChange: (next: Record<string, Placement>) => void;
  portConflicts: Record<string, PortConflict>;
  showPorts: boolean;
}) {
  const { query, setQuery, shown, isOpen, toggleOpen } =
    useTreeSearch(projects);

  const showBuild = buildServers.some((s) => s.buildOnly);

  const all = React.useMemo(() => projects.flatMap(importableOf), [projects]);

  function set(services: PlanService[], on: boolean) {
    onChange(tickAll(chosen, services, on));
  }

  function place(serviceIds: string[], patch: Partial<Placement>) {
    onPlacementsChange(placeAll(placements, serviceIds, patch));
  }

  const rows = projects.filter((p) => !shown || shown.projects.has(p.sourceId));

  const buildIds = all.filter((x) => x.buildsFromSource).map((x) => x.sourceId);
  const commonBuild = shared(
    buildIds.map((id) => placements[id]?.buildServerId),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[11rem] flex-1 basis-full sm:basis-auto">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps and databases"
            aria-label="Search what will come over"
            className="pr-9 pl-9"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear the search"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {showBuild && (
            <SimpleTooltip content="Build every app on this server">
              <span className="inline-flex">
                <BuildSelect
                  servers={buildServers}
                  value={buildIds.length === 0 ? undefined : commonBuild}
                  onChange={(v) => place(buildIds, { buildServerId: v })}
                  placeholder="Build all on"
                  label="Build everything on"
                  className="h-9 w-44"
                />
              </span>
            </SimpleTooltip>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          Nothing matches &ldquo;{query}&rdquo;.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <div className="min-w-[32rem]">
            <div className="max-h-[28rem] divide-y divide-border/60 overflow-y-auto">
              {rows.map((p) => {
                const pickable = importableOf(p);
                const on = pickable.filter((s) =>
                  chosen.has(s.sourceId),
                ).length;
                return (
                  <React.Fragment key={p.sourceId}>
                    <Row
                      id={`imp-p-${p.sourceId}`}
                      depth={0}
                      label={p.name}
                      mark={
                        <FolderTree className="size-3.5 text-muted-foreground" />
                      }
                      meta={countLabel(on, pickable.length)}
                      expandable
                      expanded={isOpen(p.sourceId)}
                      onToggleExpand={() => toggleOpen(p.sourceId)}
                      checked={tristate(on, pickable.length)}
                      disabled={pickable.length === 0}
                      onCheckedChange={(v) => set(pickable, v)}
                      showBuild={showBuild}
                      status={
                        p.exists ? (
                          <Badge variant="info">Already here</Badge>
                        ) : null
                      }
                    />
                    {isOpen(p.sourceId) &&
                      p.environments
                        .filter(
                          (e) => !shown || shown.environments.has(e.sourceId),
                        )
                        .map((e) => (
                          <EnvironmentRows
                            key={e.sourceId}
                            environment={e}
                            hidden={shown ? shown.services : null}
                            chosen={chosen}
                            expanded={isOpen(e.sourceId)}
                            onToggleExpand={() => toggleOpen(e.sourceId)}
                            onSet={set}
                            showBuild={showBuild}
                            servers={servers}
                            buildServers={buildServers}
                            placements={placements}
                            onPlace={place}
                            portConflicts={portConflicts}
                            showPorts={showPorts}
                          />
                        ))}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
