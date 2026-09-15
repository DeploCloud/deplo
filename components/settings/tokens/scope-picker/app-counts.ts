import type {
  ScopeTreeApp,
  ScopeTreeFolder,
  ScopeTreeTeam,
} from "@/lib/data/tokens/scope-tree";

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

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

export const folderMeta = (f: ScopeTreeFolder) => plural(countApps(f), "app");

export const projectMeta = (p: ScopeTreeTeam["projects"][number]) =>
  plural(countApps(p), "app");

export const teamMeta = (t: ScopeTreeTeam) =>
  plural(
    t.projects.reduce((n, p) => n + countApps(p), 0) +
      t.folders.reduce((n, f) => n + countApps(f), 0) +
      t.looseApps.length,
    "app",
  );
