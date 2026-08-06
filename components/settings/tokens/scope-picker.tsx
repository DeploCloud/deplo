"use client";

import * as React from "react";
import { Boxes, ChevronRight, FolderTree, Folder, Box, Search, X } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { LogoImage } from "@/components/shared/project-logo";
import { Input } from "@/components/ui/input";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import { filterScopeTree } from "@/lib/token-scope-search";
import type {
  ScopeTreeApp,
  ScopeTreeFolder,
  ScopeTreeTeam,
} from "@/lib/data/tokens";

/** One node, as {@link ScopePicker.renderMeta} sees it. */
export interface ScopeNode {
  kind: "team" | "project" | "folder" | "app";
  id: string;
  name: string;
  /** Ticked, or covered by a ticked ancestor. */
  checked: boolean;
}

export interface ScopeSelection {
  teamIds: string[];
  projectIds: string[];
  /** Environments of a project. Absent on a token, which cannot name one. */
  environmentIds?: string[];
  folderIds: string[];
  appIds: string[];
}

/**
 * What an API token may reach, as the tree it actually is: teams, then their
 * projects and folders, then the apps inside them, folders nesting as deep as
 * they do on the Overview.
 *
 * One rule makes the whole control readable — ticking a node grants everything
 * under it, now and later. So a whole team is one click, a whole folder is one
 * click, and a single app is one click, and the deeper boxes go
 * checked-and-disabled to show they are already covered rather than silently
 * disagreeing with their parent.
 *
 * Nothing ticked means unrestricted. That is deliberate: an empty scope with a
 * separate "all / specific" radio above it is two controls for one decision.
 */
export function ScopePicker({
  tree,
  selection,
  onChange,
  disabled = false,
  info = "What this token can reach. Tick a team for all of it, a project or a folder for everything inside it, or single apps. Tick nothing and it reaches everything you can.",
  emptyNote = "You aren't in any team yet, so there is nothing to narrow this token to.",
  renderMeta,
  teamPickable = true,
}: {
  tree: ScopeTreeTeam[];
  selection: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  disabled?: boolean;
  /**
   * Whether a whole TEAM can be ticked. False for the ROLE editor, where a role
   * already belongs to exactly one team and a scope only ever names a project, a
   * folder or an app. A team checkbox there would be a second way to say "no
   * limit", which is what ticking nothing already says.
   */
  teamPickable?: boolean;
  /** The heading's tooltip. */
  info?: React.ReactNode;
  /** Shown instead of the tree when there is nothing to pick from. */
  emptyNote?: React.ReactNode;
  /**
   * An extra control on the right of a row — the per-node affordance the user
   * editor hangs its capability sets off. Rendered OUTSIDE the row's `<label>`,
   * so clicking it doesn't toggle the checkbox next to it.
   */
  renderMeta?: (node: ScopeNode) => React.ReactNode;
}) {
  const teams = new Set(selection.teamIds);
  const projects = new Set(selection.projectIds);
  const environments = new Set(selection.environmentIds ?? []);
  const folders = new Set(selection.folderIds);
  const apps = new Set(selection.appIds);

  const [query, setQuery] = React.useState("");
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matched = React.useMemo(
    () => (terms.length === 0 ? null : filterScopeTree(tree, terms)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, query],
  );
  const shown = matched ?? tree;
  const searching = matched !== null;

  const [open, setOpen] = React.useState<Set<string>>(() =>
    openForSelection(tree, selection),
  );
  // While searching every surviving branch is open — a hit three folders deep is
  // useless if you still have to find and expand its ancestors.
  const isOpen = (id: string) => searching || open.has(id);
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
    environments?: Set<string>;
    folders: Set<string>;
    apps: Set<string>;
  }) {
    onChange({
      teamIds: [...next.teams],
      projectIds: [...next.projects],
      environmentIds: [...(next.environments ?? environments)],
      folderIds: [...next.folders],
      appIds: [...next.apps],
    });
  }

  /** Everything under a node becomes redundant the moment the node is ticked. */
  function clearBelow(
    node: {
      environments?: { id: string; apps: ScopeTreeApp[] }[];
      folders: ScopeTreeFolder[];
      apps: ScopeTreeApp[];
    },
    p: Set<string>,
    f: Set<string>,
    a: Set<string>,
    e?: Set<string>,
  ) {
    for (const app of node.apps) a.delete(app.id);
    for (const env of node.environments ?? []) {
      e?.delete(env.id);
      for (const app of env.apps) a.delete(app.id);
    }
    for (const folder of node.folders) {
      f.delete(folder.id);
      clearBelow(folder, p, f, a, e);
    }
  }

  function toggleTeam(team: ScopeTreeTeam, on: boolean) {
    if (disabled || !teamPickable) return;
    const t = new Set(teams);
    const p = new Set(projects);
    const e = new Set(environments);
    const f = new Set(folders);
    const a = new Set(apps);
    if (on) {
      t.add(team.id);
      for (const proj of team.projects) {
        p.delete(proj.id);
        clearBelow(proj, p, f, a, e);
      }
      clearBelow({ folders: team.folders, apps: team.looseApps }, p, f, a, e);
      setOpen((prev) => new Set(prev).add(team.id));
    } else t.delete(team.id);
    emit({ teams: t, projects: p, environments: e, folders: f, apps: a });
  }

  function toggleProject(
    project: ScopeTreeTeam["projects"][number],
    on: boolean,
    covered: boolean,
  ) {
    if (disabled || covered) return;
    const p = new Set(projects);
    const e = new Set(environments);
    const f = new Set(folders);
    const a = new Set(apps);
    if (on) {
      p.add(project.id);
      clearBelow(project, p, f, a, e);
    } else p.delete(project.id);
    emit({ teams, projects: p, environments: e, folders: f, apps: a });
  }

  function toggleFolder(folder: ScopeTreeFolder, on: boolean, covered: boolean) {
    if (disabled || covered) return;
    const p = new Set(projects);
    const f = new Set(folders);
    const a = new Set(apps);
    if (on) {
      f.add(folder.id);
      clearBelow(folder, p, f, a);
    } else f.delete(folder.id);
    emit({ teams, projects: p, folders: f, apps: a });
  }

  function toggleEnvironment(
    env: { id: string; apps: ScopeTreeApp[] },
    on: boolean,
    covered: boolean,
  ) {
    if (disabled || covered) return;
    const e = new Set(environments);
    const a = new Set(apps);
    if (on) {
      e.add(env.id);
      for (const app of env.apps) a.delete(app.id);
    } else e.delete(env.id);
    emit({ teams, projects, environments: e, folders, apps: a });
  }

  function toggleApp(appId: string, on: boolean, covered: boolean) {
    if (disabled || covered) return;
    const a = new Set(apps);
    if (on) a.add(appId);
    else a.delete(appId);
    emit({ teams, projects, folders, apps: a });
  }

  /** Render a folder and everything under it, at `depth`. */
  function renderFolder(
    folder: ScopeTreeFolder,
    depth: number,
    covered: boolean,
  ): React.ReactNode {
    const on = covered || folders.has(folder.id);
    const expanded = isOpen(folder.id);
    const hasChildren = folder.folders.length > 0 || folder.apps.length > 0;
    return (
      <div key={folder.id}>
        <Row
          depth={depth}
          mark={<TintedMark icon={Folder} color={folder.color} />}
          label={folder.name}
          meta={folderMeta(folder)}
          checked={on}
          disabled={disabled || covered}
          onCheckedChange={(v) => toggleFolder(folder, v, covered)}
          expandable={hasChildren}
          expanded={expanded}
          onToggleExpand={() => toggleOpen(folder.id)}
          id={`scope-folder-${folder.id}`}
          right={renderMeta?.({
            kind: "folder",
            id: folder.id,
            name: folder.name,
            checked: on,
          })}
        />
        {expanded && (
          <>
            {folder.folders.map((child) =>
              renderFolder(child, depth + 1, on),
            )}
            {folder.apps.map((app) => (
              <Row
                key={app.id}
                depth={depth + 1}
                mark={<AppMark logo={app.logo} />}
                label={app.name}
                meta={app.slug}
                checked={on || apps.has(app.id)}
                disabled={disabled || on}
                onCheckedChange={(v) => toggleApp(app.id, v, on)}
                id={`scope-app-${app.id}`}
                right={renderMeta?.({
                  kind: "app",
                  id: app.id,
                  name: app.name,
                  checked: on || apps.has(app.id),
                })}
              />
            ))}
          </>
        )}
      </div>
    );
  }

  // "All of it" is said in the vocabulary this picker has: whole teams when a
  // team can be ticked, else every top-level node of the one team it edits.
  const allOn = teamPickable
    ? tree.every((t) => teams.has(t.id))
    : coversEverything(tree, selection);
  function tickAll(on: boolean) {
    const picked =
      !on || tree.length === 0
        ? { teamIds: [], projectIds: [], folderIds: [], appIds: [] }
        : teamPickable
          ? {
              teamIds: tree.map((t) => t.id),
              projectIds: [],
              folderIds: [],
              appIds: [],
            }
          : everythingSelection(tree);
    // Nothing below a ticked top-level node needs saying, and the field must
    // stay absent for a consumer that cannot express an environment.
    onChange({
      ...picked,
      environmentIds: selection.environmentIds === undefined ? undefined : [],
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-medium">Scope</h3>
        <InfoTip content={info} />
        {tree.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => tickAll(!allOn)}
            className="ml-auto h-7 text-xs"
          >
            {allOn ? "Unselect all" : "Select all"}
          </Button>
        )}
      </div>

      {tree.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyNote}</p>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search teams, projects, folders and apps"
              aria-label="Search the scope"
              className="pl-9 pr-9"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear the search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {shown.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing matches &ldquo;{query}&rdquo;.
            </div>
          ) : (
            <div className="max-h-96 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
              {shown.map((team) => {
                const teamOn = teams.has(team.id);
                const expanded = isOpen(team.id);
                const hasChildren =
                  team.projects.length > 0 ||
                  team.folders.length > 0 ||
                  team.looseApps.length > 0;
                return (
                  <div key={team.id}>
                    <Row
                      depth={0}
                      mark={<TeamMark name={team.name} />}
                      label={team.name}
                      meta={teamMeta(team)}
                      checkbox={teamPickable}
                      checked={teamOn}
                      disabled={disabled}
                      onCheckedChange={(v) => toggleTeam(team, v)}
                      expandable={hasChildren}
                      expanded={expanded}
                      onToggleExpand={() => toggleOpen(team.id)}
                      id={`scope-team-${team.id}`}
                      right={renderMeta?.({
                        kind: "team",
                        id: team.id,
                        name: team.name,
                        checked: teamOn,
                      })}
                    />
                    {expanded && (
                      <>
                        {team.projects.map((project) => {
                          const projOn = teamOn || projects.has(project.id);
                          const projExpanded = isOpen(project.id);
                          const projHasChildren =
                            project.folders.length > 0 || project.apps.length > 0;
                          return (
                            <div key={project.id}>
                              <Row
                                depth={1}
                                mark={
                                  <TintedMark
                                    icon={FolderTree}
                                    color={project.color}
                                  />
                                }
                                label={project.name}
                                meta={projectMeta(project)}
                                checked={projOn}
                                // Covered by its team: ticked, not editable
                                // here, so the tree never contradicts itself.
                                disabled={disabled || teamOn}
                                onCheckedChange={(v) =>
                                  toggleProject(project, v, teamOn)
                                }
                                expandable={projHasChildren}
                                expanded={projExpanded}
                                onToggleExpand={() => toggleOpen(project.id)}
                                id={`scope-project-${project.id}`}
                                right={renderMeta?.({
                                  kind: "project",
                                  id: project.id,
                                  name: project.name,
                                  checked: projOn,
                                })}
                              />
                              {projExpanded && (
                                <>
                                  {/* Environments first: ADR-0009 makes the
                                      environment the primary axis of a project,
                                      and folders are their siblings, never
                                      their children. */}
                                  {/* Only a consumer whose selection carries
                                      the field can express an environment: the
                                      token scope and the per-node grant have
                                      nowhere to put one, and an offered tick
                                      that the save drops is worse than no tick.
                                      The optional field IS the discriminator. */}
                                  {(selection.environmentIds === undefined
                                    ? []
                                    : project.environments
                                  ).map((env) => {
                                    const envOn =
                                      projOn || environments.has(env.id);
                                    const envExpanded = isOpen(env.id);
                                    return (
                                      <div key={env.id}>
                                        <Row
                                          depth={2}
                                          mark={
                                            <Boxes className="size-3.5 text-muted-foreground" />
                                          }
                                          label={env.name}
                                          meta={envMeta(env)}
                                          checked={envOn}
                                          disabled={disabled || projOn}
                                          onCheckedChange={(v) =>
                                            toggleEnvironment(env, v, projOn)
                                          }
                                          expandable={env.apps.length > 0}
                                          expanded={envExpanded}
                                          onToggleExpand={() => toggleOpen(env.id)}
                                          id={`scope-env-${env.id}`}
                                        />
                                        {envExpanded &&
                                          env.apps.map((app) => (
                                            <Row
                                              key={app.id}
                                              depth={3}
                                              mark={<AppMark logo={app.logo} />}
                                              label={app.name}
                                              meta={app.slug}
                                              checked={envOn || apps.has(app.id)}
                                              disabled={disabled || envOn}
                                              onCheckedChange={(v) =>
                                                toggleApp(app.id, v, envOn)
                                              }
                                              id={`scope-app-${app.id}`}
                                            />
                                          ))}
                                      </div>
                                    );
                                  })}
                                  {project.folders.map((f) =>
                                    renderFolder(f, 2, projOn),
                                  )}
                                  {/* When environments are not expressible the
                                      rows above are not drawn, so the apps that
                                      live in them are folded in here — hiding
                                      the level must never hide its contents. */}
                                  {(selection.environmentIds === undefined
                                    ? [
                                        ...project.environments.flatMap(
                                          (e) => e.apps,
                                        ),
                                        ...project.apps,
                                      ]
                                    : project.apps
                                  ).map((app) => (
                                    <Row
                                      key={app.id}
                                      depth={2}
                                      mark={<AppMark logo={app.logo} />}
                                      label={app.name}
                                      meta={app.slug}
                                      checked={projOn || apps.has(app.id)}
                                      disabled={disabled || projOn}
                                      onCheckedChange={(v) =>
                                        toggleApp(app.id, v, projOn)
                                      }
                                      id={`scope-app-${app.id}`}
                                      right={renderMeta?.({
                                        kind: "app",
                                        id: app.id,
                                        name: app.name,
                                        checked: projOn || apps.has(app.id),
                                      })}
                                    />
                                  ))}
                                </>
                              )}
                            </div>
                          );
                        })}
                        {team.folders.map((f) => renderFolder(f, 1, teamOn))}
                        {team.looseApps.map((app) => (
                          <Row
                            key={app.id}
                            depth={1}
                            mark={<AppMark logo={app.logo} />}
                            label={app.name}
                            meta={app.slug}
                            checked={teamOn || apps.has(app.id)}
                            disabled={disabled || teamOn}
                            onCheckedChange={(v) =>
                              toggleApp(app.id, v, teamOn)
                            }
                            id={`scope-app-${app.id}`}
                            right={renderMeta?.({
                              kind: "app",
                              id: app.id,
                              name: app.name,
                              checked: teamOn || apps.has(app.id),
                            })}
                          />
                        ))}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Every top-level node of the tree, ticked — "all of it", said in the only
 * vocabulary a picker with no team checkbox has.
 *
 * The editors that start from everything (a role, a member) show this rather
 * than an empty tree: "nothing ticked" is a fine way to STORE unrestricted, and
 * a terrible way to show it, because the one thing an admin wants to do next is
 * untick the parts this person should not have.
 */
export function everythingSelection(tree: ScopeTreeTeam[]): ScopeSelection {
  return {
    teamIds: [],
    projectIds: tree.flatMap((t) => t.projects.map((p) => p.id)),
    folderIds: tree.flatMap((t) => t.folders.map((f) => f.id)),
    appIds: tree.flatMap((t) => t.looseApps.map((a) => a.id)),
  };
}

/**
 * Whether a selection leaves nothing out — which is what gets STORED as
 * unrestricted, so that a project created tomorrow is included too.
 *
 * Asked of the top level only: everything under a ticked node follows it, and a
 * selection that ticked every app one by one instead of their project reaches
 * the same apps today but is a genuine limit tomorrow.
 */
export function coversEverything(
  tree: ScopeTreeTeam[],
  selection: ScopeSelection,
): boolean {
  const all = everythingSelection(tree);
  const has = (picked: string[], required: string[]) =>
    required.every((id) => picked.includes(id));
  return (
    has(selection.projectIds, all.projectIds) &&
    has(selection.folderIds, all.folderIds) &&
    has(selection.appIds, all.appIds)
  );
}

/**
 * Open whatever already holds a selection, so an edit lands on what it edits —
 * plus every TEAM, always. A collapsed team row is a dead end on first sight,
 * and most instances have exactly one; its projects and folders stay closed so
 * the list opens at a readable size.
 */
function openForSelection(
  tree: ScopeTreeTeam[],
  selection: ScopeSelection,
): Set<string> {
  const picked = new Set([
    ...selection.projectIds,
    ...selection.folderIds,
    ...selection.appIds,
  ]);
  const out = new Set<string>(tree.map((t) => t.id));
  const walkFolder = (f: ScopeTreeFolder): boolean => {
    const inside =
      f.apps.some((a) => picked.has(a.id)) ||
      f.folders.map(walkFolder).some(Boolean);
    if (picked.has(f.id) || inside) {
      if (inside) out.add(f.id);
      return true;
    }
    return false;
  };
  for (const team of tree) {
    let touched = false;
    for (const p of team.projects) {
      const inside =
        p.apps.some((a) => picked.has(a.id)) ||
        p.folders.map(walkFolder).some(Boolean);
      if (inside) out.add(p.id);
      if (picked.has(p.id) || inside) touched = true;
    }
    team.folders.forEach(walkFolder);
    void touched;
  }
  return out;
}

/**
 * A team has no logo of its own — its identity everywhere in deplo is the
 * two-letter avatar the topbar switcher shows, so the picker shows the same one
 * rather than inventing a generic glyph for it.
 */
function TeamMark({ name }: { name: string }) {
  return (
    <Avatar className="size-4">
      <AvatarFallback className="bg-foreground text-[8px] text-background">
        {name.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** An app's own logo when it has one, else the generic app glyph. */
function AppMark({ logo }: { logo: string | null }) {
  return (
    <LogoImage
      src={logo}
      size={16}
      fallback={<Box className="size-3" />}
      className="rounded-sm bg-transparent"
    />
  );
}

/** Projects and folders carry a colour, not an image — tint their glyph with it. */
function TintedMark({
  icon: Icon,
  color,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  color: string | null;
}) {
  return (
    <Icon
      className={cn("size-3.5", !color && "text-muted-foreground")}
      style={color ? { color } : undefined}
    />
  );
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** "Default · 4 apps", or just the count. An empty environment still shows. */
const envMeta = (e: { isDefault: boolean; apps: unknown[] }) =>
  `${e.isDefault ? "Default · " : ""}${
    e.apps.length === 0 ? "No apps" : plural(e.apps.length, "app")
  }`;

function countApps(node: {
  environments?: { apps: ScopeTreeApp[] }[];
  folders: ScopeTreeFolder[];
  apps: ScopeTreeApp[];
}): number {
  return (
    node.apps.length +
    (node.environments ?? []).reduce((n, e) => n + e.apps.length, 0) +
    node.folders.reduce((n, f) => n + countApps(f), 0)
  );
}
const folderMeta = (f: ScopeTreeFolder) => plural(countApps(f), "app");
const projectMeta = (p: ScopeTreeTeam["projects"][number]) =>
  plural(countApps(p), "app");
const teamMeta = (t: ScopeTreeTeam) =>
  plural(
    t.projects.reduce((n, p) => n + countApps(p), 0) +
      t.folders.reduce((n, f) => n + countApps(f), 0) +
      t.looseApps.length,
    "app",
  );

function Row({
  depth,
  mark,
  label,
  meta,
  checkbox = true,
  checked,
  disabled,
  onCheckedChange,
  expandable = false,
  expanded = false,
  onToggleExpand,
  id,
  right,
}: {
  depth: number;
  /** The node's own identity: an avatar, a logo, or a tinted glyph. */
  mark: React.ReactNode;
  label: string;
  meta?: string;
  /** False renders the row as a header: nothing to tick, only children to open. */
  checkbox?: boolean;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (on: boolean) => void;
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  id: string;
  /** An interactive cell after the label. OUTSIDE the label, or clicking it
   *  would toggle the checkbox. */
  right?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-2 pr-3",
        depth === 0 && "bg-muted/20",
      )}
      // Indent by depth rather than by a class per level: folders nest as deep
      // as the Overview lets them, so there is no fixed set of levels.
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
      {checkbox ? (
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(v) => onCheckedChange(v === true)}
        />
      ) : (
        <span className="size-4" aria-hidden />
      )}
      <label
        htmlFor={id}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2",
          checkbox && !disabled && "cursor-pointer",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {mark}
        </span>
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
