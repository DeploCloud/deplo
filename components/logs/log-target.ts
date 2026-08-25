import type { AppStatus, DatabaseStatus, DatabaseType } from "@/lib/types";

/**
 * One thing whose logs can be watched on the general Logs page: an App or a
 * database.
 *
 * Deliberately flat and deliberately pure. The same shape is rendered by the
 * centred chooser and by the toolbar picker, keyed in the URL, remembered in a
 * cookie and matched by the typing filter, so it has exactly one identity —
 * {@link LogTarget.key} — and no React, no `server-only`, nothing that stops the
 * RSC and the two client components from all importing it.
 */
export interface LogTarget {
  /** `app:<slug>` or `db:<id>`. The URL, the cookie value, the combobox key and
   *  the React key are all this string. */
  key: string;
  kind: "app" | "database";
  name: string;
  /** The App's slug, or the database's engine. The second thing typing matches —
   *  the rows themselves show the name, and the tree above it says the rest. */
  detail: string;
  status: AppStatus | DatabaseStatus;
  logo: string | null;
  /** Databases only: picks the engine's brand mark when there is no logo. */
  type?: DatabaseType;
  /** Apps only — where this one sits on the Overview, which is where the picker
   *  draws it. All three are optional and all three are TOLERATED when they
   *  point at nothing: a folder the caller holds no grant on never comes back
   *  from `listFolders`, and an app must still be pickable. */
  projectId?: string | null;
  environmentId?: string | null;
  folderId?: string | null;
}

/** The cookie that remembers the last target, so the sidebar's Logs entry
 *  reopens it. Written by the client (a GET cannot set a cookie from an RSC),
 *  read in the page, and validated against the readable list on every read —
 *  see `resolveLogTarget`. */
export const LOG_TARGET_COOKIE = "deplo_logs_target";

/** A cookie is attacker-writable text. Anything longer than this is not a key
 *  we ever wrote, so it is dropped before it reaches a lookup. */
const MAX_KEY_LENGTH = 256;

export function appTargetKey(slug: string): string {
  return `app:${slug}`;
}

export function databaseTargetKey(id: string): string {
  return `db:${id}`;
}

/** Where a target is watched. The two kinds get their own query param rather
 *  than one opaque `?target=app:foo`, so the URL reads as English. */
export function logTargetHref(key: string): string {
  const sep = key.indexOf(":");
  if (sep === -1) return "/logs";
  const kind = key.slice(0, sep);
  const ref = key.slice(sep + 1);
  if (!ref) return "/logs";
  const param = kind === "app" ? "app" : kind === "db" ? "db" : null;
  return param ? `/logs?${param}=${encodeURIComponent(ref)}` : "/logs";
}

/** The target's own Overview: where "Open <name>" in the picker goes. The
 *  toolbar picker stands in for the pane title on the general Logs page, so
 *  without this the way back to the thing itself would be gone. */
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

/** The chooser, forced: the one URL that ignores the remembered target without
 *  forgetting it, and the only way back to it when a team has a single target
 *  (which `/logs` opens straight away). */
export const LOG_CHOOSER_HREF = "/logs?pick=1";

/**
 * Which target the Logs page should show, given what the URL asks for and what
 * the browser remembers.
 *
 * The order is the whole contract: `pick` beats everything (it is how somebody
 * gets back to the chooser), then the URL, then the cookie. `targets` is the
 * list the caller may actually READ, so membership in it is the validation —
 * a deleted App, a revoked `view_logs`, a target belonging to the team the user
 * just left and a truncated cookie all come back the same way, as `null`, and
 * the chooser renders. There is no separate "is this still valid" pass to keep
 * in sync, and nothing has to clean the cookie up.
 */
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

/** A search param arrives as a string, an array (repeated key) or nothing. Take
 *  the first, the way `placementFromSearchParams` does for the Overview. */
function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s ? s : undefined;
}

function byKey(targets: LogTarget[], key: string): LogTarget | null {
  return targets.find((t) => t.key === key) ?? null;
}

/* ------------------------------------------------------------------ */
/* The tree the picker draws                                           */
/* ------------------------------------------------------------------ */

/** One row of the Logs picker: a heading, or something to open. */
export interface LogTreeRow {
  /** The target's key on a selectable row, `grp:<kind>:<id>` on a heading. */
  key: string;
  /** Indentation, 0-based. */
  depth: number;
  kind: "project" | "environment" | "folder" | "section" | "target";
  name: string;
  /** A project's or folder's accent colour, when it has one. */
  color?: string | null;
  /** Set on exactly the rows that can be picked. */
  target?: LogTarget;
  /** Lowercased: this row's own words, every ANCESTOR's, and — on a heading —
   *  every descendant's. Matching on that one string gives the scope picker's
   *  two search rules without filtering a tree: typing an app's name keeps its
   *  headings on screen, and typing a project's name keeps all of its apps. */
  haystack: string;
}

interface TreeFolder {
  id: string;
  name: string;
  parentId?: string | null;
  projectId?: string | null;
  color?: string | null;
}

/**
 * The readable targets, arranged the way the Overview arranges them: each
 * project with its environments, then the folders (nesting as deep as they do),
 * then the apps that sit at the top level, and the databases in a section of
 * their own.
 *
 * Flat on purpose — a list of rows carrying a `depth`, not a nested object —
 * because that is what a combobox can filter, highlight and walk with the arrow
 * keys. A branch with nothing readable under it is not drawn, and **no target is
 * ever dropped**: an app whose folder or project does not resolve (the caller
 * holds no grant on it, so it never came back from `listFolders`) falls in with
 * the top-level apps rather than out of the picker.
 */
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

/** A heading plus its children, or NOTHING when nothing readable is under it. */
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
      // Every descendant's words, so a heading survives a query that only one
      // app three levels down answers to.
      haystack: `${inside} ${rows.map((r) => r.haystack).join(" ")}`,
    },
    ...rows,
  ];
}

/** Does this row match what somebody typed? Case-insensitive and space-
 *  separated, so "api prod" narrows the way a person expects. */
export function logTreeMatches(row: LogTreeRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => row.haystack.includes(t));
}
