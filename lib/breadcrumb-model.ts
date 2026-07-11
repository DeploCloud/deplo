/**
 * Pure model behind the topbar breadcrumb. Given the current location (pathname +
 * the Overview's ?folder=/?project= drill-in params) and a lightweight snapshot of
 * the team's folders / services / projects, it produces the ordered list of
 * breadcrumb SEGMENTS — each carrying a link (where clicking the name goes) and a
 * dropdown of sibling/child targets (where the ▾ takes you), Vercel/Windows-
 * Explorer style.
 *
 * Every services-tree location (browsing a folder/project on the Overview, or
 * anywhere inside a service) reads as one consistent path rooted at "Overview":
 *
 *   Overview ▾ / Folder ▾ / Subfolder ▾ / Service ▾ / Section ▾ / Subsection ▾
 *
 * No React, no DB, no "server-only" — so it renders on the server, hydrates on the
 * client, AND is unit-testable in isolation (lib/breadcrumb-model.test.ts). The
 * server data loader (lib/data/breadcrumb.ts) and the client renderer
 * (components/layout/breadcrumbs.tsx) both import from here so they can never
 * disagree on the shape.
 */

export interface BreadcrumbFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface BreadcrumbService {
  id: string;
  slug: string;
  name: string;
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
}

export interface BreadcrumbProject {
  id: string;
  name: string;
}

/** The team-scoped snapshot the breadcrumb navigates over (see getBreadcrumbGraph). */
export interface BreadcrumbGraph {
  folders: BreadcrumbFolder[];
  services: BreadcrumbService[];
  projects: BreadcrumbProject[];
}

/** Where the viewer is: the pathname plus the Overview's drill-in query params. */
export interface BreadcrumbContext {
  pathname: string;
  /** ?folder= on the Overview (folder drill-in), else null. */
  openFolderId: string | null;
  /** ?project= on the Overview (project drill-in), else null. */
  openProjectId: string | null;
  /** ?view=list|grid — preserved in the folder/project/overview links. */
  view: "grid" | "list";
}

/** One entry inside a segment's ▾ dropdown. */
export interface DropItem {
  /** Stable React key. */
  id: string;
  label: string;
  href: string;
  /** Distinguishes the icon and grouping in the menu. */
  kind: "folder" | "service" | "project" | "section";
  /** The entry that IS the current path at this level (checkmarked, non-navigating). */
  current: boolean;
  /** Optional group heading the renderer buckets items under ("Folders" / "Services"). */
  group?: string;
}

/** One "/"-separated crumb: a name that links somewhere plus a sibling dropdown. */
export interface BreadcrumbSegment {
  key: string;
  name: string;
  /** Where clicking the name navigates. */
  href: string;
  kind: "overview" | "folder" | "project" | "service" | "section";
  /** Sibling / child targets for the ▾ dropdown (empty ⇒ no dropdown). */
  items: DropItem[];
}

/** Per-team capabilities that gate which service sections are offered. */
export interface BreadcrumbCaps {
  manageEnv: boolean;
  manageInfra: boolean;
  manageDomains: boolean;
}

/**
 * Live per-service facts the section dropdown needs (Console only while running,
 * Dev/Files only when eligible). Sourced from the service-nav store; `slugMatches`
 * is false until it confirms the store is for the service in the URL (so a stale
 * value from the service you just left never leaks its sections in).
 */
export interface BreadcrumbFlags {
  running: boolean;
  devEligible: boolean;
  showFiles: boolean;
  slugMatches: boolean;
}

/** A service's top-level sections, in sidebar order (see nav-config.serviceNav). */
const MAIN_SECTIONS: {
  seg: string;
  label: string;
  requires?: keyof BreadcrumbCaps;
  flag?: "running" | "devEligible" | "showFiles";
}[] = [
  { seg: "", label: "Overview" },
  { seg: "deployments", label: "Deployments" },
  { seg: "environment", label: "Environment", requires: "manageEnv" },
  { seg: "domains", label: "Domains" },
  { seg: "console", label: "Console", flag: "running" },
  { seg: "logs", label: "Logs" },
  { seg: "dev", label: "Dev Mode", flag: "devEligible" },
  { seg: "files", label: "Files", flag: "showFiles" },
  { seg: "backups", label: "Backups", requires: "manageInfra" },
  { seg: "settings", label: "Settings" },
];

/** A service's settings subsections, in sidebar order (see serviceSettingsNav). */
const SETTINGS_SUBS: { seg: string; label: string; requires?: keyof BreadcrumbCaps }[] =
  [
    { seg: "", label: "General" },
    { seg: "deployments", label: "Deployments" },
    { seg: "storage", label: "Storage" },
    { seg: "access", label: "Access", requires: "manageDomains" },
    { seg: "danger", label: "Danger" },
  ];

const byNameThenId = (
  a: { label?: string; name?: string; id: string },
  b: { label?: string; name?: string; id: string },
) => {
  const an = (a.label ?? a.name ?? "").toLowerCase();
  const bn = (b.label ?? b.name ?? "").toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : 1;
};

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The Overview root URL, preserving the list/grid view. */
function overviewUrl(view: "grid" | "list"): string {
  return view === "list" ? "/?view=list" : "/";
}
/** Overview URL that opens a folder (mirrors folderHref). */
function folderUrl(id: string, view: "grid" | "list"): string {
  return view === "list" ? `/?folder=${id}&view=list` : `/?folder=${id}`;
}
/** Overview URL that opens a project container. */
function projectUrl(id: string, view: "grid" | "list"): string {
  return view === "list" ? `/?project=${id}&view=list` : `/?project=${id}`;
}

/**
 * The ancestor folder chain for a folder id, root → leaf (inclusive). Walks
 * `parentId` up over the VISIBLE folder set; a missing link (a folder the viewer
 * can't see, or a stale id) just ends the walk, and a `seen` guard makes a stale
 * cycle terminate.
 */
export function folderChainFor(
  folderId: string | null,
  folders: BreadcrumbFolder[],
): BreadcrumbFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f] as const));
  const chain: BreadcrumbFolder[] = [];
  const seen = new Set<string>();
  let cur = folderId ? byId.get(folderId) ?? null : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) ?? null : null;
  }
  return chain;
}

/**
 * Build the breadcrumb segments for the current location, or null when it isn't a
 * services-tree location (a plain page like /storage, or a service/folder not in
 * the graph) — the topbar then falls back to its plain top-level label. The trail:
 *
 *   Overview  →  [folder…]  or  [project]  →  [service]  →  [section]  →  [subsection]
 *
 * Every folder crumb's dropdown lists that folder's subfolders + direct services
 * (pivot across the tree); the Overview crumb's dropdown lists the top level
 * (root folders, projects, ungrouped services); the service crumb's dropdown lists
 * its sibling services; the section crumbs list the service's other sections. The
 * entry matching the current path at each level is flagged `current`.
 */
export function buildBreadcrumb(
  ctx: BreadcrumbContext,
  graph: BreadcrumbGraph,
  caps: BreadcrumbCaps,
  flags: BreadcrumbFlags,
): BreadcrumbSegment[] | null {
  const { pathname, openFolderId, openProjectId, view } = ctx;
  const { folders, services, projects } = graph;

  // Resolve the location into: a folder chain, a project, a service, section tail.
  let chain: BreadcrumbFolder[] = [];
  let project: BreadcrumbProject | null = null;
  let service: BreadcrumbService | null = null;
  let rest: string[] = [];

  const serviceMatch = pathname.match(/^\/services\/([^/]+)(\/.*)?$/);
  if (serviceMatch) {
    service = services.find((s) => s.slug === serviceMatch[1]) ?? null;
    if (!service) return null;
    chain = folderChainFor(service.folderId ?? null, folders);
    if (chain.length === 0 && service.projectId) {
      project = projects.find((p) => p.id === service!.projectId) ?? null;
    }
    rest = (serviceMatch[2] ?? "").split("/").filter(Boolean);
  } else if (pathname === "/") {
    // Overview drill-in. A folder param wins over a project param (same precedence
    // as the Overview page); an unknown/invisible id falls back to the plain label.
    if (openFolderId) {
      if (!folders.some((f) => f.id === openFolderId)) return null;
      chain = folderChainFor(openFolderId, folders);
    } else if (openProjectId) {
      project = projects.find((p) => p.id === openProjectId) ?? null;
      if (!project) return null;
    }
    // else: the plain Overview root — just the Overview crumb, current.
  } else {
    return null;
  }

  // Section preservation for sibling service links (Vercel-style: switch service,
  // keep your tab). Console/Dev/Files hinge on per-service runtime facts a sibling
  // may not share, so those never carry over; deeper detail (a deployment id) is
  // dropped — only the section (+ settings subsection) is kept.
  const UNSAFE_SECTIONS = new Set(["console", "dev", "files"]);
  const siblingSuffix =
    rest.length > 0 && !UNSAFE_SECTIONS.has(rest[0])
      ? rest[0] === "settings" && rest[1]
        ? `/settings/${rest[1]}`
        : `/${rest[0]}`
      : "";
  const svcHref = (s: BreadcrumbService) => `/services/${s.slug}${siblingSuffix}`;

  const segments: BreadcrumbSegment[] = [];

  // What comes right after Overview — used to checkmark it in the root dropdown.
  const rootFolderId = chain[0]?.id ?? null;
  const rootProjectId = chain.length === 0 && project ? project.id : null;
  const rootServiceId =
    chain.length === 0 && !project && service ? service.id : null;

  // Overview root crumb: dropdown is the top level — root folders, projects, and
  // ungrouped services — so you can jump anywhere from the root.
  const rootItems: DropItem[] = [
    ...folders
      .filter((f) => (f.parentId ?? null) === null)
      .map((f) => ({
        id: f.id,
        label: f.name,
        href: folderUrl(f.id, view),
        kind: "folder" as const,
        current: f.id === rootFolderId,
        group: "Folders",
      }))
      .sort(byNameThenId),
    ...projects
      .map((p) => ({
        id: p.id,
        label: p.name,
        href: projectUrl(p.id, view),
        kind: "project" as const,
        current: p.id === rootProjectId,
        group: "Projects",
      }))
      .sort(byNameThenId),
    ...services
      .filter((s) => !s.folderId && !s.projectId)
      .map((s) => ({
        id: s.id,
        label: s.name,
        href: svcHref(s),
        kind: "service" as const,
        current: s.id === rootServiceId,
        group: "Services",
      }))
      .sort(byNameThenId),
  ];
  segments.push({
    key: "overview",
    name: "Overview",
    href: overviewUrl(view),
    kind: "overview",
    items: rootItems,
  });

  // A crumb per ancestor folder. Its dropdown is that folder's children — the NEXT
  // folder in the chain (or, at the leaf folder, the open service) is marked
  // current so you can see where you are and pivot to a sibling.
  chain.forEach((folder, idx) => {
    const nextFolderId = idx < chain.length - 1 ? chain[idx + 1].id : null;
    const isLeaf = nextFolderId === null;
    const subfolders: DropItem[] = folders
      .filter((f) => (f.parentId ?? null) === folder.id)
      .map((f) => ({
        id: f.id,
        label: f.name,
        href: folderUrl(f.id, view),
        kind: "folder" as const,
        current: f.id === nextFolderId,
        group: "Folders",
      }))
      .sort(byNameThenId);
    const childServices: DropItem[] = services
      .filter((s) => (s.folderId ?? null) === folder.id)
      .map((s) => ({
        id: s.id,
        label: s.name,
        href: svcHref(s),
        kind: "service" as const,
        // Only the LEAF folder's open service is "current"; a deeper service sits
        // below the next folder, not this crumb.
        current: isLeaf && service != null && s.id === service.id,
        group: "Services",
      }))
      .sort(byNameThenId);
    segments.push({
      key: `folder-${folder.id}`,
      name: folder.name,
      href: folderUrl(folder.id, view),
      kind: "folder",
      items: [...subfolders, ...childServices],
    });
  });

  // A project crumb whose dropdown lists its services. Inside a service the list is
  // scoped to that service's environment (the slice the project view shows); when
  // just browsing the project, list all of its services.
  if (project) {
    const projServices = services.filter(
      (s) =>
        s.projectId === project!.id &&
        (service == null ||
          (s.environmentId ?? null) === (service.environmentId ?? null)),
    );
    segments.push({
      key: `project-${project.id}`,
      name: project.name,
      href: projectUrl(project.id, view),
      kind: "project",
      items: projServices
        .map((s) => ({
          id: s.id,
          label: s.name,
          href: svcHref(s),
          kind: "service" as const,
          current: service != null && s.id === service.id,
        }))
        .sort(byNameThenId),
    });
  }

  if (service) {
    // The service crumb. Its siblings share its home: the same folder, the same
    // project+environment, or the ungrouped top level.
    const siblings = service.folderId
      ? services.filter((s) => s.folderId === service!.folderId)
      : service.projectId
        ? services.filter(
            (s) =>
              s.projectId === service!.projectId &&
              (s.environmentId ?? null) === (service!.environmentId ?? null),
          )
        : services.filter((s) => !s.folderId && !s.projectId);
    segments.push({
      key: `service-${service.id}`,
      name: service.name,
      href: `/services/${service.slug}`,
      kind: "service",
      items: siblings
        .map((s) => ({
          id: s.id,
          label: s.name,
          href: svcHref(s),
          kind: "service" as const,
          current: s.id === service!.id,
        }))
        .sort(byNameThenId),
    });
  }

  // Section crumbs, from the path tail after /services/<slug> (parsed above).
  if (service && rest.length > 0) {
    const slug = service.slug;
    const mainSeg = rest[0];
    const base = `/services/${slug}`;
    const sectionAvailable = (sec: (typeof MAIN_SECTIONS)[number]) =>
      (!sec.requires || caps[sec.requires]) &&
      (!sec.flag ||
        (flags.slugMatches && flags[sec.flag]) ||
        sec.seg === mainSeg);
    const mainItems: DropItem[] = MAIN_SECTIONS.filter(sectionAvailable).map(
      (sec) => ({
        id: sec.seg || "overview",
        label: sec.label,
        href: sec.seg ? `${base}/${sec.seg}` : base,
        kind: "section" as const,
        current: sec.seg === mainSeg,
      }),
    );
    const mainLabel =
      MAIN_SECTIONS.find((s) => s.seg === mainSeg)?.label ?? capitalize(mainSeg);
    segments.push({
      key: "section-main",
      name: mainLabel,
      href: `${base}/${mainSeg}`,
      kind: "section",
      items: mainItems,
    });

    // A settings subsection (General/Deployments/Storage/Access/Danger) adds one
    // more crumb whose dropdown swaps between the subsections. Emitted for the
    // bare /settings index too (sub = "" = General) so you can pivot subsections
    // from there instead of dead-ending on General.
    if (mainSeg === "settings") {
      const sub = rest[1] ?? "";
      const subBase = `${base}/settings`;
      const subItems: DropItem[] = SETTINGS_SUBS.filter(
        (s) => !s.requires || caps[s.requires],
      ).map((s) => ({
        id: s.seg || "general",
        label: s.label,
        href: s.seg ? `${subBase}/${s.seg}` : subBase,
        kind: "section" as const,
        current: s.seg === sub,
      }));
      const subLabel =
        SETTINGS_SUBS.find((s) => s.seg === sub)?.label ?? capitalize(sub);
      segments.push({
        key: "section-sub",
        name: subLabel,
        href: sub ? `${subBase}/${sub}` : subBase,
        kind: "section",
        items: subItems,
      });
    }
  }

  return segments;
}
