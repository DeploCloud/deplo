import "server-only";

import { revalidateTag } from "next/cache";

import { hostname } from "node:os";

import { getDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { nowIso } from "../ids";
import {
  bareVersion,
  DEPLO_VERSION,
  DEPLO_REPO,
  isNewer,
  newestVersion,
  rankedCurrent,
  versionTag,
} from "../version";
import { canaryReleasesEnabled } from "./release-channel";

export { canaryReleasesEnabled };
import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import { getCurrentUser } from "../auth/current-user";
import {
  deploHostServer,
  SETTINGS_ID,
} from "./instance-settings/settings-store";
import { recordActivity } from "./activity";
import {
  decideUpdate,
  passThisStopIfMet,
  thisStopWaiting,
  type UpdateStopInfo,
} from "./update-stops/decision";

export type { UpdateStopInfo };

export interface UpdateInfo {
  current: string;
  latest: string | null;
  // Update installs `next`: the newest release, or an update stop it has to come after (ADR-0041).
  updateAvailable: boolean;
  next: string | null;
  nextIsStop: boolean;
  stop: UpdateStopInfo | null;
  url: string | null;
  name: string | null;
  publishedAt: string | null;
  checkedAt: string;
  canary: boolean;
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
  available: boolean;
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

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
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

function listUrl(): string {
  return `https://api.github.com/repos/${DEPLO_REPO}/releases?per_page=${MAX_RELEASES}`;
}

// Stable asks GitHub for its "latest", which never names a pre-release; canary takes the newest of all.
async function fetchNewestRelease(
  init: RequestInit,
  canary: boolean,
): Promise<
  { release: GitHubRelease; current: string } | null | { error: string }
> {
  const res = await fetch(
    canary
      ? listUrl()
      : `https://api.github.com/repos/${DEPLO_REPO}/releases/latest`,
    { headers: GH_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS), ...init },
  );
  if (res.status === 404) return null;
  if (!res.ok) return { error: describeFailure(res) };
  const json = (await res.json()) as unknown;
  if (!canary)
    return { release: json as GitHubRelease, current: DEPLO_VERSION };
  if (!Array.isArray(json)) return null;
  const listed = (json as GitHubRelease[]).filter(
    (r) => r && !r.draft && typeof r.tag_name === "string",
  );
  const release = newestVersion(listed, (r) => r.tag_name!);
  if (!release) return null;
  const tags = listed.map((r) => r.tag_name!);
  return { release, current: rankedCurrent(DEPLO_VERSION, tags) };
}

// A stop can be older than the 20 releases the list carries, so it is looked up by its tag.
async function releasePublished(
  version: string,
  init: RequestInit,
): Promise<boolean | { error: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${DEPLO_REPO}/releases/tags/${versionTag(version)}`,
    { headers: GH_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS), ...init },
  );
  if (res.status === 404) return false;
  if (!res.ok) return { error: describeFailure(res) };
  return true;
}

async function fetchUpdateInfo(init: RequestInit): Promise<UpdateInfo> {
  const canary = await canaryReleasesEnabled();
  const base: UpdateInfo = {
    current: DEPLO_VERSION,
    latest: null,
    updateAvailable: false,
    next: null,
    nextIsStop: false,
    stop: null,
    url: null,
    name: null,
    publishedAt: null,
    checkedAt: new Date().toISOString(),
    canary,
  };

  try {
    const passed = await passThisStopIfMet();
    const info = await checkReleases(base, passed, init).catch(
      (e): UpdateInfo => ({ ...base, error: failure(e) }),
    );
    if (info.next || info.stop) return info;
    // Until this release's own stop passes, Updates names whom it waits on, newer release or not.
    return { ...info, stop: await thisStopWaiting(passed) };
  } catch (e) {
    return { ...base, error: failure(e) };
  }
}

const failure = (e: unknown) =>
  e instanceof Error ? e.message : "Update check failed";

async function checkReleases(
  base: UpdateInfo,
  passed: string[],
  init: RequestInit,
): Promise<UpdateInfo> {
  const found = await fetchNewestRelease(init, base.canary);
  if (!found) return base;
  if ("error" in found) return { ...base, error: found.error };
  const json = found.release;
  const tag = typeof json.tag_name === "string" ? json.tag_name : null;
  if (!tag) return base;

  const newest: UpdateInfo = {
    ...base,
    latest: tag,
    url:
      typeof json.html_url === "string"
        ? json.html_url
        : `https://github.com/${DEPLO_REPO}/releases`,
    name: typeof json.name === "string" && json.name ? json.name : tag,
    publishedAt:
      typeof json.published_at === "string" ? json.published_at : null,
  };
  if (!isNewer(tag, found.current)) return newest;
  const route = await decideUpdate(
    tag,
    passed,
    (v) => releasePublished(v, init),
    init,
  );
  if (route.error) return { ...newest, error: route.error };
  return {
    ...newest,
    updateAvailable: route.next !== null,
    next: route.next,
    nextIsStop: route.next !== null && route.stop?.version === route.next,
    stop: route.stop,
  };
}

// Ungated: the maintenance sweep asks with no one signed in. GraphQL reads `readUpdateInfo`.
export async function getUpdateInfo(): Promise<UpdateInfo> {
  return fetchUpdateInfo(CACHED);
}

export async function readUpdateInfo(): Promise<UpdateInfo> {
  await requireInstanceAdmin();
  return getUpdateInfo();
}

export async function refreshUpdateInfo(): Promise<UpdateInfo> {
  await requireInstanceAdmin();
  revalidateTag(RELEASES_TAG, { expire: 0 });
  return fetchUpdateInfo({ cache: "no-store" });
}

/** Offer canary versions of Deplo as updates, or go back to stable ones. Installs nothing by itself. */
export async function setCanaryReleases(enabled: boolean): Promise<UpdateInfo> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  if ((await canaryReleasesEnabled()) !== enabled) {
    const now = nowIso();
    await getDb()
      .insert(instanceSettings)
      .values({ id: SETTINGS_ID, canaryReleases: enabled, updatedAt: now })
      .onConflictDoUpdate({
        target: instanceSettings.id,
        set: { canaryReleases: enabled, updatedAt: now },
      });
    await recordActivity(
      "server",
      enabled
        ? "Switched Deplo to canary releases"
        : "Switched Deplo back to stable releases",
      user.name,
      null,
      teamId,
    );
  }
  return getUpdateInfo();
}

export async function listDeploReleases(): Promise<{
  releases: DeploRelease[];
  error?: string;
}> {
  await requireInstanceAdmin();
  const canary = await canaryReleasesEnabled();
  try {
    const res = await fetch(listUrl(), {
      headers: GH_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...CACHED,
    });

    if (res.status === 404) return { releases: [] };
    if (!res.ok) return { releases: [], error: describeFailure(res) };

    const json = (await res.json()) as GitHubRelease[];
    if (!Array.isArray(json)) return { releases: [] };

    const listed = json.filter((r): r is GitHubRelease => !!r && !r.draft);
    const current = rankedCurrent(
      DEPLO_VERSION,
      listed.flatMap((r) =>
        typeof r.tag_name === "string" ? [r.tag_name] : [],
      ),
    );
    // Only what Update brings in: up to `next`, which is an update stop when one comes first.
    const { next } = await getUpdateInfo();
    const releases = listed
      .map((r) => {
        const tag = typeof r.tag_name === "string" ? r.tag_name.trim() : "";
        if (!tag) return null;
        const url =
          typeof r.html_url === "string"
            ? r.html_url
            : `https://github.com/${DEPLO_REPO}/releases/tag/${tag}`;
        return {
          tag,
          name: typeof r.name === "string" && r.name ? r.name : tag,
          url,
          publishedAt:
            typeof r.published_at === "string" ? r.published_at : null,
          body: typeof r.body === "string" ? r.body.trim() : "",
          prerelease: r.prerelease === true,
          current: bareVersion(tag) === DEPLO_VERSION,
          available:
            next !== null && isNewer(tag, current) && !isNewer(tag, next),
        };
      })
      .filter((r): r is DeploRelease => r !== null)
      // On stable a canary stays out of the list, unless it is the one running.
      .filter((r) => canary || !r.prerelease || r.current);

    return { releases };
  } catch (e) {
    return {
      releases: [],
      error: e instanceof Error ? e.message : "Could not read the changelog",
    };
  }
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
  if (!info.next)
    throw new Error(
      info.error ||
        info.stop?.reason ||
        `Deplo is already on the newest release (v${info.current}).`,
    );
  const version = bareVersion(info.next);

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
    /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version) ? version : "",
  );
  if (!res.ok)
    throw new Error(
      res.error || "Deplo could not start the update on this host",
    );

  const { markAgentRolloutPending } = await import("./servers/agent-rollout");
  await markAgentRolloutPending(user.name);
  await recordActivity(
    "server",
    `Started the update of Deplo to v${version}`,
    user.name,
    null,
    teamId,
  );
  return { version, logPath: res.logPath };
}
