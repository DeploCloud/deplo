"use client";

import { Layers } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { LogoImage } from "@/components/shared/project-logo";
import type { DatabaseType } from "@/lib/types/database";
import {
  isImportable,
  type Placement,
  type PlanService,
  type ServerChoice,
} from "../types";
import { BuildSelect, NothingToBuild, RunSelect } from "./placement-selects";
import { PortConflictRow, type PortConflict } from "./port-conflict-row";
import { Row } from "./row";

const STATUS_LABEL: Partial<Record<PlanService["status"], string>> = {
  exists: "Already here",
  unsupported: "Not supported",
  needs_grant: "Needs a permission",
};

export function ServiceRows({
  service,
  checked,
  onCheckedChange,
  showBuild,
  servers,
  buildServers,
  placement,
  onPlace,
  conflict,
  showPorts,
}: {
  service: PlanService;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  showBuild: boolean;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  placement: Placement | undefined;
  onPlace: (patch: Partial<Placement>) => void;
  conflict: PortConflict | undefined;
  showPorts: boolean;
}) {
  const placeable = isImportable(service) && placement != null;
  const port =
    placement?.exposedPort !== undefined
      ? placement.exposedPort
      : service.exposedPort;
  return (
    <>
      <Row
        id={`imp-s-${service.sourceId}`}
        depth={2}
        label={service.name}
        mark={<ServiceMark service={service} />}
        meta={
          showPorts && port != null && !conflict
            ? `${service.kind} · Publishes ${port}`
            : (service.domains[0] ?? service.kind)
        }
        expandable={false}
        expanded={false}
        onToggleExpand={() => {}}
        checked={checked}
        disabled={!isImportable(service)}
        onCheckedChange={onCheckedChange}
        showBuild={showBuild}
        status={
          STATUS_LABEL[service.status] ? (
            <SimpleTooltip
              content={service.notes.join(" ") || STATUS_LABEL[service.status]}
            >
              <Badge
                className="whitespace-nowrap"
                variant={service.status === "exists" ? "info" : "warning"}
              >
                {STATUS_LABEL[service.status]}
              </Badge>
            </SimpleTooltip>
          ) : service.notes.length > 0 ? (
            <SimpleTooltip content={service.notes.join(" ")}>
              <Badge className="whitespace-nowrap" variant="secondary">
                Note
              </Badge>
            </SimpleTooltip>
          ) : null
        }
        build={
          !placeable ? null : service.buildsFromSource ? (
            <BuildSelect
              id={`imp-build-${service.sourceId}`}
              servers={buildServers}
              value={placement.buildServerId}
              onChange={(buildServerId) => onPlace({ buildServerId })}
              label={`Where ${service.name} is built`}
            />
          ) : (
            <NothingToBuild service={service} />
          )
        }
        run={
          !placeable ? null : (
            <RunSelect
              id={`imp-run-${service.sourceId}`}
              servers={servers}
              value={placement.serverId}
              onChange={(serverId) => onPlace({ serverId })}
              label={`Where ${service.name} runs`}
            />
          )
        }
      />
      {conflict && placeable && (
        <PortConflictRow
          service={service}
          conflict={conflict}
          port={port ?? null}
          onPlace={onPlace}
        />
      )}
    </>
  );
}

function ServiceMark({ service }: { service: PlanService }) {
  if (service.targetKind === "database")
    return (
      <DatabaseLogo
        type={service.engine as DatabaseType}
        logo={service.logo}
        size={16}
        className="rounded-sm bg-transparent"
      />
    );
  return (
    <LogoImage
      src={service.logo}
      size={16}
      className="rounded-sm bg-transparent"
      fallback={<Layers className="size-3.5 text-muted-foreground" />}
    />
  );
}
