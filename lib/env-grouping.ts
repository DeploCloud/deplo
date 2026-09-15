export const TOP_LEVEL = "__top_level__";

export const TOP_LEVEL_NAME = "Standalone";

export interface GroupableApp {
  id: string;
  name: string;
  projectId: string | null;
}

export interface GroupProject {
  id: string;
  name: string;
  color?: string | null;
}

export interface AppBucket<R extends { app: GroupableApp }> {
  app: R["app"];
  rows: R[];
}

export interface ProjectBucket<R extends { app: GroupableApp }> {
  id: string;
  name: string;
  color: string | null;
  apps: AppBucket<R>[];
  rowCount: number;
}

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
