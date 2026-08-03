"use client";

import * as React from "react";
import { ChevronRight, Building2, FolderTree, Box } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import type { ScopeTreeTeam } from "@/lib/data/tokens";

export interface ScopeSelection {
  teamIds: string[];
  projectIds: string[];
  appIds: string[];
}

/**
 * What an API token may reach, as the tree it actually is: teams, then their
 * projects, then the apps inside them.
 *
 * One rule makes the whole control readable — ticking a node grants everything
 * under it, now and later. So a whole team is one click, a whole project is one
 * click, and a single app is one click, and the deeper boxes go checked-and-
 * disabled to show they are already covered rather than silently disagreeing
 * with their parent.
 *
 * Nothing ticked means unrestricted. That is deliberate: an empty scope with a
 * separate "all / specific" radio above it is two controls for one decision, and
 * the sentence under the tree says which one you are in at all times.
 */
export function ScopePicker({
  tree,
  selection,
  onChange,
  disabled = false,
}: {
  tree: ScopeTreeTeam[];
  selection: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  disabled?: boolean;
}) {
  const teams = new Set(selection.teamIds);
  const projects = new Set(selection.projectIds);
  const apps = new Set(selection.appIds);

  const [open, setOpen] = React.useState<Set<string>>(() => {
    // Open whatever already has a selection inside it, so an edit lands on what
    // it is editing instead of on a wall of collapsed rows.
    const s = new Set<string>();
    for (const t of tree) {
      const touched =
        t.projects.some((p) => projects.has(p.id) || p.apps.some((a) => apps.has(a.id))) ||
        t.looseApps.some((a) => apps.has(a.id));
      if (touched) {
        s.add(t.id);
        for (const p of t.projects)
          if (p.apps.some((a) => apps.has(a.id))) s.add(p.id);
      }
    }
    return s;
  });

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  function emit(next: {
    teams: Set<string>;
    projects: Set<string>;
    apps: Set<string>;
  }) {
    onChange({
      teamIds: [...next.teams],
      projectIds: [...next.projects],
      appIds: [...next.apps],
    });
  }

  /** Ticking a team covers everything under it, so its own rows are redundant. */
  function toggleTeam(team: ScopeTreeTeam, on: boolean) {
    if (disabled) return;
    const t = new Set(teams);
    const p = new Set(projects);
    const a = new Set(apps);
    if (on) {
      t.add(team.id);
      for (const proj of team.projects) {
        p.delete(proj.id);
        for (const app of proj.apps) a.delete(app.id);
      }
      for (const app of team.looseApps) a.delete(app.id);
      setOpen((prev) => new Set(prev).add(team.id));
    } else t.delete(team.id);
    emit({ teams: t, projects: p, apps: a });
  }

  function toggleProject(
    team: ScopeTreeTeam,
    project: ScopeTreeTeam["projects"][number],
    on: boolean,
  ) {
    if (disabled || teams.has(team.id)) return;
    const p = new Set(projects);
    const a = new Set(apps);
    if (on) {
      p.add(project.id);
      for (const app of project.apps) a.delete(app.id);
    } else p.delete(project.id);
    emit({ teams, projects: p, apps: a });
  }

  function toggleApp(covered: boolean, appId: string, on: boolean) {
    if (disabled || covered) return;
    const a = new Set(apps);
    if (on) a.add(appId);
    else a.delete(appId);
    emit({ teams, projects, apps: a });
  }

  const nothingPicked =
    teams.size === 0 && projects.size === 0 && apps.size === 0;
  const narrowed = projects.size > 0 || apps.size > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-medium">Scope</h3>
        <InfoTip content="What this token can reach. Tick a team for all of it, a project for every app in it, or single apps. Tick nothing and it reaches everything you can." />
      </div>

      {tree.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You aren&apos;t in any team yet, so there is nothing to narrow this
          token to.
        </p>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
          {tree.map((team) => {
            const teamOn = teams.has(team.id);
            const expanded = open.has(team.id);
            const hasChildren =
              team.projects.length > 0 || team.looseApps.length > 0;
            return (
              <div key={team.id}>
                <Row
                  depth={0}
                  icon={Building2}
                  label={team.name}
                  meta={
                    team.projects.length === 1
                      ? "1 project"
                      : `${team.projects.length} projects`
                  }
                  checked={teamOn}
                  disabled={disabled}
                  onCheckedChange={(v) => toggleTeam(team, v)}
                  expandable={hasChildren}
                  expanded={expanded}
                  onToggleExpand={() => toggleOpen(team.id)}
                  id={`scope-team-${team.id}`}
                />
                {expanded &&
                  team.projects.map((project) => {
                    const projOn = teamOn || projects.has(project.id);
                    const projExpanded = open.has(project.id);
                    return (
                      <div key={project.id}>
                        <Row
                          depth={1}
                          icon={FolderTree}
                          label={project.name}
                          meta={
                            project.apps.length === 1
                              ? "1 app"
                              : `${project.apps.length} apps`
                          }
                          checked={projOn}
                          // Covered by its team: shown ticked, not editable
                          // here, so the tree never contradicts itself.
                          disabled={disabled || teamOn}
                          onCheckedChange={(v) => toggleProject(team, project, v)}
                          expandable={project.apps.length > 0}
                          expanded={projExpanded}
                          onToggleExpand={() => toggleOpen(project.id)}
                          id={`scope-project-${project.id}`}
                        />
                        {projExpanded &&
                          project.apps.map((app) => (
                            <Row
                              key={app.id}
                              depth={2}
                              icon={Box}
                              label={app.name}
                              meta={app.slug}
                              checked={projOn || apps.has(app.id)}
                              disabled={disabled || projOn}
                              onCheckedChange={(v) =>
                                toggleApp(projOn, app.id, v)
                              }
                              id={`scope-app-${app.id}`}
                            />
                          ))}
                      </div>
                    );
                  })}
                {expanded && team.looseApps.length > 0 && (
                  <>
                    <p className="bg-muted/30 px-3 py-1.5 pl-11 text-xs text-muted-foreground">
                      Apps outside a project
                    </p>
                    {team.looseApps.map((app) => (
                      <Row
                        key={app.id}
                        depth={1}
                        icon={Box}
                        label={app.name}
                        meta={app.slug}
                        checked={teamOn || apps.has(app.id)}
                        disabled={disabled || teamOn}
                        onCheckedChange={(v) => toggleApp(teamOn, app.id, v)}
                        id={`scope-app-${app.id}`}
                      />
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {nothingPicked ? (
          <>
            <span className="font-medium text-foreground">
              Everything you can access.
            </span>{" "}
            This token reaches every team you belong to, and everything in it. It
            still can&apos;t do more than you can.
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">
              Limited to {describe(teams.size, projects.size, apps.size)}.
            </span>{" "}
            {narrowed
              ? "Naming a project or an app narrows the token inside its team, so team-wide permissions such as Manage members, Manage roles and Manage team settings stop applying there, even while they are ticked below."
              : "Whole teams, so every permission ticked below applies in all of them."}
          </>
        )}
      </p>
    </div>
  );
}

function describe(teams: number, projects: number, apps: number): string {
  const parts: string[] = [];
  if (teams > 0) parts.push(`${teams} ${teams === 1 ? "team" : "teams"}`);
  if (projects > 0)
    parts.push(`${projects} ${projects === 1 ? "project" : "projects"}`);
  if (apps > 0) parts.push(`${apps} ${apps === 1 ? "app" : "apps"}`);
  if (parts.length <= 1) return parts[0] ?? "nothing";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function Row({
  depth,
  icon: Icon,
  label,
  meta,
  checked,
  disabled,
  onCheckedChange,
  expandable = false,
  expanded = false,
  onToggleExpand,
  id,
}: {
  depth: 0 | 1 | 2;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  meta?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (on: boolean) => void;
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  id: string;
}) {
  const pad = ["pl-3", "pl-8", "pl-13"][depth];
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-2 pr-3",
        pad,
        depth === 0 && "bg-muted/20",
      )}
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
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
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
    </div>
  );
}
