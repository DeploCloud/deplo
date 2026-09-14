import { MAX_LOGO_BYTES } from "./logo-shared";
import { usesComposeStack } from "../utils";

// Every value is a type isValidLogoValue accepts, so a detected favicon always validates.
const EXT_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webp: "image/webp",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

// mimeForFaviconPath - the stored-logo MIME for a path's extension, or null.
export function mimeForFaviconPath(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return EXT_MIME[ext] ?? null;
}

const EXCLUDED_DIR_RE =
  /^(node_modules|bower_components|vendor|\.git|\.github|\.next|\.nuxt|\.svelte-kit|\.cache|\.turbo|dist|build|out|coverage|tmp|temp|__tests__|__mocks__|tests?|e2e|examples?|samples?|fixtures?|docs?|storybook|\.storybook)$/i;

// isGithubRepo - the only provider the control plane can read files from over the API.
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

// FaviconSourceKind - which pile of files an app's icon is detected from; the detector and the settings UI share it.
export type FaviconSourceKind =
  "github" | "connection" | "upload" | "app-files" | "none";

export function faviconSourceKind(app: {
  source: string;
  compose: string | null;
  repo?: {
    provider?: string | null;
    url?: string | null;
    connectionId?: string | null;
  } | null;
  dockerImage: string | null;
}): FaviconSourceKind {
  if (usesComposeStack({ ...app, repo: app.repo ?? null })) return "app-files";
  // A connection names the API outright, so it is checked before the URL-sniffing github test.
  if (app.repo?.connectionId) return "connection";
  if (isGithubRepo(app.repo)) return "github";
  if (app.source === "upload") return "upload";
  return "none";
}

// isExcludedDirName - whether a directory name is one detection should never descend into.
export function isExcludedDirName(name: string): boolean {
  return EXCLUDED_DIR_RE.test(name);
}

// Only a file named `favicon`, with an optional suffix: never an arbitrarily-named image.
const FAVICON_STEM_RE = /^favicon(?:[-_.].*)?$/;

const EXT_SCORES: Record<string, number> = {
  svg: 40,
  png: 32,
  ico: 24,
  webp: 16,
  gif: 10,
  jpg: 8,
  jpeg: 8,
};

// faviconFormatScore - the format preference above, for the detector that reads a running app's declared icons.
export function faviconFormatScore(ext: string): number {
  return EXT_SCORES[ext.toLowerCase()] ?? 0;
}

function locationScore(segments: readonly string[]): number {
  const dir = segments.slice(0, -1).map((s) => s.toLowerCase());
  if (dir.length === 0) return 6;
  const head = dir[0];
  if (head === "public") return 15;
  if (head === "static" || head === "assets") return 12;
  if (head === "app") return 14; // Next.js app-router icon.svg / favicon
  if (head === "src") return 8;
  if (
    head === "www" ||
    head === "web" ||
    head === "client" ||
    head === "frontend"
  )
    return 7;
  return 3;
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s && s !== ".");
}

// scoreFaviconPath - score one repo-relative path as a favicon candidate.
export function scoreFaviconPath(path: string, rootRel = ""): number | null {
  const segments = segmentsOf(path);
  if (segments.length === 0) return null;
  if (segments.slice(0, -1).some((s) => EXCLUDED_DIR_RE.test(s))) return null;

  const base = segments[segments.length - 1].toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1);
  const extScore = EXT_SCORES[ext];
  if (extScore === undefined) return null;

  const stem = base.slice(0, dot);
  if (!FAVICON_STEM_RE.test(stem)) return null;

  const depthPenalty = Math.min(segments.length - 1, 8);
  const rootSegs = rootRel ? segmentsOf(rootRel) : [];
  const insideRoot =
    rootSegs.length > 0 &&
    rootSegs.every(
      (seg, i) => segments[i]?.toLowerCase() === seg.toLowerCase(),
    );
  const rootBonus = rootSegs.length > 0 ? (insideRoot ? 20 : -8) : 0;

  return extScore + locationScore(segments) + rootBonus - depthPenalty;
}

export interface FaviconFile {
  path: string;
  size: number;
}

// pickBestFavicon - the best candidate, or null; ties break on the smaller path so a repo always yields the same icon.
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
