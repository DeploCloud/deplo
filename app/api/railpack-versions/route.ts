import { getCurrentUser } from "@/lib/auth/current-user";

const RELEASES_URL =
  "https://api.github.com/repos/railwayapp/railpack/releases?per_page=30";
const TTL_MS = 60 * 60 * 1000; // 1h - releases change slowly.
const FALLBACK = ["latest"];

// Date.now() is fine in a request handler - app runtime, not a workflow script.
let cache: { at: number; versions: string[] } | null = null;

async function fetchVersions(): Promise<string[]> {
  const res = await fetch(RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "deplo",
    },
  });
  if (!res.ok) throw new Error(`GitHub releases responded ${res.status}`);
  const releases = (await res.json()) as {
    tag_name?: string;
    draft?: boolean;
  }[];
  const tags = releases
    .filter((r) => r && !r.draft && typeof r.tag_name === "string")
    .map((r) => r.tag_name!.trim())
    .filter(Boolean);
  // GitHub returns releases newest-first; "latest" is the default sentinel.
  return ["latest", ...tags];
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    return Response.json({ versions: cache.versions });
  }
  try {
    const versions = await fetchVersions();
    cache = { at: now, versions };
    return Response.json({ versions });
  } catch {
    // Unreachable or rate-limited - the field accepts free text, so a stale list stays usable.
    return Response.json({ versions: cache?.versions ?? FALLBACK });
  }
}
