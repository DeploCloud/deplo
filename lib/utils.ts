import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatDistanceToNowStrict } from "date-fns";
import prettyBytes from "pretty-bytes";

// cn - merge Tailwind classes with conflict resolution.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// formatBytes - human-readable byte count in BINARY units (KiB/MiB/GiB), the ones `df`, `free` and `docker` print.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "";
  return prettyBytes(Math.max(0, bytes), { binary: true });
}

// timeAgo - relative "time ago" formatting.
export function timeAgo(input: Date | string | number): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

// sinceShort - how long ago with no "ago": `8h`, `1d`, `3mo`.
export function sinceShort(input: Date | string | number): string {
  return timeAgoShort(input).replace(/\sago$/, "");
}

// timeAgoShort - `timeAgo` with one-letter units: `8h ago`, `1d ago`, `3mo ago`.
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

// formatDateTime - `22 Aug, 03:00`, local to the reader, so a call site that also renders on the server needs `suppressHydrationWarning`.
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

// formatClockTime - a stable `HH:MM:SS[.mmm]`; UTC on purpose, a locale-aware format never matches between SSR and hydration.
export function formatClockTime(ts: string, withMillis = false): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const hms = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return withMillis ? `${hms}.${pad(d.getUTCMilliseconds(), 3)}` : hms;
}

// formatBuildDuration - how long a build took, as `340ms` / `12s` / `2m 5s`.
export function formatBuildDuration(ms: number | null): string {
  if (ms == null) return "";
  const total = Math.max(0, Math.floor(ms));
  if (total < 1_000) return `${total}ms`;
  const s = Math.floor(total / 1_000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// titleCase - title-case a slug or kebab string.
export function titleCase(input: string): string {
  return input.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// truncate - cut `str` to at most `max` characters, appending an ellipsis.
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max).trimEnd() + "…";
}

// serverLabel - display name for a server, the operator-chosen name.
export function serverLabel(server: { name: string }): string {
  return server.name;
}

// Not read off the provider adapters: this module is client-imported and they pull in `node:crypto`.
const COMMIT_PATH: Record<string, string> = {
  github: "/commit/",
  gitea: "/commit/",
  gitlab: "/-/commit/",
  bitbucket: "/commits/",
};

// repoCommitUrl - the URL for a commit of an app's source, or null when there is nothing linkable.
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

// githubPullRequestUrl - the URL of the pull request a deployment was built from, or null. Derived, never stored.
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

// Self-hosted hosts (GitLab, Gitea) have no fixed origin, so theirs comes from the repository's own URL.
const PROFILE_ORIGIN: Record<string, string | null> = {
  github: "https://github.com",
  bitbucket: "https://bitbucket.org",
  gitlab: null,
  gitea: null,
};

// gitProfileUrl - the git-host profile of whoever pushed, or null when there is nothing to link.
export function gitProfileUrl(
  provider: string | null | undefined,
  login: string | null | undefined,
  repoUrl?: string | null,
): string | null {
  const name = login?.trim().replace(/^@/, "");
  if (!provider || !name || !/^[\w.-]+$/.test(name)) return null;
  if (!(provider in PROFILE_ORIGIN)) return null;
  // Every provider's parser falls back to its OWN name when the delivery carries no pusher.
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

// usesComposeStack - whether an App deploys its own compose stack rather than a single built or pulled image.
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

// appBuildsItsOwnImage - whether an App's deploys MINT AN IMAGE Deplo owns, the one condition a Rollback rests on.
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

// appTypeLabel - what KIND of thing an App is, in one short human phrase.
export function appTypeLabel(app: {
  source: string;
  compose: string | null;
  repo: unknown | null;
  dockerImage: string | null;
}): string {
  return usesComposeStack(app) ? "Compose app" : "Application";
}

// pickerInstallationId - which GitHub App the repo picker opens on.
export function pickerInstallationId(
  initial: { installationId?: string | null } | undefined,
  installations: { id: string }[],
): string {
  if (!initial) return installations[0]?.id ?? "";
  return installations.some((i) => i.id === initial.installationId)
    ? initial.installationId!
    : "";
}

// repoCredentialMissing - whether an App claims a git credential it does not have.
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

// hostVolumeName - the host-global volume name for a single-container App, derived from the slug so a rename cannot orphan data.
export function hostVolumeName(slug: string, name: string): string {
  return `deplo-${slug}-${name}`;
}

// isHexColor - validate a user-typed colour without throwing: `#rgb` or `#rrggbb`, the `#` optional.
export function isHexColor(input: string): boolean {
  return /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(input.trim());
}

// normalizeHexColor - normalise a colour to a canonical lowercase `#rrggbb`.
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

// readableTextColor - the readable foreground (`#000000` or `#ffffff`) for text on a solid `hex` background.
export function readableTextColor(hex: string): "#000000" | "#ffffff" {
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

// mapLimit - run `fn` over `items` with at most `limit` in flight at once.
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

// shortId - short id for client-only keys, not for security.
export function shortId(length = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// safeReturnPath - a path this app may send the browser back to after a detour off-site or off-page.
export function safeReturnPath(raw: string | null | undefined): string | null {
  const p = raw?.trim();
  if (!p || !p.startsWith("/")) return null;
  if (p.startsWith("//") || p.startsWith("/\\")) return null;
  if (p.startsWith("/api/")) return null;
  return p;
}
