import type { AppStatus, DatabaseStatus, DatabaseType } from "@/lib/types";

/**
 * One thing whose logs can be watched on the general Logs page: an App or a
 * database.
 *
 * Deliberately flat and deliberately pure. The same shape is rendered by the
 * chooser grid and by the toolbar picker, keyed in the URL, remembered in a
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
  /** The App's slug, or the database's engine. The second thing typing matches,
   *  and the muted line under the name in both the grid and the picker. */
  detail: string;
  status: AppStatus | DatabaseStatus;
  logo: string | null;
  /** Databases only: picks the engine's brand mark when there is no logo. */
  type?: DatabaseType;
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

/** The chooser, forced. Reached from the picker's own menu, and the one URL
 *  that ignores the remembered target without forgetting it. */
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

/** Does this target match what somebody typed? Name or detail, case-insensitive
 *  and space-separated, so "api prod" narrows the way a person expects. */
export function logTargetMatches(target: LogTarget, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = `${target.name} ${target.detail}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
