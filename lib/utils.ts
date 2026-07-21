import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatDistanceToNowStrict } from "date-fns";
import prettyBytes from "pretty-bytes";

/** Merge Tailwind classes with conflict resolution. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Human-readable byte count (powered by `pretty-bytes`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "";
  return prettyBytes(Math.max(0, bytes));
}

/** Relative "time ago" formatting (powered by `date-fns`). */
export function timeAgo(input: Date | string | number): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

/** Title-case a slug or kebab string. */
export function titleCase(input: string): string {
  return input.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Truncate `str` to at most `max` characters, appending an ellipsis when cut.
 * Used to cap the project-name portion of page titles so the trailing
 * "– Section – Deplo" suffix stays visible instead of a long name crowding it out.
 */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max).trimEnd() + "…";
}

/** Display name for a server — the operator-chosen name. */
export function serverLabel(server: { name: string }): string {
  return server.name;
}

/** Human label for a deploy source. */
export function deploySourceLabel(source: string): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "git":
      return "Git repository";
    case "docker-image":
      return "Docker image";
    case "upload":
      return "Upload";
    case "compose":
      return "Docker Compose";
    default:
      return titleCase(source);
  }
}

/**
 * The GitHub URL for a specific commit of a project's source, or `null` when the
 * project is NOT deployed from a GitHub repo (only GitHub is linkable here —
 * GitLab/Bitbucket use different commit paths). `repo.repo` is the `owner/name`
 * slug, so the result is `https://github.com/owner/name/commit/<sha>`. Structural
 * param so both `GitRepo` and a `{provider, repo}` projection satisfy it.
 */
export function githubCommitUrl(
  repo:
    | { provider?: string | null; repo?: string | null; url?: string | null }
    | null
    | undefined,
  sha: string | null | undefined,
): string | null {
  const commit = sha?.trim();
  if (!repo || !commit) return null;
  const slug = githubRepoSlug(repo);
  return slug ? `https://github.com/${slug}/commit/${commit}` : null;
}

/**
 * The `owner/name` slug of a project's GitHub repo, or null when it isn't on
 * GitHub. Handles the GitHub-App source (provider "github", `repo` already the
 * slug) AND a plain-git source whose URL happens to be on github.com (https or
 * `git@` SSH form). Strips a trailing `.git`/slash so the commit URL never
 * doubles up (`owner/name.git` / `owner/name/` → `owner/name`).
 */
function githubRepoSlug(repo: {
  provider?: string | null;
  repo?: string | null;
  url?: string | null;
}): string | null {
  const clean = (s: string) =>
    s.trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (repo.provider === "github" && repo.repo?.trim()) return clean(repo.repo);
  const m = repo.url?.trim().match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return m ? clean(m[1]) : null;
}

/**
 * Whether a project deploys its own docker-compose stack rather than a single
 * built/pulled image. `compose` is authoritative; the legacy heuristic (a
 * stored compose with no repo/image) catches template services created before
 * the `compose` source existed. An "upload" source is always a single-image
 * build, so it is excluded even if a stale compose lingers from a former source
 * (setAppUpload nulls repo/image but keeps compose for switching back).
 *
 * One source of truth so the deploy pipeline (runDeployment, rerouteApp)
 * and the settings UI can never disagree about whether a project is a stack.
 */
export function usesComposeStack(project: {
  source: string;
  compose: string | null;
  repo: unknown | null;
  dockerImage: string | null;
}): boolean {
  const hasCompose = Boolean(project.compose && project.compose.trim());
  return (
    project.source === "compose" ||
    (project.source !== "upload" &&
      hasCompose &&
      !project.repo &&
      !project.dockerImage)
  );
}

/**
 * What KIND of thing an App is, in one short human phrase — the contextual
 * subtitle its management header falls back to when the App has no domain
 * linked (and therefore no URL to show in that slot). Deliberately coarse: it
 * answers "what am I looking at", not "where does the code come from" (that is
 * {@link deploySourceLabel} / `describeAppSource`, shown on the Overview). The
 * only distinction worth drawing here is single-container vs. multi-service,
 * because that is the one that changes what the rest of the UI does.
 */
export function appTypeLabel(app: {
  source: string;
  compose: string | null;
  repo: unknown | null;
  dockerImage: string | null;
}): string {
  return usesComposeStack(app) ? "Compose app" : "Application";
}

/**
 * The host-global docker volume name for a single-container project's named
 * volume. A volume name is GLOBAL on the daemon (like container_name was —
 * compose strips it to avoid collisions) and the host is shared across teams,
 * so it MUST be namespaced per project. Derived from the slug at render time
 * (never stored) so a rename can't orphan data and `name` stays a label.
 */
export function hostVolumeName(slug: string, name: string): string {
  return `deplo-${slug}-${name}`;
}

/**
 * Validate a user-typed colour without throwing — accepts `#rgb`/`#rrggbb`
 * (with or without the leading `#`, any case). Used for live client-side input
 * validation; {@link normalizeHexColor} is the throwing, normalising sibling
 * used at the trust boundary (the data layer).
 */
export function isHexColor(input: string): boolean {
  return /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(input.trim());
}

/**
 * Normalise a colour to a canonical lowercase `#rrggbb`, expanding the `#rgb`
 * shorthand and tolerating a missing `#`. Throws on anything that is not a valid
 * hex colour, so callers can persist the result verbatim and every stored colour
 * is the same shape (cheap parsing in {@link readableTextColor}).
 */
export function normalizeHexColor(input: string): string {
  const raw = input.trim().replace(/^#/, "").toLowerCase();
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(raw)) {
    throw new Error("Enter a valid hex colour, e.g. #3b82f6.");
  }
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  return `#${full}`;
}

/**
 * Pick the readable foreground (`#000000` or `#ffffff`) for text/icons placed on
 * a solid `hex` background — automatic contrast. Uses the WCAG relative
 * luminance with the 0.179 crossover (the luminance at which black and white
 * text have equal contrast), so a folder's chosen colour never produces an
 * unreadable label. Defensive: an unparseable colour falls back to dark text.
 */
export function readableTextColor(hex: string): "#000000" | "#ffffff" {
  // Parse defensively (no throwing): tolerate a missing `#`, any case, and the
  // `#rgb` shorthand; anything unparseable falls back to dark text.
  const raw = hex.trim().replace(/^#/, "").toLowerCase();
  const full = /^[0-9a-f]{3}$/.test(raw)
    ? raw
        .split("")
        .map((c) => c + c)
        .join("")
    : raw;
  if (!/^[0-9a-f]{6}$/.test(full)) return "#000000";
  const n = parseInt(full, 16);
  const channels = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum =
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return lum > 0.179 ? "#000000" : "#ffffff";
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/** Deterministic short id for client-only keys (not for security). */
export function shortId(length = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * A client-side password suggestion for the "Generate" affordance on the create-
 * database form. Drawn from an alphabet that is safe both inside a connection-
 * string URL and a compose env-file (no `@ / : ? # % $ \ ` [ ] `, no whitespace),
 * so it always passes the server's `assertPasswordSafe`. Not the server's
 * `randomToken` (that is server-only) — this is only a suggestion the user can
 * edit; the value is validated server-side on create regardless.
 */
export function generatePassword(length = 20): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
