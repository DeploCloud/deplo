import type { ActivityType } from "./types";

/** How many rows a page of the feed holds, first one included. */
export const ACTIVITY_PAGE_SIZE = 40;

/** How long "the last N days" is, per preset. Absent from the URL = all time. */
export const ACTIVITY_RANGES: { value: string; label: string; days: number }[] =
  [
    { value: "1d", label: "Last 24 hours", days: 1 },
    { value: "3d", label: "Last 3 days", days: 3 },
    { value: "7d", label: "Last 7 days", days: 7 },
    { value: "30d", label: "Last 30 days", days: 30 },
  ];

/** The Activity page's filters, exactly as they live in the URL. */
export interface ActivityParams {
  actorUserIds: string[];
  types: ActivityType[];
  resourceIds: string[];
  /** One of {@link ACTIVITY_RANGES}, or "" for all time / a custom range. */
  range: string;
  /** `YYYY-MM-DD`, inclusive. Set only for a custom range. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. Set only for a custom range. */
  to: string;
}

export const EMPTY_ACTIVITY_PARAMS: ActivityParams = {
  actorUserIds: [],
  types: [],
  resourceIds: [],
  range: "",
  from: "",
  to: "",
};

export function hasActivityFilters(p: ActivityParams): boolean {
  return (
    p.actorUserIds.length > 0 ||
    p.types.length > 0 ||
    p.resourceIds.length > 0 ||
    p.range !== "" ||
    p.from !== "" ||
    p.to !== ""
  );
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function list(v: string | string[] | undefined): string[] {
  return one(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read the filters out of `searchParams`. Anything unrecognised reads as unset. */
export function parseActivityParams(
  sp: Record<string, string | string[] | undefined>,
): ActivityParams {
  const range = one(sp.range);
  const from = one(sp.from);
  const to = one(sp.to);
  return {
    actorUserIds: list(sp.actor),
    types: list(sp.event) as ActivityType[],
    resourceIds: list(sp.resource),
    range: ACTIVITY_RANGES.some((r) => r.value === range) ? range : "",
    from: ISO_DAY.test(from) ? from : "",
    to: ISO_DAY.test(to) ? to : "",
  };
}

/** The href for a set of filters, on the team-wide page or on a resource's own
 *  Activity tab. Defaults are omitted, so "no filters" is `base` itself. */
export function activityHref(p: ActivityParams, base = "/activity"): string {
  const q = new URLSearchParams();
  if (p.actorUserIds.length) q.set("actor", p.actorUserIds.join(","));
  if (p.types.length) q.set("event", p.types.join(","));
  if (p.resourceIds.length) q.set("resource", p.resourceIds.join(","));
  if (p.range) q.set("range", p.range);
  else {
    if (p.from) q.set("from", p.from);
    if (p.to) q.set("to", p.to);
  }
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/**
 * Turn the picked range into the half-open window the query wants. A custom `to`
 * is the last day the reader means to INCLUDE, so it becomes the start of the
 * day after.
 */
export function activityWindow(
  p: ActivityParams,
  now = Date.now(),
): { from?: string; to?: string } {
  const preset = ACTIVITY_RANGES.find((r) => r.value === p.range);
  if (preset)
    return { from: new Date(now - preset.days * 86_400_000).toISOString() };
  return {
    from: p.from ? `${p.from}T00:00:00.000Z` : undefined,
    to: p.to
      ? new Date(Date.parse(`${p.to}T00:00:00.000Z`) + 86_400_000).toISOString()
      : undefined,
  };
}
