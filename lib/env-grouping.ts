/**
 * Folding the Variables page's aggregate "App" tab into Project sections.
 *
 * The tab holds every variable of every app in ONE flat row list (that is what
 * lets its filters cut across cards and its sort order the whole page). This is
 * the last step: the surviving rows are folded back into Project → App buckets,
 * which is what the collapsible sections render.
 *
 * Kept pure and UI-free on purpose — the component around it cannot be tested in
 * this repo (no renderer in the `node --test` harness), so the grouping, the
 * ordering and the Top level bucket live here where they can be.
 */

/** The section key of every App that belongs to no Project. */
export const TOP_LEVEL = "__top_level__";

/** What that section is CALLED. The Project facet's option says "No project"
 *  (with a "top level" hint); a section header is not a filter — it names the
 *  place, and the place is the top level. */
export const TOP_LEVEL_NAME = "Top level";

/** The least an App must carry to be grouped: who it is, and where it lives. */
export interface GroupableApp {
  id: string;
  name: string;
  projectId: string | null;
}

/** A Project as the grouping needs it — enough to name and paint its section. */
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
  /** The Project's id, or {@link TOP_LEVEL}. Also the collapse-state key. */
  id: string;
  name: string;
  color: string | null;
  apps: AppBucket<R>[];
  /** Rows across every app of the section — what a COLLAPSED header counts. */
  rowCount: number;
}

/**
 * Fold rows into Project → App buckets IN PASS ORDER: the first row of a bucket
 * IS its extreme (the newest one under "Recently modified"), so grouping in the
 * order the sort left the rows carries that sort up to the sections and the cards
 * for free.
 *
 * `byName` re-sorts both levels A→Z instead, with Top level last. That is what
 * the "Sort by key" mode wants — there the ordering is about the KEYS, and the
 * sections should just sit still rather than reshuffle behind the table.
 *
 * A project or an app with no surviving row never appears: an empty card is pure
 * noise on a page whose whole subject is variables.
 */
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
        // A project the caller never passed (deleted from under the page, or one
        // the read didn't return) still gets a section: dropping its apps would
        // silently take their variables off a page that says it shows them all.
        name:
          sectionId === TOP_LEVEL ? TOP_LEVEL_NAME : (project?.name ?? "Project"),
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

  if (opts.byName) {
    out.sort(
      (a, b) =>
        Number(a.id === TOP_LEVEL) - Number(b.id === TOP_LEVEL) ||
        a.name.localeCompare(b.name),
    );
    for (const section of out) {
      section.apps.sort((a, b) => a.app.name.localeCompare(b.app.name));
    }
  }
  return out;
}
