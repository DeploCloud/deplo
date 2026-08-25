/**
 * Pure model behind the topbar breadcrumb.
 */

export interface BreadcrumbFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface BreadcrumbApp {
  id: string;
  slug: string;
  name: string;
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
  /** The app's own logo, so the menu shows the same avatar its card and header
   *  do instead of a generic glyph. Optional: absent ⇒ the generic glyph. */
  logo?: string | null;
}

export interface BreadcrumbProject {
  id: string;
  name: string;
}

export interface BreadcrumbDatabase {
  id: string;
  name: string;
  /** The engine ("postgres", "mysql", …). A database with no uploaded logo of
   *  its own wears its engine's mark, exactly as its card does. */
  type: string;
  logo?: string | null;
}

/** The team-scoped snapshot the breadcrumb navigates over (see getBreadcrumbGraph). */
export interface BreadcrumbGraph {
  folders: BreadcrumbFolder[];
  apps: BreadcrumbApp[];
  projects: BreadcrumbProject[];
  /** Empty for a member whose role or token does not reach the whole team —
   *  Storage is a team-wide list, so a narrowed caller sees none of it. */
  databases: BreadcrumbDatabase[];
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
  kind: "folder" | "app" | "project" | "database" | "section";
  /** The entry that IS the current path at this level (checkmarked, non-navigating). */
  current: boolean;
  /** An app's or database's logo — the renderer shows it in place of the
   *  generic glyph. Null/absent on every other kind. */
  logo?: string | null;
  /** A database entry's engine, so a logo-less one still gets its own mark. */
  dbType?: string | null;
  /** Optional group heading the renderer buckets items under ("Folders" / "Apps"). */
  group?: string;
}

/** One "/"-separated crumb: a name that links somewhere plus a sibling dropdown. */
export interface BreadcrumbSegment {
  key: string;
  name: string;
  /** Where clicking the name navigates. */
  href: string;
  kind:
    | "overview"
    | "storage"
    | "folder"
    | "project"
    | "app"
    | "database"
    | "section";
  /** Sibling / child targets for the ▾ dropdown (empty ⇒ no dropdown). */
  items: DropItem[];
  /**
   * The crumb's own avatar, when the thing it names has one. Only on the crumbs
   * that name a THING (app, database, folder, project) — never on "Overview" or on
   * a section like "Logs", which are places.
   */
  logo?: string | null;
  /** A database crumb's engine — the fallback mark when it has no logo. */
  dbType?: string | null;
}

/** The capabilities that gate which app sections are offered. Resolved PER APP
 *  by the caller (a grant can hold one of these on a single app), so a section
 *  the viewer can't read is never listed. */
export interface BreadcrumbCaps {
  manageEnv: boolean;
  manageBackups: boolean;
  manageBasicAuth: boolean;
  managePreviews: boolean;
}

/**
 * Live per-app facts the section dropdown needs (Console only while running, Files
 * only when present).
 */
export interface BreadcrumbFlags {
  running: boolean;
  showFiles: boolean;
  slugMatches: boolean;
}

/**
 * A database's top-level sections, in sidebar order (see nav-config.databaseNav).
 */
const DATABASE_SECTIONS: { seg: string; label: string }[] = [
  { seg: "", label: "Overview" },
  { seg: "logs", label: "Logs" },
  { seg: "monitoring", label: "Monitoring" },
  { seg: "backups", label: "Backups" },
  { seg: "settings", label: "Settings" },
];

/** An app's top-level sections, in sidebar order (see nav-config.appNav). */
const MAIN_SECTIONS: {
  seg: string;
  label: string;
  requires?: keyof BreadcrumbCaps;
  flag?: "running" | "showFiles";
}[] = [
  { seg: "", label: "Overview" },
  { seg: "deployments", label: "Deployments" },
  { seg: "environment", label: "Environment", requires: "manageEnv" },
  { seg: "domains", label: "Domains" },
  { seg: "console", label: "Console", flag: "running" },
  { seg: "logs", label: "Logs" },
  { seg: "files", label: "Files", flag: "showFiles" },
  { seg: "backups", label: "Backups", requires: "manageBackups" },
  { seg: "settings", label: "Settings" },
];

/** An app's settings subsections, in sidebar order (see appSettingsNav). */
const SETTINGS_SUBS: {
  seg: string;
  label: string;
  requires?: keyof BreadcrumbCaps;
}[] = [
  { seg: "", label: "General" },
  { seg: "deployments", label: "Deployments" },
  // Listed for every app, GitHub or not — the page itself explains why it is
  // closed to the ones that cannot use it, which is the whole point of the
  // settings entry existing (the operational page is hidden instead).
  { seg: "pull-requests", label: "Pull requests", requires: "managePreviews" },
  { seg: "storage", label: "Storage" },
  { seg: "resources", label: "Resources" },
  { seg: "access", label: "Access", requires: "manageBasicAuth" },
  { seg: "advanced", label: "Advanced" },
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
 * The ancestor folder chain for a folder id, root → leaf (inclusive).
 */
export function folderChainFor(
  folderId: string | null,
  folders: BreadcrumbFolder[],
): BreadcrumbFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f] as const));
  const chain: BreadcrumbFolder[] = [];
  const seen = new Set<string>();
  let cur = folderId ? (byId.get(folderId) ?? null) : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? (byId.get(cur.parentId) ?? null) : null;
  }
  return chain;
}

/**
 * Build the breadcrumb segments for the current location, or null when it isn't an
 * apps-tree location (a plain page like /storage, or an app/folder not in the
 * graph) — the topbar then falls back to its plain top-level label.
 */
export function buildBreadcrumb(
  ctx: BreadcrumbContext,
  graph: BreadcrumbGraph,
  caps: BreadcrumbCaps,
  flags: BreadcrumbFlags,
): BreadcrumbSegment[] | null {
  const { pathname, openFolderId, openProjectId, view } = ctx;
  const { folders, apps, projects } = graph;

  // Resolve the location into: a folder chain, a project, an app, section tail.
  let chain: BreadcrumbFolder[] = [];
  let project: BreadcrumbProject | null = null;
  let service: BreadcrumbApp | null = null;
  let rest: string[] = [];

  // Storage is its own short trail — Storage / <database> / <section> — and not
  // part of the apps tree, so it is resolved and returned before any of the
  // folder/project machinery below runs.
  const dbMatch = pathname.match(/^\/storage\/databases\/([^/]+)(\/.*)?$/);
  if (dbMatch) {
    return buildDatabaseTrail(
      dbMatch[1]!,
      (dbMatch[2] ?? "").split("/").filter(Boolean),
      graph.databases,
    );
  }

  const appMatch = pathname.match(/^\/apps\/([^/]+)(\/.*)?$/);
  if (appMatch) {
    service = apps.find((s) => s.slug === appMatch[1]) ?? null;
    if (!service) return null;
    chain = folderChainFor(service.folderId ?? null, folders);
    if (chain.length === 0 && service.projectId) {
      project = projects.find((p) => p.id === service!.projectId) ?? null;
    }
    rest = (appMatch[2] ?? "").split("/").filter(Boolean);
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

  // Section preservation for sibling app links (Vercel-style: switch app, keep your
  // tab).
  const UNSAFE_SECTIONS = new Set(["console", "files"]);
  const siblingSuffix =
    rest.length > 0 && !UNSAFE_SECTIONS.has(rest[0])
      ? rest[0] === "settings" && rest[1]
        ? `/settings/${rest[1]}`
        : `/${rest[0]}`
      : "";
  const svcHref = (s: BreadcrumbApp) => `/apps/${s.slug}${siblingSuffix}`;

  const segments: BreadcrumbSegment[] = [];

  // What comes right after Overview — used to checkmark it in the root dropdown.
  const rootFolderId = chain[0]?.id ?? null;
  const rootProjectId = chain.length === 0 && project ? project.id : null;
  const rootAppId =
    chain.length === 0 && !project && service ? service.id : null;

  // Overview root crumb: dropdown is the top level — root folders, projects, and
  // ungrouped apps — so you can jump anywhere from the root.
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
    ...apps
      .filter((s) => !s.folderId && !s.projectId)
      .map((s) => ({
        id: s.id,
        label: s.name,
        href: svcHref(s),
        kind: "app" as const,
        logo: s.logo ?? null,
        current: s.id === rootAppId,
        group: "Apps",
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
  // folder in the chain (or, at the leaf folder, the open app) is marked
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
    const childApps: DropItem[] = apps
      .filter((s) => (s.folderId ?? null) === folder.id)
      .map((s) => ({
        id: s.id,
        label: s.name,
        href: svcHref(s),
        kind: "app" as const,
        logo: s.logo ?? null,
        // Only the LEAF folder's open app is "current"; a deeper app sits
        // below the next folder, not this crumb.
        current: isLeaf && service != null && s.id === service.id,
        group: "Apps",
      }))
      .sort(byNameThenId);
    segments.push({
      key: `folder-${folder.id}`,
      name: folder.name,
      href: folderUrl(folder.id, view),
      kind: "folder",
      items: [...subfolders, ...childApps],
    });
  });

  // A project crumb whose dropdown lists its apps. Inside an app the list is
  // scoped to that app's environment (the slice the project view shows); when
  // just browsing the project, list all of its apps.
  if (project) {
    const projApps = apps.filter(
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
      items: projApps
        .map((s) => ({
          id: s.id,
          label: s.name,
          href: svcHref(s),
          kind: "app" as const,
          logo: s.logo ?? null,
          current: service != null && s.id === service.id,
        }))
        .sort(byNameThenId),
    });
  }

  if (service) {
    // The app crumb. Its siblings share its home: the same folder, the same
    // project+environment, or the ungrouped top level.
    const siblings = service.folderId
      ? apps.filter((s) => s.folderId === service!.folderId)
      : service.projectId
        ? apps.filter(
            (s) =>
              s.projectId === service!.projectId &&
              (s.environmentId ?? null) === (service!.environmentId ?? null),
          )
        : apps.filter((s) => !s.folderId && !s.projectId);
    segments.push({
      key: `service-${service.id}`,
      name: service.name,
      href: `/apps/${service.slug}`,
      kind: "app",
      logo: service.logo ?? null,
      items: siblings
        .map((s) => ({
          id: s.id,
          label: s.name,
          href: svcHref(s),
          kind: "app" as const,
          logo: s.logo ?? null,
          current: s.id === service!.id,
        }))
        .sort(byNameThenId),
    });
  }

  // Section crumbs, from the path tail after /apps/<slug> (parsed above).
  if (service && rest.length > 0) {
    const slug = service.slug;
    const mainSeg = rest[0];
    const base = `/apps/${slug}`;
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
      MAIN_SECTIONS.find((s) => s.seg === mainSeg)?.label ??
      capitalize(mainSeg);
    segments.push({
      key: "section-main",
      name: mainLabel,
      href: `${base}/${mainSeg}`,
      kind: "section",
      items: mainItems,
    });

    // A settings subsection (General/Deployments/Storage/Access/Danger) adds one more
    // crumb whose dropdown swaps between the subsections.
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

/**
 * Storage / <database> ▾ / <section> ▾. Shorter than the apps trail because
 * storage has no tree: a database lives in the team, not in a folder.
 */
function buildDatabaseTrail(
  id: string,
  rest: string[],
  databases: BreadcrumbDatabase[],
): BreadcrumbSegment[] | null {
  const db = databases.find((d) => d.id === id);
  if (!db) return null;

  const base = (dbId: string) => `/storage/databases/${dbId}`;
  const mainSeg = rest[0] ?? "";
  // Keep your tab when pivoting to another database, exactly as the app trail
  // does — minus the sections that hinge on per-database facts a sibling may
  // not share, and minus any deeper id in the path.
  const UNSAFE = new Set(["console", "cron-jobs"]);
  const suffix = mainSeg && !UNSAFE.has(mainSeg) ? `/${mainSeg}` : "";

  const dbItems: DropItem[] = databases
    .map((d) => ({
      id: d.id,
      label: d.name,
      href: `${base(d.id)}${suffix}`,
      kind: "database" as const,
      logo: d.logo ?? null,
      dbType: d.type,
      current: d.id === db.id,
    }))
    .sort(byNameThenId);

  const segments: BreadcrumbSegment[] = [
    {
      key: "storage",
      name: "Storage",
      href: "/storage",
      kind: "storage",
      items: dbItems,
    },
    {
      key: `database-${db.id}`,
      name: db.name,
      href: base(db.id),
      kind: "database",
      logo: db.logo ?? null,
      dbType: db.type,
      items: dbItems,
    },
  ];

  if (mainSeg) {
    segments.push({
      key: "database-section",
      name:
        DATABASE_SECTIONS.find((sec) => sec.seg === mainSeg)?.label ??
        capitalize(mainSeg),
      href: `${base(db.id)}/${mainSeg}`,
      kind: "section",
      items: DATABASE_SECTIONS.map((sec) => ({
        id: sec.seg || "overview",
        label: sec.label,
        href: sec.seg ? `${base(db.id)}/${sec.seg}` : base(db.id),
        kind: "section" as const,
        current: sec.seg === mainSeg,
      })),
    });
  }

  return segments;
}
