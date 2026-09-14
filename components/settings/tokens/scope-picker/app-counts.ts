import type {
  ScopeTreeApp,
  ScopeTreeFolder,
  ScopeTreeTeam,
} from "@/lib/data/tokens/scope-tree";

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// envMeta - "Default · 4 apps", or just the count. An empty environment still shows.
export const envMeta = (e: { isDefault: boolean; apps: unknown[] }) =>
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

// folderMeta - how many apps a folder holds, all the way down.
export const folderMeta = (f: ScopeTreeFolder) => plural(countApps(f), "app");

// projectMeta - how many apps a project holds, across its environments and folders.
export const projectMeta = (p: ScopeTreeTeam["projects"][number]) =>
  plural(countApps(p), "app");

// teamMeta - how many apps a team holds, everywhere inside it.
export const teamMeta = (t: ScopeTreeTeam) =>
  plural(
    t.projects.reduce((n, p) => n + countApps(p), 0) +
      t.folders.reduce((n, f) => n + countApps(f), 0) +
      t.looseApps.length,
    "app",
  );
