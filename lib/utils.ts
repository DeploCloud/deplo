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

/**
 * How long a build took (or has been running), as `340ms` / `12s` / `2m 5s`.
 * Empty for a missing duration so a caller can render its own placeholder.
 *
 * Under a second the unit drops to milliseconds rather than collapsing to "0s":
 * an app that redeploys in a few hundred milliseconds took a real, reportable
 * amount of time, and rounding it away reads as "not measured".
 *
 * Rounds DOWN at every scale, because the same formatter feeds a timer that
 * ticks live while a build runs: a clock that shows "1s" 400ms in is lying, and
 * a finished build must not be able to report more time than it actually took.
 */
export function formatBuildDuration(ms: number | null): string {
  if (ms == null) return "";
  const total = Math.max(0, Math.floor(ms));
  if (total < 1_000) return `${total}ms`;
  const s = Math.floor(total / 1_000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
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
 * Where each provider puts a commit under the repository's own URL. Kept here
 * rather than read off the provider adapters because this module is imported by
 * client components and the adapters pull in `node:crypto`.
 */
const COMMIT_PATH: Record<string, string> = {
  github: "/commit/",
  gitea: "/commit/",
  gitlab: "/-/commit/",
  bitbucket: "/commits/",
};

/**
 * The URL for a specific commit of an app's source, or `null` when there is
 * nothing linkable (no sha, or a host whose commit path we don't know - a plain
 * git server has no web UI to guess at).
 *
 * GitHub is resolved from the `owner/name` slug, so a plain-git source that
 * happens to point at github.com still links. Every other provider appends its
 * own path to the stored repository URL, which IS the browsable base.
 * Structural param so both `GitRepo` and a `{provider, repo}` projection fit.
 */
export function repoCommitUrl(
  repo:
    | { provider?: string | null; repo?: string | null; url?: string | null }
    | null
    | undefined,
  sha: string | null | undefined,
): string | null {
  const commit = sha?.trim();
  if (!repo || !commit) return null;
  const slug = githubRepoSlug(repo);
  if (slug) return `https://github.com/${slug}/commit/${commit}`;
  const path = COMMIT_PATH[repo.provider ?? ""];
  const base = repo.url
    ?.trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!path || !base || !/^https?:\/\//i.test(base)) return null;
  return `${base}${path}${commit}`;
}

/**
 * The GitHub URL of a pull request a deployment was built from, or null for a
 * production build (no pull request) or a non-GitHub source. Derived, never
 * stored — same shape and rationale as {@link repoCommitUrl}.
 */
export function githubPullRequestUrl(
  repo:
    | { provider?: string | null; repo?: string | null; url?: string | null }
    | null
    | undefined,
  prNumber: number | null | undefined,
): string | null {
  if (!repo || !prNumber) return null;
  const slug = githubRepoSlug(repo);
  return slug ? `https://github.com/${slug}/pull/${prNumber}` : null;
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
    s
      .trim()
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "");
  if (repo.provider === "github" && repo.repo?.trim()) return clean(repo.repo);
  const m = repo.url
    ?.trim()
    .match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
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
 * Whether an App's deploys MINT AN IMAGE Deplo owns - the one condition a
 * Rollback rests on, and the mirror of the branch `runDeployment` takes.
 *
 * True only for a source Deplo builds: a repository or an uploaded archive. A
 * compose stack has no single image (each service brings its own), and a prebuilt
 * `docker-image` source is a mutable registry tag with nothing pinned behind it,
 * so "back" would land on whatever that tag points at today.
 *
 * It has to be asked of the app AS IT IS NOW, not of the deployment: an app that
 * used to build from git and has since been switched to a compose stack still has
 * old rows carrying an `image_ref`, and `runDeployment` would take its compose
 * branch and quietly redeploy the current stack while the row claimed to be a
 * rollback. One predicate, shared by the list, the detail page and the gate, so
 * none of the three can offer what the pipeline would not honour.
 */
export function appBuildsItsOwnImage(project: {
  source: string;
  compose: string | null;
  repo: unknown | null;
  dockerImage: string | null;
}): boolean {
  if (usesComposeStack(project)) return false;
  return (
    project.source === "github" ||
    project.source === "git" ||
    project.source === "upload"
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
 * Which GitHub App the repo picker opens on.
 *
 * For a NEW app (`initial` undefined - no repo chosen yet) the first connected
 * App is a fine starting point: nothing is asserted, and the user is about to
 * choose one anyway. For an app that ALREADY has a repo, falling back to the
 * first App DRAWS A CONNECTION THE APP DOES NOT HAVE - an imported app carries a
 * repo with no installation, and a re-installed App re-keys the row this used to
 * point at. Both then READ as linked while `resolveCloneUrl` takes its third
 * branch and clones anonymously, which is how an app ends up failing to deploy
 * from a repository the UI says it is connected to.
 *
 * Empty string instead: the picker says "not connected", which is the truth, and
 * a credential the user never chose cannot be stitched onto a save.
 */
export function pickerInstallationId(
  initial: { installationId?: string | null } | undefined,
  installations: { id: string }[],
): string {
  if (!initial) return installations[0]?.id ?? "";
  return installations.some((i) => i.id === initial.installationId)
    ? initial.installationId!
    : "";
}

/**
 * Whether an App claims a git credential it does not have.
 *
 * `source: "github"` means "clone through a connected GitHub App". With no
 * installation stored the row contradicts itself: the deploy will clone
 * anonymously, which fails on a private repository and cannot receive a webhook
 * either (both webhook routes find apps BY the credential id).
 *
 * A bare "Repository URL" with no connection is NOT this. Cloning a public repo
 * anonymously is exactly what that source is for, so widening this to "no
 * credential" would flag apps that deploy perfectly well - and a warning on a
 * healthy app is what teaches people to ignore the warning.
 */
export function repoCredentialMissing(app: {
  source: string;
  repo: { installationId?: string | null; connectionId?: string | null } | null;
}): boolean {
  return (
    app.source === "github" &&
    !!app.repo &&
    !app.repo.installationId &&
    !app.repo.connectionId
  );
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
