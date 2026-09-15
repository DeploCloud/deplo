import "server-only";

import { revalidateTag } from "next/cache";

import { hostname } from "node:os";

import { DEPLO_VERSION, DEPLO_REPO, isNewer } from "../version";
import { resolveExpectedAgentVersion } from "../agent/release";
import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import { getCurrentUser } from "../auth/current-user";
import { deploHostServer } from "./instance-settings/settings-store";
import { recordActivity } from "./activity";

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

export interface DeploRelease {
  tag: string;
  name: string;
  url: string;
  publishedAt: string | null;
  body: string;
  prerelease: boolean;
  current: boolean;
}

const RELEASES_TAG = "deplo-releases";

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

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}

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

    if (res.status === 404) return base;
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

export async function getUpdateInfo(): Promise<UpdateInfo> {
  return fetchUpdateInfo(CACHED);
}

export async function refreshUpdateInfo(): Promise<UpdateInfo> {
  await requireInstanceAdmin();
  revalidateTag(RELEASES_TAG, { expire: 0 });
  return fetchUpdateInfo({ cache: "no-store" });
}

export function releaseProse(body: string, url: string): string {
  const cut = body.search(
    /^\s{0,3}#{1,6}\s*what'?s\s+changed\b|^\s*\*\*full\s+changelog\*\*/im,
  );
  const prose = (cut === -1 ? body : body.slice(0, cut)).trim();
  return prose || (body.trim() ? `[Read the notes on GitHub](${url})` : "");
}

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

    if (res.status === 404) return { releases: [] };
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
        const body = releaseProse(
          typeof r.body === "string" ? r.body : "",
          url,
        );
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

export async function refreshAgentVersion(): Promise<string> {
  await requireInstanceAdmin();
  const { refreshAgentRelease } = await import("../agent/release");
  await refreshAgentRelease();
  return resolveExpectedAgentVersion();
}

export interface DeploUpdateStarted {
  version: string;
  logPath: string;
}

export async function applyDeploUpdate(): Promise<DeploUpdateStarted> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const info = await getUpdateInfo();
  if (!info.updateAvailable || !info.latest)
    throw new Error(
      info.error ||
        `Deplo is already on the newest release (v${info.current}).`,
    );
  const version = normalizeTag(info.latest);

  const server = await deploHostServer();
  if (!server)
    throw new Error(
      "The machine Deplo runs on is not one of its servers, so Deplo cannot update itself here.",
    );

  const { updateControlPlaneOn } =
    await import("../infra/agent-client/host-ops");
  const res = await updateControlPlaneOn(
    server.id,
    hostname(),
    /^\d+\.\d+\.\d+$/.test(version) ? version : "",
  );
  if (!res.ok)
    throw new Error(
      res.error || "Deplo could not start the update on this host",
    );

  await recordActivity(
    "server",
    `Started the update of Deplo to v${version}`,
    user.name,
    null,
    teamId,
  );
  return { version, logPath: res.logPath };
}
