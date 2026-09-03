/**
 * The active team lives in the URL: `/<team slug>/apps/<slug>`. Paths are written
 * FLAT everywhere in the code and take the prefix at the navigation boundary only
 * (components/ui/link.tsx, lib/nav.ts, lib/notify/dispatch.ts).
 */

/**
 * The request header that carries the team from the URL to `lib/membership`, and
 * the cookie that remembers the last one visited (for a bare `/`).
 */
export const TEAM_HEADER = "x-deplo-team";
export const ACTIVE_TEAM_COOKIE = "deplo_team";
export const ACTIVE_TEAM_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

/** First segments that live OUTSIDE the dashboard - never a team's page. */
const FLAT_SEGMENTS = [
  "api",
  "engines",
  "install",
  "install-agent",
  "login",
  "migrations",
  "oauth",
  "register",
  "setup",
  "signup",
  "takeover",
  "uninstall",
  "welcome",
  "_next",
] as const;

/** The dashboard's own first segments - these move under the team prefix. */
const TEAM_SECTIONS = [
  "activity",
  "apps",
  "deployments",
  "logs",
  "members",
  "monitoring",
  "new",
  "projects",
  "servers",
  "settings",
  "storage",
  "templates",
  "variables",
] as const;

/**
 * Every first segment that already means something, so none of them may be a
 * team's slug. Enforced when a team is created (lib/data/teams.ts) and, for the
 * router, by the legacy redirect stubs that hold these paths statically.
 */
export const RESERVED_TEAM_SLUGS: ReadonlySet<string> = new Set<string>([
  ...FLAT_SEGMENTS,
  ...TEAM_SECTIONS,
]);

const SECTIONS = new Set<string>(TEAM_SECTIONS);

function firstSegment(pathname: string): string {
  return pathname.split(/[?#]/)[0].split("/")[1] ?? "";
}

/**
 * The team slug a path addresses, or null when it addresses none. A segment
 * carrying a dot is a file (`/logo.svg`), never a team: `slugify` cannot mint one.
 */
export function teamSlugFromPath(pathname: string): string | null {
  const seg = firstSegment(pathname);
  if (!seg || seg.includes(".") || RESERVED_TEAM_SLUGS.has(seg)) return null;
  return seg;
}

/** Whether this path belongs to a team, i.e. whether {@link withTeam} prefixes it. */
function takesTeam(path: string): boolean {
  // "//host/x" is protocol-relative: another origin, however much it looks local.
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  const seg = firstSegment(path);
  // The root, with or without a query.
  if (!seg) return true;
  // Only the dashboard's OWN sections take a team. Anything else is either flat
  // or ALREADY a team's, since nothing but a team can hold a first segment.
  if (!SECTIONS.has(seg)) return false;
  // An asset, by the dot in its LAST segment: /templates/n8n.svg is public/,
  // while /templates is the page.
  const last = path.split(/[?#]/)[0].split("/").pop() ?? "";
  return !last.includes(".");
}

/**
 * `/apps/x?tab=1` in team `acme` -> `/acme/apps/x?tab=1`. A no-op for an absolute
 * URL, a bare query/hash, an asset, a flat path, and a path already in a team.
 */
export function withTeam(
  path: string,
  slug: string | null | undefined,
): string {
  if (!slug || !takesTeam(path)) return path;
  const bare = path === "/" || path.startsWith("/?") || path.startsWith("/#");
  return `/${slug}${bare ? path.slice(1) : path}`;
}

/**
 * Which of the user's teams a request operates in: the one the URL names, else
 * the last one visited, else their first. Both sources take an id or a slug, and
 * a value naming a team that is not in the list selects nothing - which is what
 * makes an invented header or cookie harmless. Needs a non-empty list.
 */
export function pickActiveTeam<T extends { id: string; slug: string }>(
  teams: readonly T[],
  fromUrl: string | null | undefined,
  fromCookie: string | null | undefined,
): T {
  const named = (value: string | null | undefined) =>
    value ? teams.find((t) => t.id === value || t.slug === value) : undefined;
  return named(fromUrl) ?? named(fromCookie) ?? teams[0];
}

/**
 * Mint a team's slug from its name: lowercase, dash-joined, suffixed until it is
 * free. A reserved first segment counts as taken, so "Apps" becomes `apps-2`.
 * The slug is FROZEN once minted - it is also the API's `X-Deplo-Team` value.
 */
export function pickTeamSlug(name: string, taken: Iterable<string>): string {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "team";
  const used = new Set<string>([...RESERVED_TEAM_SLUGS, ...taken]);
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

/**
 * The inverse: strip the team segment so a pathname can be compared with the flat
 * paths the nav model, the breadcrumbs and the command palette are written in.
 */
export function flatPath(pathname: string): string {
  const slug = teamSlugFromPath(pathname);
  if (!slug) return pathname;
  return pathname.slice(slug.length + 1) || "/";
}
