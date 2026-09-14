import type { ScopeTreeFolder, ScopeTreeTeam } from "./data/tokens/scope-tree";

const hit = (name: string, terms: string[]) =>
  terms.every((t) => name.toLowerCase().includes(t));

function filterFolder(
  folder: ScopeTreeFolder,
  terms: string[],
): ScopeTreeFolder | null {
  if (hit(folder.name, terms)) return folder;
  const folders = folder.folders
    .map((f) => filterFolder(f, terms))
    .filter((f): f is ScopeTreeFolder => f !== null);
  const apps = folder.apps.filter(
    (a) => hit(a.name, terms) || hit(a.slug, terms),
  );
  return folders.length || apps.length ? { ...folder, folders, apps } : null;
}

export function filterScopeTree(
  tree: ScopeTreeTeam[],
  terms: string[],
): ScopeTreeTeam[] {
  return tree
    .map((team) => {
      if (hit(team.name, terms)) return team;
      const projects = team.projects
        .map((p) => {
          if (hit(p.name, terms)) return p;
          const environments = p.environments
            .map((e) =>
              hit(e.name, terms)
                ? e
                : {
                    ...e,
                    apps: e.apps.filter(
                      (a) => hit(a.name, terms) || hit(a.slug, terms),
                    ),
                  },
            )
            .filter((e) => e.apps.length > 0 || hit(e.name, terms));
          const folders = p.folders
            .map((f) => filterFolder(f, terms))
            .filter((f): f is ScopeTreeFolder => f !== null);
          const apps = p.apps.filter(
            (a) => hit(a.name, terms) || hit(a.slug, terms),
          );
          return environments.length || folders.length || apps.length
            ? { ...p, environments, folders, apps }
            : null;
        })
        .filter((p): p is ScopeTreeTeam["projects"][number] => p !== null);
      const folders = team.folders
        .map((f) => filterFolder(f, terms))
        .filter((f): f is ScopeTreeFolder => f !== null);
      const looseApps = team.looseApps.filter(
        (a) => hit(a.name, terms) || hit(a.slug, terms),
      );
      return projects.length || folders.length || looseApps.length
        ? { ...team, projects, folders, looseApps }
        : null;
    })
    .filter((t): t is ScopeTreeTeam => t !== null);
}
