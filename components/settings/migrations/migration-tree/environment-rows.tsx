"use client";

import { Boxes } from "lucide-react";

import {
  isImportable,
  type Placement,
  type PlanEnvironment,
  type PlanService,
  type ServerChoice,
} from "../types";
import type { PortConflict } from "./port-conflict-row";
import { Row } from "./row";
import { countLabel, tristate } from "./selection";
import { ServiceRows } from "./service-rows";

export function EnvironmentRows({
  environment,
  hidden,
  chosen,
  expanded,
  onToggleExpand,
  onSet,
  showBuild,
  servers,
  buildServers,
  placements,
  onPlace,
  portConflicts,
  showPorts,
}: {
  environment: PlanEnvironment;
  hidden: Set<string> | null;
  chosen: Set<string>;
  expanded: boolean;
  onToggleExpand: () => void;
  onSet: (services: PlanService[], on: boolean) => void;
  showBuild: boolean;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  placements: Record<string, Placement>;
  onPlace: (serviceIds: string[], patch: Partial<Placement>) => void;
  portConflicts: Record<string, PortConflict>;
  showPorts: boolean;
}) {
  const pickable = environment.services.filter(isImportable);
  const on = pickable.filter((s) => chosen.has(s.sourceId)).length;
  return (
    <>
      <Row
        id={`imp-e-${environment.sourceId}`}
        depth={1}
        label={environment.name}
        mark={<Boxes className="size-3.5 text-muted-foreground" />}
        meta={
          environment.services.length === 0
            ? "Empty"
            : countLabel(on, pickable.length)
        }
        expandable={environment.services.length > 0}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        checked={tristate(on, pickable.length)}
        disabled={pickable.length === 0}
        onCheckedChange={(v) => onSet(pickable, v)}
        showBuild={showBuild}
      />
      {expanded &&
        environment.services
          .filter((s) => !hidden || hidden.has(s.sourceId))
          .map((s) => (
            <ServiceRows
              key={s.sourceId}
              service={s}
              checked={chosen.has(s.sourceId)}
              onCheckedChange={(v) => onSet([s], v)}
              showBuild={showBuild}
              servers={servers}
              buildServers={buildServers}
              placement={placements[s.sourceId]}
              onPlace={(patch) => onPlace([s.sourceId], patch)}
              conflict={portConflicts[s.sourceId]}
              showPorts={showPorts}
            />
          ))}
    </>
  );
}
