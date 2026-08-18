"use client";

import * as React from "react";
import {
  Boxes,
  ChevronRight,
  Database,
  FolderTree,
  Layers,
  TriangleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  importableOf,
  isImportable,
  type Placement,
  type PlanEnvironment,
  type PlanProject,
  type PlanService,
  type ServerChoice,
} from "./types";

/**
 * What is coming over, as a tree you can prune and place.
 *
 * The row is the scope picker's row, deliberately: same indent, same chevron,
 * same meta column, so a tree in Deplo looks like every other tree in Deplo.
 * What differs is the SELECTION MODEL. The scope picker grants a subtree
 * forever, so ticking a parent covers descendants that do not exist yet and its
 * children go checked-and-disabled. Here the set is closed and finite - these
 * exact services, once - so the leaf is the truth and every parent is derived
 * from it. That is what makes a half-ticked project honest instead of a lie
 * about the four services under it.
 *
 * The two right-hand columns are where each app lands. They live ON the row
 * rather than in a table below it because "which of these am I taking" and
 * "where does this one go" are the same question asked twice, and answering the
 * second one in a different list means matching names by eye.
 */

const STATUS_LABEL: Record<PlanService["status"], string> = {
  new: "New",
  exists: "Already here",
  unsupported: "Not supported",
  needs_grant: "Needs a permission",
};

/**
 * Automatic is the ABSENCE of a build server, and Radix refuses an empty item
 * value, so the menu needs a token for it. It never leaves this file: the
 * placement stores null.
 */
const AUTOMATIC = "__automatic__";

/** Column widths, shared by the header and every row so they line up. */
const COL = {
  status: "w-28",
  build: "w-44",
  run: "w-44",
};

export function ImportTree({
  projects,
  chosen,
  onChange,
  servers,
  buildServers,
  placements,
  onPlacementsChange,
}: {
  projects: PlanProject[];
  /** Source service ids. The leaves ARE the selection; parents are derived. */
  chosen: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Hosts that can RUN a workload. */
  servers: ServerChoice[];
  /** Hosts that can COMPILE - wider, a build-only host belongs here and not above. */
  buildServers: ServerChoice[];
  placements: Record<string, Placement>;
  onPlacementsChange: (next: Record<string, Placement>) => void;
}) {
  // Everything open on arrival: a migration is read top to bottom once, and a
  // tree that hides the thing you came to check is a tree you fight.
  const [open, setOpen] = React.useState<Set<string>>(
    () => new Set(projects.flatMap((p) => [p.sourceId, ...p.environments.map((e) => e.sourceId)])),
  );

  // No build-only host in the fleet means the column could only ever read
  // "Automatic" on every row, and a control with one possible answer is a tax on
  // everyone who has to read past it.
  const showBuild = buildServers.some((s) => s.buildOnly);

  const all = React.useMemo(() => projects.flatMap(importableOf), [projects]);

  function toggleOpen(id: string) {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
  }

  /** Tick or untick a whole branch in one write. */
  function set(services: PlanService[], on: boolean) {
    const next = new Set(chosen);
    for (const s of services) {
      if (!isImportable(s)) continue;
      if (on) next.add(s.sourceId);
      else next.delete(s.sourceId);
    }
    onChange(next);
  }

  function place(serviceIds: string[], patch: Partial<Placement>) {
    const next = { ...placements };
    for (const id of serviceIds) {
      const current = next[id];
      if (!current) continue;
      next[id] = { ...current, ...patch };
    }
    onPlacementsChange(next);
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <div className="min-w-[48rem]">
        <SetAllHeader
          showBuild={showBuild}
          servers={servers}
          buildServers={buildServers}
          services={all}
          placements={placements}
          onPlace={place}
        />
        <div className="max-h-[28rem] divide-y divide-border/60 overflow-y-auto">
          {projects.map((p) => {
            const pickable = importableOf(p);
            const on = pickable.filter((s) => chosen.has(s.sourceId)).length;
            return (
              <React.Fragment key={p.sourceId}>
                <Row
                  id={`imp-p-${p.sourceId}`}
                  depth={0}
                  label={p.name}
                  mark={<FolderTree className="size-3.5 text-muted-foreground" />}
                  meta={countLabel(on, pickable.length)}
                  expandable
                  expanded={open.has(p.sourceId)}
                  onToggleExpand={() => toggleOpen(p.sourceId)}
                  checked={tristate(on, pickable.length)}
                  disabled={pickable.length === 0}
                  onCheckedChange={(v) => set(pickable, v)}
                  showBuild={showBuild}
                  status={p.exists ? <Badge variant="outline">Already here</Badge> : null}
                />
                {open.has(p.sourceId) &&
                  p.environments.map((e) => (
                    <EnvironmentRows
                      key={e.sourceId}
                      environment={e}
                      chosen={chosen}
                      expanded={open.has(e.sourceId)}
                      onToggleExpand={() => toggleOpen(e.sourceId)}
                      onSet={set}
                      showBuild={showBuild}
                      servers={servers}
                      buildServers={buildServers}
                      placements={placements}
                      onPlace={place}
                    />
                  ))}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EnvironmentRows({
  environment,
  chosen,
  expanded,
  onToggleExpand,
  onSet,
  showBuild,
  servers,
  buildServers,
  placements,
  onPlace,
}: {
  environment: PlanEnvironment;
  chosen: Set<string>;
  expanded: boolean;
  onToggleExpand: () => void;
  onSet: (services: PlanService[], on: boolean) => void;
  showBuild: boolean;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  placements: Record<string, Placement>;
  onPlace: (serviceIds: string[], patch: Partial<Placement>) => void;
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
        environment.services.map((s) => (
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
          />
        ))}
    </>
  );
}

function ServiceRows({
  service,
  checked,
  onCheckedChange,
  showBuild,
  servers,
  buildServers,
  placement,
  onPlace,
}: {
  service: PlanService;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  showBuild: boolean;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  placement: Placement | undefined;
  onPlace: (patch: Partial<Placement>) => void;
}) {
  const Icon = service.targetKind === "database" ? Database : Layers;
  const placeable = isImportable(service) && placement != null;
  return (
    <>
      <Row
        id={`imp-s-${service.sourceId}`}
        depth={2}
        label={service.name}
        mark={<Icon className="size-3.5 text-muted-foreground" />}
        meta={service.domains[0] ?? service.kind}
        expandable={false}
        expanded={false}
        onToggleExpand={() => {}}
        checked={checked}
        disabled={!isImportable(service)}
        onCheckedChange={onCheckedChange}
        showBuild={showBuild}
        status={
          <Badge
            variant={
              service.status === "new"
                ? "secondary"
                : service.status === "exists"
                  ? "outline"
                  : "warning"
            }
          >
            {STATUS_LABEL[service.status]}
          </Badge>
        }
        build={
          !placeable ? null : service.buildsFromSource ? (
            <BuildSelect
              id={`imp-build-${service.sourceId}`}
              servers={buildServers}
              value={placement.buildServerId}
              onChange={(buildServerId) => onPlace({ buildServerId })}
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
            />
          )
        }
      />
      {/* The notes are the whole reason this screen exists, so they are warnings
          here rather than grey small print nobody reads. */}
      {service.notes.map((n, i) => (
        <div
          key={i}
          className="flex items-start gap-2 py-1.5 pr-3 text-xs text-warning"
          style={{ paddingLeft: `${0.75 + 3 * 1.25}rem` }}
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">{n}</span>
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The two placement controls                                         */
/* ------------------------------------------------------------------ */

function RunSelect({
  id,
  servers,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
  servers: ServerChoice[];
  value: string | undefined;
  onChange: (serverId: string) => void;
  placeholder?: string;
}) {
  return (
    <Select value={value ?? ""} onValueChange={onChange}>
      <SelectTrigger id={id} className="h-8 w-full">
        <SelectValue placeholder={placeholder ?? "Choose a server"} />
      </SelectTrigger>
      <SelectContent>
        {servers.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            <span className="flex items-center gap-2">
              {s.name}
              {s.isDeploHost && (
                <span className="text-xs text-muted-foreground">Deplo host</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function BuildSelect({
  id,
  servers,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
  servers: ServerChoice[];
  value: string | null | undefined;
  onChange: (buildServerId: string | null) => void;
  placeholder?: string;
}) {
  return (
    <Select
      value={value === undefined ? "" : (value ?? AUTOMATIC)}
      onValueChange={(v) => onChange(v === AUTOMATIC ? null : v)}
    >
      <SelectTrigger id={id} className="h-8 w-full">
        <SelectValue placeholder={placeholder ?? "Automatic"} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
        <SelectSeparator />
        {servers.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            <span className="flex items-center gap-2">
              {s.name}
              {s.buildOnly && (
                <span className="text-xs text-muted-foreground">Build only</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Why an app has no build picker. The dash is the control; the tooltip is why. */
function NothingToBuild({ service }: { service: PlanService }) {
  return (
    <SimpleTooltip
      content={
        service.kind === "compose"
          ? "A compose stack runs the images it names, so Deplo builds nothing for it."
          : "Deployed from a prebuilt image, so Deplo builds nothing for it."
      }
    >
      <span
        id={`imp-nobuild-${service.sourceId}`}
        className="flex h-8 cursor-default items-center justify-center text-sm text-muted-foreground"
      >
        -
      </span>
    </SimpleTooltip>
  );
}

/* ------------------------------------------------------------------ */
/* The header                                                         */
/* ------------------------------------------------------------------ */

/**
 * The columns, and one control that writes every row at once.
 *
 * Each shows the value the rows agree on, or nothing when they differ - so it
 * doubles as the answer to "where is all of this going" without counting down
 * the list.
 */
function SetAllHeader({
  showBuild,
  servers,
  buildServers,
  services,
  placements,
  onPlace,
}: {
  showBuild: boolean;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  services: PlanService[];
  placements: Record<string, Placement>;
  onPlace: (serviceIds: string[], patch: Partial<Placement>) => void;
}) {
  const runIds = services.map((s) => s.sourceId);
  const buildIds = services.filter((s) => s.buildsFromSource).map((s) => s.sourceId);

  const commonRun = shared(runIds.map((id) => placements[id]?.serverId));
  const commonBuild = shared(buildIds.map((id) => placements[id]?.buildServerId));

  return (
    <div className="flex items-end gap-2 border-b border-border bg-muted/30 py-2 pl-3 pr-3">
      <div className="min-w-0 flex-1 text-xs text-muted-foreground">Set all</div>
      <span className={cn("shrink-0", COL.status)} aria-hidden />
      {showBuild && (
        <div className={cn("shrink-0", COL.build)}>
          <div className="mb-1 text-xs text-muted-foreground">Build</div>
          <BuildSelect
            servers={buildServers}
            value={buildIds.length === 0 ? undefined : commonBuild}
            onChange={(v) => onPlace(buildIds, { buildServerId: v })}
            placeholder="Mixed"
          />
        </div>
      )}
      <div className={cn("shrink-0", COL.run)}>
        <div className="mb-1 text-xs text-muted-foreground">Runs on</div>
        <RunSelect
          servers={servers}
          value={commonRun}
          onChange={(v) => onPlace(runIds, { serverId: v })}
          placeholder="Mixed"
        />
      </div>
    </div>
  );
}

/** The one value every entry holds, or undefined when they disagree. */
function shared<T>(values: (T | undefined)[]): T | undefined {
  if (values.length === 0) return undefined;
  const [first, ...rest] = values;
  return rest.every((v) => v === first) ? first : undefined;
}

/* ------------------------------------------------------------------ */
/* The row                                                            */
/* ------------------------------------------------------------------ */

function tristate(on: number, total: number): boolean | "indeterminate" {
  if (total === 0 || on === 0) return false;
  return on === total ? true : "indeterminate";
}

/**
 * A selection counter, not a size.
 *
 * Deliberately nounless: the scope picker can say "8 apps" because everything
 * under it IS an App, while a Dokploy project mixes apps and databases and
 * calling a Postgres an app in the same breath as the glossary is how a
 * vocabulary rots. "3 of 8 selected" reads identically in every state.
 */
function countLabel(on: number, total: number): string {
  if (total === 0) return "Nothing to import";
  return `${on} of ${total} selected`;
}

function Row({
  id,
  depth,
  label,
  mark,
  meta,
  status,
  build,
  run,
  showBuild,
  expandable,
  expanded,
  onToggleExpand,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  depth: number;
  label: string;
  mark: React.ReactNode;
  meta?: React.ReactNode;
  status?: React.ReactNode;
  build?: React.ReactNode;
  run?: React.ReactNode;
  showBuild: boolean;
  expandable: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  checked: boolean | "indeterminate";
  disabled: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-2 pr-3",
        depth === 0 && "bg-muted/20",
      )}
      // Indent by depth rather than a class per level, exactly as the scope
      // picker does - the two trees have to line up visually.
      style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
    >
      {expandable ? (
        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={expanded}
          className="rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn("size-4 transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : (
        <span className="size-4" aria-hidden />
      )}
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onCheckedChange(v === true)}
      />
      <label
        htmlFor={id}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2",
          !disabled && "cursor-pointer",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">{mark}</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            depth === 0 && "font-medium",
          )}
        >
          {label}
        </span>
        {meta && (
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            {meta}
          </span>
        )}
      </label>
      {/* Fixed-width cells on every row, empty ones included: the tree indents
          only on the left, so this is what keeps the columns a column. */}
      <div className={cn("flex shrink-0 items-center justify-end", COL.status)}>
        {status}
      </div>
      {showBuild && <div className={cn("shrink-0", COL.build)}>{build}</div>}
      <div className={cn("shrink-0", COL.run)}>{run}</div>
    </div>
  );
}
