/**
 * Overview drill-in URL builders. Client components import from here as well, so
 * the two sides can never disagree on the URL shape.
 */

/**
 * The Overview drill-in an action was started from — an open folder, or a
 * project's selected environment (ADR-0009: never both).
 */
export interface OverviewPlacement {
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}

/** Build the Overview URL that opens a folder, preserving the list/grid view. */
export function folderHref(id: string, view: "grid" | "list" = "grid"): string {
  const params = new URLSearchParams();
  params.set("folder", id);
  if (view === "list") params.set("view", "list");
  return `/?${params.toString()}`;
}

/** Build the Overview URL that opens a project, preserving the list/grid view. */
export function projectHref(
  id: string,
  view: "grid" | "list" = "grid",
): string {
  const params = new URLSearchParams();
  params.set("project", id);
  if (view === "list") params.set("view", "list");
  return `/?${params.toString()}`;
}

/** The Overview URL a placement came from — where "back" should land. */
export function placementHref(
  p: OverviewPlacement | null | undefined,
  view: "grid" | "list" = "grid",
): string {
  if (p?.folderId) return folderHref(p.folderId, view);
  if (p?.projectId) {
    const params = new URLSearchParams();
    params.set("project", p.projectId);
    if (p.environmentId) params.set("env", p.environmentId);
    if (view === "list") params.set("view", "list");
    return `/?${params.toString()}`;
  }
  return view === "list" ? "/?view=list" : "/";
}

/** The drill-in params, appended to a creation flow's URL (empty when top level). */
function placementParams(
  p: OverviewPlacement | null | undefined,
): URLSearchParams {
  const params = new URLSearchParams();
  if (p?.folderId) params.set("folder", p.folderId);
  else if (p?.projectId) {
    params.set("project", p.projectId);
    if (p.environmentId) params.set("env", p.environmentId);
  }
  return params;
}

/** Link to the new-app wizard, carrying the drill-in it was opened from. */
export function newAppHref(
  p?: OverviewPlacement | null,
  opts?: { template?: string; variant?: string },
): string {
  const params = placementParams(p);
  if (opts?.template) params.set("template", opts.template);
  if (opts?.variant) params.set("variant", opts.variant);
  const qs = params.toString();
  return qs ? `/new?${qs}` : "/new";
}

/**
 * Link to a template's page, carrying the drill-in and, optionally, which
 * variant of the family to show. The variant rides the URL so the choice is
 * shareable and the page stays a server component.
 */
export function templateHref(
  slug: string,
  p?: OverviewPlacement | null,
  variant?: string,
): string {
  const params = placementParams(p);
  if (variant) params.set("variant", variant);
  const qs = params.toString();
  return qs ? `/templates/${slug}?${qs}` : `/templates/${slug}`;
}

/** Link to the template catalogue, carrying the drill-in it was opened from. */
export function templatesHref(p?: OverviewPlacement | null): string {
  const qs = placementParams(p).toString();
  return qs ? `/templates?${qs}` : "/templates";
}

/**
 * Read a placement back out of a page's `searchParams` (the same `?folder=` /
 * `?project=` / `?env=` grammar the Overview uses).
 */
export function placementFromSearchParams(sp: {
  folder?: string | string[];
  project?: string | string[];
  env?: string | string[];
}): OverviewPlacement {
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v) || null;
  const folderId = one(sp.folder);
  if (folderId) return { folderId };
  const projectId = one(sp.project);
  return projectId ? { projectId, environmentId: one(sp.env) } : {};
}
