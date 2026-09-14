"use client";

import * as React from "react";
import { filterScopeTree } from "@/lib/token-scope-search";
import type {
  ScopeTreeApp,
  ScopeTreeFolder,
  ScopeTreeTeam,
} from "@/lib/data/tokens/scope-tree";
import {
  coversEverything,
  everythingSelection,
  openForSelection,
  type ScopeSelection,
} from "./selection";

// Everything under a node becomes redundant the moment the node is ticked.
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

export interface ScopePickerState {
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  shown: ScopeTreeTeam[];
  teams: Set<string>;
  projects: Set<string>;
  environments: Set<string>;
  folders: Set<string>;
  apps: Set<string>;
  isOpen: (id: string) => boolean;
  toggleOpen: (id: string) => void;
  toggleTeam: (team: ScopeTreeTeam, on: boolean) => void;
  toggleProject: (
    project: ScopeTreeTeam["projects"][number],
    on: boolean,
    covered: boolean,
  ) => void;
  toggleFolder: (
    folder: ScopeTreeFolder,
    on: boolean,
    covered: boolean,
  ) => void;
  toggleEnvironment: (
    env: { id: string; apps: ScopeTreeApp[] },
    on: boolean,
    covered: boolean,
  ) => void;
  toggleApp: (appId: string, on: boolean, covered: boolean) => void;
  allOn: boolean;
  tickAll: (on: boolean) => void;
}

// useScopePicker - the picker's search, expansion and selection state, and the
// clamp rules that keep a ticked ancestor from contradicting what is under it.
export function useScopePicker({
  tree,
  selection,
  onChange,
  disabled,
  teamPickable,
}: {
  tree: ScopeTreeTeam[];
  selection: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  disabled: boolean;
  teamPickable: boolean;
}): ScopePickerState {
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
  // While searching every surviving branch is open - a hit three folders deep is
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

  function toggleFolder(
    folder: ScopeTreeFolder,
    on: boolean,
    covered: boolean,
  ) {
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

  return {
    query,
    setQuery,
    shown,
    teams,
    projects,
    environments,
    folders,
    apps,
    isOpen,
    toggleOpen,
    toggleTeam,
    toggleProject,
    toggleFolder,
    toggleEnvironment,
    toggleApp,
    allOn,
    tickAll,
  };
}
