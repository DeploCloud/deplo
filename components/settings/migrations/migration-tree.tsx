"use client";

import * as React from "react";
import {
  Boxes,
  ChevronRight,
  FolderTree,
  Layers,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { FieldLabel } from "@/components/ui/info-tip";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { LogoImage } from "@/components/shared/project-logo";
import type { DatabaseType } from "@/lib/types";
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
 * A database whose host port is taken on the server it is about to land on, as the
 * review needs to say it: the port that clashes, the host it clashes on, and
 * whether what is currently chosen still clashes.
 */
export interface PortConflict {
  takenPort: number;
  serverName: string;
  /** The port chosen RIGHT NOW is itself taken, so the import cannot start. */
  invalid: boolean;
}

/**
 * What is coming over, as a tree you can prune and place.
 */

/**
 * The status column says what is DIFFERENT about a row, so `new` says nothing.
 */
const STATUS_LABEL: Partial<Record<PlanService["status"], string>> = {
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
  status: "w-32",
  build: "w-32",
  run: "w-36",
};

/**
 * Every field a search looks at, the service's own PATH included.
 */
function hit(service: PlanService, path: string, terms: string[]): boolean {
  const hay = [path, service.name, service.kind, ...service.domains]
    .join(" ")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

const nameHit = (name: string, terms: string[]) =>
  terms.every((t) => name.toLowerCase().includes(t));

/**
 * What a search leaves on screen, as three id sets rather than a pruned copy.
 */
export function visible(
  projects: PlanProject[],
  terms: string[],
): { projects: Set<string>; environments: Set<string>; services: Set<string> } {
  const out = {
    projects: new Set<string>(),
    environments: new Set<string>(),
    services: new Set<string>(),
  };
  for (const p of projects) {
    const wholeProject = nameHit(p.name, terms);
    let anyEnv = false;
    for (const e of p.environments) {
      const wholeEnv = wholeProject || nameHit(e.name, terms);
      const path = `${p.name} ${e.name}`;
      const services = e.services.filter(
        (s) => wholeEnv || hit(s, path, terms),
      );
      if (services.length === 0 && !wholeEnv) continue;
      anyEnv = true;
      out.environments.add(e.sourceId);
      for (const s of services) out.services.add(s.sourceId);
    }
    if (anyEnv || wholeProject) out.projects.add(p.sourceId);
  }
  return out;
}

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
  allChosen,
  onToggleAll,
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
  /** Source service id → the port clash to resolve on that row, if any. */
  portConflicts: Record<string, PortConflict>;
  /** False without the publish-ports grant: no port comes over, so none is shown. */
  showPorts: boolean;
  /** Every importable service is ticked, so the button offers the opposite. */
  allChosen: boolean;
  onToggleAll: () => void;
}) {
  // Everything open on arrival: a migration is read top to bottom once, and a
  // tree that hides the thing you came to check is a tree you fight.
  const [open, setOpen] = React.useState<Set<string>>(
    () =>
      new Set(
        projects.flatMap((p) => [
          p.sourceId,
          ...p.environments.map((e) => e.sourceId),
        ]),
      ),
  );

  const [query, setQuery] = React.useState("");
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const shown = React.useMemo(
    () => (terms.length === 0 ? null : visible(projects, terms)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, query],
  );
  // While searching every surviving branch is open - a hit two levels down is
  // useless if you still have to find and expand its ancestors.
  const isOpen = (id: string) => searching || open.has(id);

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

  const rows = projects.filter((p) => !shown || shown.projects.has(p.sourceId));

  // What the bulk controls display: the one value every row agrees on, or
  // nothing when they differ - so they double as the answer to "where is all of
  // this going" without counting down the list.
  const runIds = all.map((x) => x.sourceId);
  const buildIds = all.filter((x) => x.buildsFromSource).map((x) => x.sourceId);
  const commonRun = shared(runIds.map((id) => placements[id]?.serverId));
  const commonBuild = shared(
    buildIds.map((id) => placements[id]?.buildServerId),
  );

  return (
    <div className="space-y-3">
      {/**
       * One row for everything that acts on the WHOLE list: find something, take
       * everything, put everything somewhere.
       */}
      <div className="flex flex-wrap items-center gap-2">
        {/**
         * No cap: the search takes whatever the bulk controls beside it do not want.
         */}
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
          <SimpleTooltip content="Put everything on this server">
            <span className="inline-flex">
              <RunSelect
                servers={servers}
                value={commonRun}
                onChange={(v) => place(runIds, { serverId: v })}
                placeholder="Place all on"
                label="Place everything on"
                className="h-9 w-44"
              />
            </span>
          </SimpleTooltip>
          {/* Default size, not `sm`: it sits beside an Input and two
              SelectTriggers, all `h-9`, and `sm` would land it 4px short. */}
          <Button
            variant="outline"
            onClick={onToggleAll}
            disabled={all.length === 0}
          >
            {allChosen ? "Unselect all" : "Select all"}
          </Button>
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
                // Counted over the WHOLE project, never the filtered slice.
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

function EnvironmentRows({
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
  /** The service ids a search left standing, or null when nothing is filtered. */
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
  // Same rule as the project row: counted over every service in the environment,
  // not over the ones a search happens to be showing.
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

function ServiceRows({
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
  // What this database will publish, after whatever the review decided. Absent
  // means nobody decided anything, which is the source's own port.
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
            <Badge
              className="whitespace-nowrap"
              variant={service.status === "exists" ? "info" : "warning"}
            >
              {STATUS_LABEL[service.status]}
            </Badge>
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

/**
 * The one thing on this screen that is not a choice about WHERE, but about what a
 * database will answer on.
 */
function PortConflictRow({
  service,
  conflict,
  port,
  onPlace,
}: {
  service: PlanService;
  conflict: PortConflict;
  port: number | null;
  onPlace: (patch: Partial<Placement>) => void;
}) {
  const exposed = port != null;
  const portField = `imp-port-${service.sourceId}`;
  const toggleField = `imp-expose-${service.sourceId}`;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-warning/10 py-2 pr-3 text-xs text-warning"
      style={{ paddingLeft: `${0.75 + 3 * 1.25}rem` }}
    >
      <span className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">
          Port {conflict.takenPort} is taken on {conflict.serverName}.
        </span>
      </span>
      {/**
       * The problem reads on the left, the remedy sits at the far end of the strip: you
       * find out what is wrong before you are handed the controls for it, and every row's
       * controls line up with each other instead of starting wherever their sentence
       * happened to stop.
       */}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:ml-auto">
        <span className="flex items-center gap-2">
          <Checkbox
            id={toggleField}
            checked={exposed}
            // Back ON means back to what the source published, which the review then finds a
            // free port for exactly as it did the first time - so there is no "last port" to
            // remember here, and no way for this row to hand back a stale one.
            onCheckedChange={(v) =>
              onPlace({
                exposedPort:
                  v === true
                    ? (service.exposedPort ?? conflict.takenPort)
                    : null,
              })
            }
          />
          <label
            htmlFor={toggleField}
            className="cursor-pointer text-foreground"
          >
            Expose publicly
          </label>
        </span>
        {exposed && (
          <span className="flex items-center gap-2">
            {/* `text-xs` on purpose: `Label` is `text-sm`, and inside this
                strip it came out a size bigger than the sentence it belongs
                to. One row, one type size. */}
            <FieldLabel
              htmlFor={portField}
              className="text-xs"
              info="The port on the server clients connect to. Use a free unprivileged port (1024-65535)."
            >
              Host port
            </FieldLabel>
            <Input
              id={portField}
              type="number"
              inputMode="numeric"
              min={1024}
              max={65535}
              value={port ?? ""}
              aria-invalid={conflict.invalid || undefined}
              onChange={(e) => {
                const n = Number(e.target.value);
                const next = Number.isInteger(n) && n > 0 ? n : null;
                // Emptying the box IS "publish nothing", and the checkbox says
                // so by going off - rather than leaving a field that looks
                // filled-in-pending and an Import button nobody can explain.
                onPlace({ exposedPort: next });
              }}
              className="h-8 w-24"
            />
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * What a service will BE here, drawn the way Deplo already draws it. `engine` is
 * resolved server-side because Dokploy's `mongo` is Deplo's `mongodb`, and a
 * second copy of that table in the browser is one that drifts.
 */
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

/* ------------------------------------------------------------------ */
/* The two placement controls                                         */
/* ------------------------------------------------------------------ */

function RunSelect({
  id,
  servers,
  value,
  onChange,
  placeholder,
  className,
  label,
}: {
  id?: string;
  servers: ServerChoice[];
  value: string | undefined;
  onChange: (serverId: string) => void;
  placeholder?: string;
  /** The trigger's own size. Rows want `h-8`; a toolbar beside an Input wants `h-9`. */
  className?: string;
  /** A column caption used to name these; without a header each says it itself. */
  label?: string;
}) {
  return (
    <Select value={value ?? ""} onValueChange={onChange}>
      <SelectTrigger
        id={id}
        aria-label={label}
        className={cn("h-8 w-full [&_[data-hint]]:hidden", className)}
      >
        <SelectValue placeholder={placeholder ?? "Choose a server"} />
      </SelectTrigger>
      <SelectContent>
        {servers.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            <span className="flex items-center gap-2">
              {s.name}
              {s.isDeploHost && (
                <span data-hint className="text-xs text-muted-foreground">
                  Deplo host
                </span>
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
  className,
  label,
}: {
  id?: string;
  servers: ServerChoice[];
  value: string | null | undefined;
  onChange: (buildServerId: string | null) => void;
  placeholder?: string;
  className?: string;
  label?: string;
}) {
  return (
    <Select
      value={value === undefined ? "" : (value ?? AUTOMATIC)}
      onValueChange={(v) => onChange(v === AUTOMATIC ? null : v)}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        className={cn("h-8 w-full [&_[data-hint]]:hidden", className)}
      >
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
                <span data-hint className="text-xs text-muted-foreground">
                  Build only
                </span>
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
          className="rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRight
            className={cn(
              "size-4 transition-transform",
              expanded && "rotate-90",
            )}
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
        <span className="flex size-4 shrink-0 items-center justify-center">
          {mark}
        </span>
        {/**
         * Name over meta, not name beside meta.
         */}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm",
              depth === 0 && "font-medium",
            )}
          >
            {label}
          </span>
          {meta && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {meta}
            </span>
          )}
        </span>
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
