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
  logo?: string | null;
  features?: {
    pullRequests: boolean;
    cronJobs: boolean;
    console: boolean;
  };
}

export interface BreadcrumbProject {
  id: string;
  name: string;
}

export interface BreadcrumbDatabase {
  id: string;
  name: string;
  type: string;
  logo?: string | null;
}

export interface BreadcrumbGraph {
  folders: BreadcrumbFolder[];
  apps: BreadcrumbApp[];
  projects: BreadcrumbProject[];
  databases: BreadcrumbDatabase[];
}

export interface BreadcrumbContext {
  pathname: string;
  openFolderId: string | null;
  openProjectId: string | null;
  view: "grid" | "list";
}

export interface DropItem {
  id: string;
  label: string;
  href: string;
  kind: "folder" | "app" | "project" | "database" | "section";
  current: boolean;
  logo?: string | null;
  dbType?: string | null;
  group?: string;
}

export interface BreadcrumbSegment {
  key: string;
  name: string;
  href: string;
  kind:
    | "overview"
    | "storage"
    | "folder"
    | "project"
    | "app"
    | "database"
    | "section";
  items: DropItem[];
  logo?: string | null;
  dbType?: string | null;
}

export interface BreadcrumbCaps {
  manageEnv: boolean;
  manageBackups: boolean;
  manageBasicAuth: boolean;
  managePreviews: boolean;
}

export interface BreadcrumbFlags {
  running: boolean;
  slugMatches: boolean;
}

const DATABASE_SECTIONS: { seg: string; label: string }[] = [
  { seg: "", label: "Overview" },
  { seg: "logs", label: "Logs" },
  { seg: "monitoring", label: "Monitoring" },
  { seg: "backups", label: "Backups" },
  { seg: "settings", label: "Settings" },
];

const MAIN_SECTIONS: {
  seg: string;
  label: string;
  requires?: keyof BreadcrumbCaps;
  flag?: "running";
}[] = [
  { seg: "", label: "Overview" },
  { seg: "deployments", label: "Deployments" },
  { seg: "environment", label: "Environment", requires: "manageEnv" },
  { seg: "domains", label: "Domains" },
  { seg: "console", label: "Console", flag: "running" },
  { seg: "logs", label: "Logs" },
  { seg: "backups", label: "Backups", requires: "manageBackups" },
  { seg: "settings", label: "Settings" },
];

const SETTINGS_SUBS: {
  seg: string;
  label: string;
  requires?: keyof BreadcrumbCaps;
}[] = [
  { seg: "", label: "General" },
  { seg: "deployments", label: "Deployments" },
  { seg: "pull-requests", label: "Pull requests", requires: "managePreviews" },
  { seg: "storage", label: "Storage" },
  { seg: "resources", label: "Resources" },
  { seg: "access", label: "Access", requires: "manageBasicAuth" },
  { seg: "activity", label: "Activity" },
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

function overviewUrl(view: "grid" | "list"): string {
  return view === "list" ? "/?view=list" : "/";
}
function folderUrl(id: string, view: "grid" | "list"): string {
  return view === "list" ? `/?folder=${id}&view=list` : `/?folder=${id}`;
}
function projectUrl(id: string, view: "grid" | "list"): string {
  return view === "list" ? `/?project=${id}&view=list` : `/?project=${id}`;
}

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

export function buildBreadcrumb(
  ctx: BreadcrumbContext,
  graph: BreadcrumbGraph,
  caps: BreadcrumbCaps,
  flags: BreadcrumbFlags,
): BreadcrumbSegment[] | null {
  const { pathname, openFolderId, openProjectId, view } = ctx;
  const { folders, apps, projects } = graph;

  let chain: BreadcrumbFolder[] = [];
  let project: BreadcrumbProject | null = null;
  let service: BreadcrumbApp | null = null;
  let rest: string[] = [];

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
    if (openFolderId) {
      if (!folders.some((f) => f.id === openFolderId)) return null;
      chain = folderChainFor(openFolderId, folders);
    } else if (openProjectId) {
      project = projects.find((p) => p.id === openProjectId) ?? null;
      if (!project) return null;
    }
  } else {
    return null;
  }

  const UNSAFE_SECTIONS = new Set(["console", "files"]);
  const siblingSuffix =
    rest.length > 0 && !UNSAFE_SECTIONS.has(rest[0])
      ? rest[0] === "settings" && rest[1]
        ? `/settings/${rest[1]}`
        : `/${rest[0]}`
      : "";
  const svcHref = (s: BreadcrumbApp) => `/apps/${s.slug}${siblingSuffix}`;

  const segments: BreadcrumbSegment[] = [];

  const rootFolderId = chain[0]?.id ?? null;
  const rootProjectId = chain.length === 0 && project ? project.id : null;
  const rootAppId =
    chain.length === 0 && !project && service ? service.id : null;

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

function buildDatabaseTrail(
  id: string,
  rest: string[],
  databases: BreadcrumbDatabase[],
): BreadcrumbSegment[] | null {
  const db = databases.find((d) => d.id === id);
  if (!db) return null;

  const base = (dbId: string) => `/storage/databases/${dbId}`;
  const mainSeg = rest[0] ?? "";
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
