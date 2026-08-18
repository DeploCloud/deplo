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
  importableOf,
  isImportable,
  type PlanEnvironment,
  type PlanProject,
  type PlanService,
} from "./types";

/**
 * What is coming over, as a tree you can prune.
 *
 * The row is the scope picker's row, deliberately: same indent, same chevron,
 * same meta column, so a tree in Deplo looks like every other tree in Deplo.
 * What differs is the SELECTION MODEL. The scope picker grants a subtree
 * forever, so ticking a parent covers descendants that do not exist yet and its
 * children go checked-and-disabled. Here the set is closed and finite - these
 * exact services, once - so the leaf is the truth and every parent is derived
 * from it. That is what makes a half-ticked project honest instead of a lie
 * about the four services under it.
 */

const STATUS_LABEL: Record<PlanService["status"], string> = {
  new: "New",
  exists: "Already here",
  unsupported: "Not supported",
  needs_grant: "Needs a permission",
};

export function ImportTree({
  projects,
  chosen,
  onChange,
}: {
  projects: PlanProject[];
  /** Source service ids. The leaves ARE the selection; parents are derived. */
  chosen: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  // Everything open on arrival: a migration is read top to bottom once, and a
  // tree that hides the thing you came to check is a tree you fight.
  const [open, setOpen] = React.useState<Set<string>>(
    () => new Set(projects.flatMap((p) => [p.sourceId, ...p.environments.map((e) => e.sourceId)])),
  );

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

  return (
    <div className="max-h-[28rem] divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
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
              right={p.exists ? <Badge variant="outline">Already here</Badge> : null}
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
                />
              ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function EnvironmentRows({
  environment,
  chosen,
  expanded,
  onToggleExpand,
  onSet,
}: {
  environment: PlanEnvironment;
  chosen: Set<string>;
  expanded: boolean;
  onToggleExpand: () => void;
  onSet: (services: PlanService[], on: boolean) => void;
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
      />
      {expanded &&
        environment.services.map((s) => (
          <ServiceRows
            key={s.sourceId}
            service={s}
            checked={chosen.has(s.sourceId)}
            onCheckedChange={(v) => onSet([s], v)}
          />
        ))}
    </>
  );
}

function ServiceRows({
  service,
  checked,
  onCheckedChange,
}: {
  service: PlanService;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  const Icon = service.targetKind === "database" ? Database : Layers;
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
        right={
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
  right,
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
  right?: React.ReactNode;
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
      {right && <div className="flex shrink-0 items-center">{right}</div>}
    </div>
  );
}
