// TEAM_HEADER carries the team from the URL to `lib/membership`; ACTIVE_TEAM_COOKIE remembers the last one visited.
export const TEAM_HEADER = "x-deplo-team";
export const ACTIVE_TEAM_COOKIE = "deplo_team";
export const ACTIVE_TEAM_TTL_SECONDS = 60 * 60 * 24 * 365;

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

// RESERVED_TEAM_SLUGS - first segments a team's slug may never be; enforced when a team is created (lib/data/teams.ts).
export const RESERVED_TEAM_SLUGS: ReadonlySet<string> = new Set<string>([
  ...FLAT_SEGMENTS,
  ...TEAM_SECTIONS,
]);

const SECTIONS = new Set<string>(TEAM_SECTIONS);

function firstSegment(pathname: string): string {
  return pathname.split(/[?#]/)[0].split("/")[1] ?? "";
}

// teamSlugFromPath - the team a path addresses, or null; a segment with a dot is a file, never a team.
export function teamSlugFromPath(pathname: string): string | null {
  const seg = firstSegment(pathname);
  if (!seg || seg.includes(".") || RESERVED_TEAM_SLUGS.has(seg)) return null;
  return seg;
}

function takesTeam(path: string): boolean {
  // "//host/x" is protocol-relative: another origin, however much it looks local.
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  const seg = firstSegment(path);
  if (!seg) return true;
  if (!SECTIONS.has(seg)) return false;
  const last = path.split(/[?#]/)[0].split("/").pop() ?? "";
  return !last.includes(".");
}

// withTeam - `/apps/x` in team `acme` becomes `/acme/apps/x`; a no-op for an absolute URL, an asset, a flat path or a path already in a team.
export function withTeam(
  path: string,
  slug: string | null | undefined,
): string {
  if (!slug || !takesTeam(path)) return path;
  const bare = path === "/" || path.startsWith("/?") || path.startsWith("/#");
  return `/${slug}${bare ? path.slice(1) : path}`;
}

// pickActiveTeam - the team the URL names, else the last visited, else the first; a value not in the list selects nothing, so an invented header is harmless.
export function pickActiveTeam<T extends { id: string; slug: string }>(
  teams: readonly T[],
  fromUrl: string | null | undefined,
  fromCookie: string | null | undefined,
): T {
  const named = (value: string | null | undefined) =>
    value ? teams.find((t) => t.id === value || t.slug === value) : undefined;
  return named(fromUrl) ?? named(fromCookie) ?? teams[0];
}

// pickTeamSlug - lowercase, dash-joined, suffixed until free; FROZEN once minted, it is also the API's X-Deplo-Team value.
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

// flatPath - strip the team segment so a pathname compares against the flat paths the nav model is written in.
export function flatPath(pathname: string): string {
  const slug = teamSlugFromPath(pathname);
  if (!slug) return pathname;
  return pathname.slice(slug.length + 1) || "/";
}
