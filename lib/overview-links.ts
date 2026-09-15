export interface OverviewPlacement {
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}

export function folderHref(id: string, view: "grid" | "list" = "grid"): string {
  const params = new URLSearchParams();
  params.set("folder", id);
  if (view === "list") params.set("view", "list");
  return `/?${params.toString()}`;
}

export function projectHref(
  id: string,
  view: "grid" | "list" = "grid",
): string {
  const params = new URLSearchParams();
  params.set("project", id);
  if (view === "list") params.set("view", "list");
  return `/?${params.toString()}`;
}

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

export function newAppHref(
  p?: OverviewPlacement | null,
  opts?: {
    template?: string;
    variant?: string;
    source?: string;
  },
): string {
  const params = placementParams(p);
  if (opts?.template) params.set("template", opts.template);
  if (opts?.variant) params.set("variant", opts.variant);
  if (opts?.source) params.set("source", opts.source);
  const qs = params.toString();
  return qs ? `/new?${qs}` : "/new";
}

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

export function templatesHref(p?: OverviewPlacement | null): string {
  const qs = placementParams(p).toString();
  return qs ? `/templates?${qs}` : "/templates";
}

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
