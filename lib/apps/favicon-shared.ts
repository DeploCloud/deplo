/**
 * Pure logic for auto-detecting a service's display logo from a favicon/icon
 * shipped in its own source files (a GitHub repo or an uploaded archive). Kept
 * free of any `server-only` / Node-only import so it is unit-testable in
 * isolation — the file-listing and the byte-fetching live in the server-only
 * {@link file://./favicon-detect.ts} module, which calls into here to RANK.
 *
 * We ONLY pick a file literally named `favicon` (favicon.svg / .ico / .png /
 * .jpg / …) that the app itself ships — never `logo.*`, `icon.*`,
 * `apple-touch-icon.*` or any other name. The caller inlines its bytes as a
 * base64 data-URI (the one storable logo shape — see
 * {@link file://./logo-shared.ts}). No remote favicon is fetched at render time,
 * so the strict dashboard CSP is preserved.
 */

import { MAX_LOGO_BYTES } from "./logo-shared";

/** Image extensions we accept for a detected favicon, mapped to their stored
 * MIME. Every value is a type `isValidLogoValue` accepts (incl. `.ico` ⇒
 * image/x-icon), so a detected favicon always validates. */
const EXT_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webp: "image/webp",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** The stored-logo MIME for a path's extension, or null if it isn't a candidate
 * image type. Case-insensitive. */
export function mimeForFaviconPath(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return EXT_MIME[ext] ?? null;
}

/** Directory segments that never hold a project's OWN icon — dependencies,
 * build output, examples, test fixtures, VCS/tooling metadata. A candidate under
 * any of these is discarded outright so we don't lift a favicon out of, say, a
 * vendored library or a Storybook example. */
const EXCLUDED_DIR_RE =
  /^(node_modules|bower_components|vendor|\.git|\.github|\.next|\.nuxt|\.svelte-kit|\.cache|\.turbo|dist|build|out|coverage|tmp|temp|__tests__|__mocks__|tests?|e2e|examples?|samples?|fixtures?|docs?|storybook|\.storybook)$/i;

/**
 * Whether a service's repo is GitHub-hosted — the ONLY provider the control
 * plane can read files from over the API for favicon auto-detection (a git repo
 * is otherwise cloned only on the deploy agent). True for the GitHub App
 * provider, or any repo whose URL is on github.com (a plain-git import of a
 * public GitHub URL). Pure + client-safe so the settings page can gate the
 * "Detect from source" button on the SAME test the detector uses — the `source`
 * string is NOT reliable here (a GitHub import is `source: "github"`, a bare git
 * URL is `source: "git"`; both carry a repo). One source of truth.
 */
export function isGithubRepo(
  repo: { provider?: string | null; url?: string | null } | null | undefined,
): boolean {
  if (!repo) return false;
  if (repo.provider === "github") return true;
  try {
    return new URL(repo.url ?? "").hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

/** Whether a single directory NAME is one detection should never descend into
 * (dependencies, build output, VCS/tooling metadata). Exported so the tree walk
 * can prune these while descending — same set the scorer rejects candidates
 * under, kept as one source of truth. */
export function isExcludedDirName(name: string): boolean {
  return EXCLUDED_DIR_RE.test(name);
}

/**
 * The ONLY basename (without extension) we accept: `favicon`, optionally with a
 * size/variant suffix after a separator (`favicon-32x32`, `favicon_v2`,
 * `favicon.prod`). Matched case-insensitively. Deliberately strict — `logo`,
 * `icon`, `apple-touch-icon`, `android-chrome`, etc. are NOT favicons and are
 * rejected. We never guess a site icon from an arbitrarily-named image.
 */
const FAVICON_STEM_RE = /^favicon(?:[-_.].*)?$/;

/** Extension preference (the ONLY thing that ranks two `favicon.*` siblings):
 * a scalable SVG beats any raster; PNG (lossless, usually higher-res) beats a
 * small multi-res ICO; lossy formats rank last. */
const EXT_SCORES: Record<string, number> = {
  svg: 40,
  png: 32,
  ico: 24,
  webp: 16,
  gif: 10,
  jpg: 8,
  jpeg: 8,
};

/** Well-known asset dirs where a real app icon lives. A deeper bonus tie-breaks
 * toward the conventional home (`public/`, static roots, app-router). */
function locationScore(segments: readonly string[]): number {
  const dir = segments.slice(0, -1).map((s) => s.toLowerCase());
  if (dir.length === 0) return 6; // repo root: e.g. a bare favicon.svg
  const head = dir[0];
  if (head === "public") return 15;
  if (head === "static" || head === "assets") return 12;
  if (head === "app") return 14; // Next.js app-router icon.svg / favicon
  if (head === "src") return 8;
  if (head === "www" || head === "web" || head === "client" || head === "frontend")
    return 7;
  return 3;
}

/** Split a POSIX-style relative path into clean segments (drops `.`/empty). */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s && s !== ".");
}

/**
 * Score a single repo-relative file path as a favicon candidate. Returns a
 * number (higher = better) or `null` when the path is not a candidate — its
 * basename isn't `favicon(.*)?`, its extension isn't a supported image, or it
 * lives under an excluded directory. Among the `favicon.*` that qualify, the
 * winner is decided by extension, then location, then the build `rootDirectory`
 * (a monorepo's chosen sub-app wins over a sibling), then shallower depth.
 */
export function scoreFaviconPath(path: string, rootRel = ""): number | null {
  const segments = segmentsOf(path);
  if (segments.length === 0) return null;
  if (segments.slice(0, -1).some((s) => EXCLUDED_DIR_RE.test(s))) return null;

  const base = segments[segments.length - 1].toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile
  const ext = base.slice(dot + 1);
  const extScore = EXT_SCORES[ext];
  if (extScore === undefined) return null;

  const stem = base.slice(0, dot);
  if (!FAVICON_STEM_RE.test(stem)) return null; // ONLY a file named `favicon`

  // Prefer shallower paths (a favicon at the app root over one buried deep), and
  // give a clear bump to anything inside the build rootDirectory.
  const depthPenalty = Math.min(segments.length - 1, 8);
  const rootSegs = rootRel ? segmentsOf(rootRel) : [];
  const insideRoot =
    rootSegs.length > 0 &&
    rootSegs.every((seg, i) => segments[i]?.toLowerCase() === seg.toLowerCase());
  const rootBonus = rootSegs.length > 0 ? (insideRoot ? 20 : -8) : 0;

  return extScore + locationScore(segments) + rootBonus - depthPenalty;
}

export interface FaviconFile {
  /** Repo/tree-relative POSIX path. */
  path: string;
  /** Size in bytes (0 when unknown — never filtered out on an unknown size). */
  size: number;
}

/**
 * Pick the single best logo candidate from a list of files, or null when none
 * qualifies. Files larger than the stored-logo cap are dropped (a base64 inline
 * of them would exceed {@link MAX_LOGO_BYTES}); an unknown size (0) is kept and
 * size-checked after the bytes are read. Ties break deterministically on the
 * lexicographically smaller path so the same repo always yields the same icon.
 */
export function pickBestFavicon(
  files: readonly FaviconFile[],
  opts: { rootRel?: string } = {},
): FaviconFile | null {
  let best: { file: FaviconFile; score: number } | null = null;
  for (const file of files) {
    if (file.size > MAX_LOGO_BYTES) continue;
    const score = scoreFaviconPath(file.path, opts.rootRel ?? "");
    if (score === null) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && file.path < best.file.path)
    ) {
      best = { file, score };
    }
  }
  return best?.file ?? null;
}
