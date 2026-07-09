import { getCurrentUser } from "@/lib/auth";

/**
 * Railpack builder versions, synced from the railpack GitHub releases, for the
 * autocomplete in build settings. GitHub's API allows CORS but is rate-limited
 * per-IP (60/hr unauthenticated), and every dashboard client would hit it — so
 * we proxy server-side and hold a short-lived, process-wide cache so all clients
 * share one upstream call per TTL. Auth-gated to logged-in users.
 *
 *   GET /api/railpack-versions → { versions: ["latest", "v0.9.0", …] }
 */
const RELEASES_URL =
  "https://api.github.com/repos/railwayapp/railpack/releases?per_page=30";
const TTL_MS = 60 * 60 * 1000; // 1h — releases change slowly.
/** Minimal fallback so the input still works if GitHub is unreachable. */
const FALLBACK = ["latest"];

// Process-wide (per server instance) cache. `Date.now()` is fine in a request
// handler — this is app runtime, not a workflow script.
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
  // "latest" sentinel first (the default), then concrete releases newest-first
  // (GitHub returns them in that order).
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
    // GitHub unreachable / rate-limited — serve the last good cache if any, else
    // a minimal fallback so the field is still usable (it accepts free text too).
    return Response.json({ versions: cache?.versions ?? FALLBACK });
  }
}
