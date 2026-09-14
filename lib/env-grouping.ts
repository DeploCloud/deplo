/** The section key of every App that belongs to no Project. */
export const TOP_LEVEL = "__top_level__";

// Not the Project facet's "No project" on purpose: a section header names what is inside, not a filter.
// What that section is CALLED: those apps stand on their own, outside every project.
export const TOP_LEVEL_NAME = "Standalone";

/** The least an App must carry to be grouped: who it is, and where it lives. */
export interface GroupableApp {
  id: string;
  name: string;
  projectId: string | null;
}

/** A Project as the grouping needs it - enough to name and paint its section. */
export interface GroupProject {
  id: string;
  name: string;
  color?: string | null;
}

/** One App's card inside a section: the app, and the rows that survived. */
export interface AppBucket<R extends { app: GroupableApp }> {
  app: R["app"];
  rows: R[];
}

/** One collapsible Project section. */
export interface ProjectBucket<R extends { app: GroupableApp }> {
  id: string;
  name: string;
  color: string | null;
  apps: AppBucket<R>[];
  rowCount: number;
}

// Fold rows into Project → App buckets, in `projects` order, with Standalone last.
export function groupRowsByProject<R extends { app: GroupableApp }>(
  rows: readonly R[],
  projects: readonly GroupProject[],
  opts: { byName?: boolean } = {},
): ProjectBucket<R>[] {
  const projectById = new Map(projects.map((p) => [p.id, p] as const));
  const sections = new Map<string, ProjectBucket<R>>();
  const appBuckets = new Map<string, AppBucket<R>>();
  const out: ProjectBucket<R>[] = [];

  for (const row of rows) {
    const sectionId = row.app.projectId ?? TOP_LEVEL;
    let section = sections.get(sectionId);
    if (!section) {
      const project = row.app.projectId
        ? projectById.get(row.app.projectId)
        : undefined;
      section = {
        id: sectionId,
        // A project the caller never passed still gets a section: dropping its apps would hide their variables.
        name:
          sectionId === TOP_LEVEL
            ? TOP_LEVEL_NAME
            : (project?.name ?? "Project"),
        color: project?.color ?? null,
        apps: [],
        rowCount: 0,
      };
      sections.set(sectionId, section);
      out.push(section);
    }
    // An App belongs to at most one Project, so its id is unique across sections.
    let bucket = appBuckets.get(row.app.id);
    if (!bucket) {
      bucket = { app: row.app, rows: [] };
      appBuckets.set(row.app.id, bucket);
      section.apps.push(bucket);
    }
    bucket.rows.push(row);
    section.rowCount += 1;
  }

  const rank = new Map(projects.map((p, i) => [p.id, i] as const));
  const rankOf = (section: ProjectBucket<R>) =>
    section.id === TOP_LEVEL
      ? Number.POSITIVE_INFINITY
      : (rank.get(section.id) ?? Number.MAX_SAFE_INTEGER);
  out.sort((a, b) => rankOf(a) - rankOf(b));

  if (opts.byName) {
    for (const section of out) {
      section.apps.sort((a, b) => a.app.name.localeCompare(b.app.name));
    }
  }
  return out;
}
