import "server-only";

import { revalidateTag } from "next/cache";

import {
  DEPLO_VERSION,
  DEPLO_REPO,
  isNewer,
  resolveExpectedAgentVersion,
} from "../version";
import { requireInstanceAdmin } from "../membership";

/** Result of checking the upstream GitHub repository for a newer release. */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  url: string | null;
  name: string | null;
  publishedAt: string | null;
  checkedAt: string;
  error?: string;
}

/** One published release of Deplo, as the changelog renders it. */
export interface DeploRelease {
  /** The release tag, as GitHub spells it ("v0.2.0"). */
  tag: string;
  name: string;
  url: string;
  publishedAt: string | null;
  /** Release notes, markdown, truncated. */
  body: string;
  prerelease: boolean;
  /** This is the version the instance is running. */
  current: boolean;
}

/** The cache tag both GitHub reads carry, so one refresh busts them together. */
const RELEASES_TAG = "deplo-releases";

/** Releases move slowly, and the anonymous GitHub bucket is 60 calls an hour. */
const CACHED = {
  cache: "force-cache",
  next: { revalidate: 3600, tags: [RELEASES_TAG] },
} satisfies RequestInit;

const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "deplo-control-plane",
};

const TIMEOUT_MS = 5000;
const MAX_RELEASES = 20;
/** Notes long enough to matter link out instead of shipping in the payload. */
const MAX_BODY = 4000;

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** Strip a single leading v/V so a tag and a bare version compare equal. */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}

/**
 * GitHub answers 60 unauthenticated calls an hour per IP, shared by every check
 * this instance makes. Exhausting it is a wait, not a fault, and "403" alone
 * reads like a permission problem.
 */
function describeFailure(res: Response): string {
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const minutes = Number.isFinite(reset)
      ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000))
      : null;
    const wait = minutes
      ? ` It resets in ${minutes} minute${minutes === 1 ? "" : "s"}.`
      : "";
    return `GitHub's hourly limit for this instance is used up.${wait}`;
  }
  return `GitHub API returned ${res.status}`;
}

async function fetchUpdateInfo(init: RequestInit): Promise<UpdateInfo> {
  const base: UpdateInfo = {
    current: DEPLO_VERSION,
    latest: null,
    updateAvailable: false,
    url: null,
    name: null,
    publishedAt: null,
    checkedAt: new Date().toISOString(),
  };

  try {
    const res = await fetch(
      `https://api.github.com/repos/${DEPLO_REPO}/releases/latest`,
      {
        headers: GH_HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...init,
      },
    );

    if (res.status === 404) return base; // no releases published yet
    if (!res.ok) return { ...base, error: describeFailure(res) };

    const json = (await res.json()) as GitHubRelease;
    const tag = typeof json.tag_name === "string" ? json.tag_name : null;
    if (!tag) return base;

    return {
      ...base,
      latest: tag,
      updateAvailable: isNewer(tag, DEPLO_VERSION),
      url:
        typeof json.html_url === "string"
          ? json.html_url
          : `https://github.com/${DEPLO_REPO}/releases`,
      name: typeof json.name === "string" && json.name ? json.name : tag,
      publishedAt:
        typeof json.published_at === "string" ? json.published_at : null,
    };
  } catch (e) {
    return {
      ...base,
      error: e instanceof Error ? e.message : "Update check failed",
    };
  }
}

/**
 * Ask GitHub for the latest published release of the Deplo repository and compare
 * it with the running version. Cached for an hour under {@link RELEASES_TAG}.
 */
export async function getUpdateInfo(): Promise<UpdateInfo> {
  return fetchUpdateInfo(CACHED);
}

/**
 * Re-ask GitHub, ignoring the cache, and expire the tag so the changelog beside
 * it re-reads too. `no-store` rather than the tag alone: a "Check now" that
 * answers with the hour-old body is the bug this replaces.
 */
export async function refreshUpdateInfo(): Promise<UpdateInfo> {
  await requireInstanceAdmin();
  revalidateTag(RELEASES_TAG, { expire: 0 });
  return fetchUpdateInfo({ cache: "no-store" });
}

/**
 * The published releases of Deplo, newest first - the changelog the panel shows
 * so "what changed" has an answer that is not a GitHub tab.
 */
export async function listDeploReleases(): Promise<{
  releases: DeploRelease[];
  error?: string;
}> {
  await requireInstanceAdmin();
  try {
    const res = await fetch(
      `https://api.github.com/repos/${DEPLO_REPO}/releases?per_page=${MAX_RELEASES}`,
      {
        headers: GH_HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...CACHED,
      },
    );

    if (res.status === 404) return { releases: [] }; // nothing published yet
    if (!res.ok) return { releases: [], error: describeFailure(res) };

    const json = (await res.json()) as GitHubRelease[];
    if (!Array.isArray(json)) return { releases: [] };

    const releases = json
      .filter((r): r is GitHubRelease => !!r && !r.draft)
      .map((r) => {
        const tag = typeof r.tag_name === "string" ? r.tag_name.trim() : "";
        if (!tag) return null;
        const url =
          typeof r.html_url === "string"
            ? r.html_url
            : `https://github.com/${DEPLO_REPO}/releases/tag/${tag}`;
        const body = typeof r.body === "string" ? r.body.trim() : "";
        return {
          tag,
          name: typeof r.name === "string" && r.name ? r.name : tag,
          url,
          publishedAt:
            typeof r.published_at === "string" ? r.published_at : null,
          body:
            body.length > MAX_BODY
              ? `${body.slice(0, MAX_BODY)}\n\n[Read the full notes on GitHub](${url})`
              : body,
          prerelease: r.prerelease === true,
          current: normalizeTag(tag) === DEPLO_VERSION,
        };
      })
      .filter((r): r is DeploRelease => r !== null);

    return { releases };
  } catch (e) {
    return {
      releases: [],
      error: e instanceof Error ? e.message : "Could not read the changelog",
    };
  }
}

/**
 * Re-resolve the latest agent release from GitHub, bypassing the in-process cache,
 * and return the version the fleet is now expected to run.
 */
export async function refreshAgentVersion(): Promise<string> {
  await requireInstanceAdmin();
  const { refreshAgentRelease } = await import("../agent/release");
  await refreshAgentRelease();
  // Re-resolve through the standard helper so the fallback rule (GitHub
  // unreachable -> FALLBACK_AGENT_VERSION) stays in one place; it re-populates
  // the memo, so the RSC re-render that follows reuses this fresh value.
  return resolveExpectedAgentVersion();
}
