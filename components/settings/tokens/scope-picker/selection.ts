import type {
  ScopeTreeFolder,
  ScopeTreeTeam,
} from "@/lib/data/tokens/scope-tree";

// ScopeNode - one node, as ScopePicker.renderMeta sees it.
export interface ScopeNode {
  kind: "team" | "project" | "folder" | "app";
  id: string;
  name: string;
  // Ticked, or covered by a ticked ancestor.
  checked: boolean;
}

export interface ScopeSelection {
  teamIds: string[];
  projectIds: string[];
  // Environments of a project. Absent on a token, which cannot name one.
  environmentIds?: string[];
  folderIds: string[];
  appIds: string[];
}

// everythingSelection - every top-level node of the tree, ticked: "all of it",
// said in the only vocabulary a picker with no team checkbox has.
export function everythingSelection(tree: ScopeTreeTeam[]): ScopeSelection {
  return {
    teamIds: [],
    projectIds: tree.flatMap((t) => t.projects.map((p) => p.id)),
    folderIds: tree.flatMap((t) => t.folders.map((f) => f.id)),
    appIds: tree.flatMap((t) => t.looseApps.map((a) => a.id)),
  };
}

// coversEverything - whether a selection leaves nothing out, which is what gets
// STORED as unrestricted, so that a project created tomorrow is included too.
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

// openForSelection - open whatever already holds a selection, so an edit lands
// on what it edits - plus every TEAM, always.
export function openForSelection(
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
