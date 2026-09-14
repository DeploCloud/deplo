import type { AppStatus } from "@/lib/types/app";
import type { DatabaseStatus, DatabaseType } from "@/lib/types/database";

// LogTarget - one thing whose logs can be watched: an App or a database.
export interface LogTarget {
  // `app:<slug>` or `db:<id>`: the URL, the cookie, the combobox key and the React key are all this string.
  key: string;
  kind: "app" | "database";
  name: string;
  // The App's slug, or the database's engine: the second thing typing matches.
  detail: string;
  status: AppStatus | DatabaseStatus;
  logo: string | null;
  // Databases only: picks the engine's brand mark when there is no logo.
  type?: DatabaseType;
  // All three are tolerated pointing at nothing: a folder the caller holds no grant on never comes back.
  projectId?: string | null;
  environmentId?: string | null;
  folderId?: string | null;
}

// LOG_TARGET_COOKIE - the last target, client-written and validated against the readable list on every read.
export const LOG_TARGET_COOKIE = "deplo_logs_target";

// A cookie is attacker-writable text: anything longer than this is not a key we wrote.
const MAX_KEY_LENGTH = 256;

export function appTargetKey(slug: string): string {
  return `app:${slug}`;
}

export function databaseTargetKey(id: string): string {
  return `db:${id}`;
}

// logTargetHref - where a target is watched; each kind gets its own query param.
export function logTargetHref(key: string): string {
  const sep = key.indexOf(":");
  if (sep === -1) return "/logs";
  const kind = key.slice(0, sep);
  const ref = key.slice(sep + 1);
  if (!ref) return "/logs";
  const param = kind === "app" ? "app" : kind === "db" ? "db" : null;
  return param ? `/logs?${param}=${encodeURIComponent(ref)}` : "/logs";
}

// logTargetOverviewHref - the target's own Overview, where "Open <name>" in the picker goes.
export function logTargetOverviewHref(key: string): string {
  const sep = key.indexOf(":");
  if (sep === -1) return "/";
  const kind = key.slice(0, sep);
  const ref = key.slice(sep + 1);
  if (!ref) return "/";
  if (kind === "app") return `/apps/${encodeURIComponent(ref)}`;
  if (kind === "db") return `/storage/databases/${encodeURIComponent(ref)}`;
  return "/";
}

// LOG_CHOOSER_HREF - the chooser, forced: ignores the remembered target without forgetting it.
export const LOG_CHOOSER_HREF = "/logs?pick=1";

// resolveLogTarget - the order is the contract: `pick` beats the URL, the URL beats the cookie.
export function resolveLogTarget(
  targets: LogTarget[],
  from: {
    app?: string | string[];
    db?: string | string[];
    pick?: string | string[];
    cookie?: string;
  },
): LogTarget | null {
  if (first(from.pick)) return null;

  const app = first(from.app);
  if (app) return byKey(targets, appTargetKey(app));

  const db = first(from.db);
  if (db) return byKey(targets, databaseTargetKey(db));

  const cookie = from.cookie?.trim();
  if (!cookie || cookie.length > MAX_KEY_LENGTH) return null;
  return byKey(targets, cookie);
}

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s ? s : undefined;
}

function byKey(targets: LogTarget[], key: string): LogTarget | null {
  return targets.find((t) => t.key === key) ?? null;
}

// LogTreeRow - one row of the Logs picker: a heading, or something to open.
export interface LogTreeRow {
  key: string;
  depth: number;
  kind: "project" | "environment" | "folder" | "section" | "target";
  name: string;
  color?: string | null;
  // Set on exactly the rows that can be picked.
  target?: LogTarget;
  // Lowercased: this row's own words, every ancestor's, and, on a heading, every descendant's.
  haystack: string;
}

interface TreeFolder {
  id: string;
  name: string;
  parentId?: string | null;
  projectId?: string | null;
  color?: string | null;
}

// buildLogTree - the readable targets, arranged the way the Overview arranges them.
export function buildLogTree(
  targets: LogTarget[],
  ctx: {
    projects: { id: string; name: string; color?: string | null }[];
    environments: { id: string; name: string; projectId: string }[];
    folders: TreeFolder[];
  },
): LogTreeRow[] {
  const projectIds = new Set(ctx.projects.map((p) => p.id));
  const envById = new Map(ctx.environments.map((e) => [e.id, e]));
  const folderById = new Map(ctx.folders.map((f) => [f.id, f]));

  const inFolder = new Map<string, LogTarget[]>();
  const inEnv = new Map<string, LogTarget[]>();
  const inProject = new Map<string, LogTarget[]>();
  const loose: LogTarget[] = [];
  for (const t of targets) {
    if (t.kind !== "app") continue;
    const folder = t.folderId ? folderById.get(t.folderId) : undefined;
    if (folder) {
      bucket(inFolder, folder.id, t);
      continue;
    }
    const env = t.environmentId ? envById.get(t.environmentId) : undefined;
    if (env && projectIds.has(env.projectId)) {
      bucket(inEnv, env.id, t);
      continue;
    }
    if (t.projectId && projectIds.has(t.projectId)) {
      bucket(inProject, t.projectId, t);
      continue;
    }
    loose.push(t);
  }

  const subFolders = new Map<string, TreeFolder[]>();
  const projectFolders = new Map<string, TreeFolder[]>();
  const teamFolders: TreeFolder[] = [];
  for (const f of ctx.folders) {
    const parent = f.parentId ? folderById.get(f.parentId) : undefined;
    if (parent) bucket(subFolders, parent.id, f);
    else if (f.projectId && projectIds.has(f.projectId))
      bucket(projectFolders, f.projectId, f);
    else teamFolders.push(f);
  }

  const folderRows = (
    f: TreeFolder,
    depth: number,
    trail: string,
  ): LogTreeRow[] =>
    group(
      {
        key: `grp:folder:${f.id}`,
        kind: "folder",
        name: f.name,
        color: f.color,
        depth,
        trail,
      },
      (inside) => [
        ...(subFolders.get(f.id) ?? []).flatMap((c) =>
          folderRows(c, depth + 1, inside),
        ),
        ...(inFolder.get(f.id) ?? []).map((t) =>
          targetRow(t, depth + 1, inside),
        ),
      ],
    );

  const rows: LogTreeRow[] = [];
  for (const p of ctx.projects) {
    rows.push(
      ...group(
        {
          key: `grp:project:${p.id}`,
          kind: "project",
          name: p.name,
          color: p.color,
          depth: 0,
          trail: "",
        },
        (inside) => [
          ...ctx.environments
            .filter((e) => e.projectId === p.id)
            .flatMap((e) =>
              group(
                {
                  key: `grp:environment:${e.id}`,
                  kind: "environment",
                  name: e.name,
                  depth: 1,
                  trail: inside,
                },
                (under) =>
                  (inEnv.get(e.id) ?? []).map((t) => targetRow(t, 2, under)),
              ),
            ),
          ...(projectFolders.get(p.id) ?? []).flatMap((f) =>
            folderRows(f, 1, inside),
          ),
          ...(inProject.get(p.id) ?? []).map((t) => targetRow(t, 1, inside)),
        ],
      ),
    );
  }
  for (const f of teamFolders) rows.push(...folderRows(f, 0, ""));
  for (const t of loose) rows.push(targetRow(t, 0, ""));

  const databases = targets.filter((t) => t.kind === "database");
  if (databases.length > 0) {
    rows.push(
      ...group(
        {
          key: "grp:section:databases",
          kind: "section",
          name: "Databases",
          depth: 0,
          trail: "",
        },
        (inside) => databases.map((t) => targetRow(t, 1, inside)),
      ),
    );
  }
  return rows;
}

function bucket<T>(m: Map<string, T[]>, key: string, value: T): void {
  const list = m.get(key);
  if (list) list.push(value);
  else m.set(key, [value]);
}

function targetRow(t: LogTarget, depth: number, trail: string): LogTreeRow {
  return {
    key: t.key,
    depth,
    kind: "target",
    name: t.name,
    target: t,
    haystack: `${trail} ${t.name} ${t.detail}`.trim().toLowerCase(),
  };
}

function group(
  head: {
    key: string;
    kind: LogTreeRow["kind"];
    name: string;
    color?: string | null;
    depth: number;
    trail: string;
  },
  children: (trail: string) => LogTreeRow[],
): LogTreeRow[] {
  const inside = `${head.trail} ${head.name}`.trim().toLowerCase();
  const rows = children(inside);
  if (rows.length === 0) return [];
  return [
    {
      key: head.key,
      depth: head.depth,
      kind: head.kind,
      name: head.name,
      color: head.color,
      // Every descendant's words, so a heading survives a query only one app three levels down answers to.
      haystack: `${inside} ${rows.map((r) => r.haystack).join(" ")}`,
    },
    ...rows,
  ];
}

// logTreeMatches - case-insensitive and space-separated, so "api prod" narrows as expected.
export function logTreeMatches(row: LogTreeRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => row.haystack.includes(t));
}
