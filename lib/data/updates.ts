import "server-only";

import { DEPLO_VERSION, DEPLO_REPO, isNewer } from "../version";

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

/**
 * Ask GitHub for the latest published release of the Deplo repository and
 * compare it with the running version. Network/API failures degrade
 * gracefully to "no update" with an `error` note; a repo with no releases yet
 * (404) is treated as up to date. Cached for an hour to respect rate limits.
 */
export async function getUpdateInfo(): Promise<UpdateInfo> {
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
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "deplo-control-plane",
        },
        next: { revalidate: 3600 },
      },
    );

    if (res.status === 404) return base; // no releases published yet
    if (!res.ok) return { ...base, error: `GitHub API returned ${res.status}` };

    const json = (await res.json()) as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      published_at?: string;
    };
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
