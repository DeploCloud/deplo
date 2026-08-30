// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatDistanceToNowStrict } from "date-fns";
import prettyBytes from "pretty-bytes";

/** Merge Tailwind classes with conflict resolution. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Human-readable byte count, in BINARY units (KiB/MiB/GiB) - the ones `df`,
 * `free`, `htop` and `docker` print. Decimal units made the monitoring page
 * claim 141 GB of a disk `df` called 132G.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "";
  return prettyBytes(Math.max(0, bytes), { binary: true });
}

/** Relative "time ago" formatting (powered by `date-fns`). */
export function timeAgo(input: Date | string | number): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

/** How long ago, with no "ago": `8h`, `1d`, `3mo` - for an uptime, not an event. */
export function sinceShort(input: Date | string | number): string {
  return timeAgoShort(input).replace(/\sago$/, "");
}

/** `timeAgo` with one-letter units: `8h ago`, `1d ago`, `3mo ago`. */
export function timeAgoShort(input: Date | string | number): string {
  return timeAgo(input).replace(
    /(\d+)\s(second|minute|hour|day|week|month|year)s?/,
    (_, n: string, unit: string) => n + SHORT_UNITS[unit],
  );
}

const SHORT_UNITS: Record<string, string> = {
  second: "s",
  minute: "m",
  hour: "h",
  day: "d",
  week: "w",
  month: "mo",
  year: "y",
};

/**
 * An absolute timestamp to sit beside a relative one: `22 Aug, 03:00`. Local to
 * the reader, so a call site that also renders on the server needs
 * `suppressHydrationWarning`.
 */
export function formatDateTime(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A log/build clock as a stable `HH:MM:SS[.mmm]`. UTC on purpose: a locale-aware
 * format renders in the server's timezone during SSR and the browser's during
 * hydration, so the two never match.
 */
export function formatClockTime(ts: string, withMillis = false): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const hms = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return withMillis ? `${hms}.${pad(d.getUTCMilliseconds(), 3)}` : hms;
}

/**
 * How long a build took (or has been running), as `340ms` / `12s` / `2m 5s`.
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
 * "- Section - Deplo" suffix stays visible instead of a long name crowding it out.
 */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max).trimEnd() + "…";
}

/** Display name for a server - the operator-chosen name. */
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
 * stored - same shape and rationale as {@link repoCommitUrl}.
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
 * Where each provider publishes a profile. Self-hosted hosts (GitLab, Gitea) have
 * no fixed origin, so theirs is taken from the repository's own URL.
 */
const PROFILE_ORIGIN: Record<string, string | null> = {
  github: "https://github.com",
  bitbucket: "https://bitbucket.org",
  gitlab: null,
  gitea: null,
};

/**
 * The git-host profile of whoever pushed, or null when there is nothing to link
 * (an unknown host, or a display name that is not a login). Derived, never stored -
 * same shape and rationale as {@link repoCommitUrl}.
 */
export function gitProfileUrl(
  provider: string | null | undefined,
  login: string | null | undefined,
  repoUrl?: string | null,
): string | null {
  const name = login?.trim().replace(/^@/, "");
  if (!provider || !name || !/^[\w.-]+$/.test(name)) return null;
  if (!(provider in PROFILE_ORIGIN)) return null;
  // Every provider's parser falls back to its OWN name when the delivery carries
  // no pusher: that is "we don't know who", not an account to link to.
  if (name.toLowerCase() === provider) return null;
  let origin = PROFILE_ORIGIN[provider];
  if (!origin) {
    try {
      const u = new URL(repoUrl?.trim() ?? "");
      origin = /^https?:$/.test(u.protocol) ? u.origin : null;
    } catch {
      return null;
    }
  }
  return origin ? `${origin}/${name}` : null;
}

/**
 * The `owner/name` slug of a project's GitHub repo, or null when it isn't on
 * GitHub. Strips a trailing `.git`/slash so the commit URL never doubles up
 * (`owner/name.git` / `owner/name/` → `owner/name`).
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
 * built/pulled image.
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
 * Whether an App's deploys MINT AN IMAGE Deplo owns - the one condition a Rollback
 * rests on, and the mirror of the branch `runDeployment` takes.
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
 * What KIND of thing an App is, in one short human phrase - the contextual
 * subtitle its management header falls back to when the App has no domain linked
 * (and therefore no URL to show in that slot).
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
 * Which GitHub App the repo picker opens on. For a NEW app (`initial` undefined -
 * no repo chosen yet) the first connected App is a fine starting point: nothing is
 * asserted, and the user is about to choose one anyway.
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
 * volume. Derived from the slug at render time (never stored) so a rename can't
 * orphan data and `name` stays a label.
 */
export function hostVolumeName(slug: string, name: string): string {
  return `deplo-${slug}-${name}`;
}

/**
 * Validate a user-typed colour without throwing - accepts `#rgb`/`#rrggbb` (with
 * or without the leading `#`, any case).
 */
export function isHexColor(input: string): boolean {
  return /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(input.trim());
}

/**
 * Normalise a colour to a canonical lowercase `#rrggbb`, expanding the `#rgb`
 * shorthand and tolerating a missing `#`.
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
 * Pick the readable foreground (`#000000` or `#ffffff`) for text/icons placed on a
 * solid `hex` background - automatic contrast.
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
 * database form.
 */
export function generatePassword(length = 20): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * A path this app may send the browser back to after a detour off-site (the GitHub
 * App manifest flow) or off-page (Settings → Git).
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  const p = raw?.trim();
  if (!p || !p.startsWith("/")) return null;
  if (p.startsWith("//") || p.startsWith("/\\")) return null;
  if (p.startsWith("/api/")) return null;
  return p;
}
