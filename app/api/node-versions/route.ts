import { getCurrentUser } from "@/lib/auth";

/**
 * Node.js major versions, synced from the official nodejs.org release index, for
 * the "Node.js version" autocomplete in build settings. nodejs.org/dist is CORS-
 * open but every dashboard client hitting it directly would be wasteful and
 * rate-sensitive, so — exactly like `/api/railpack-versions` — we proxy it
 * server-side behind a short-lived, process-wide cache so all clients share one
 * upstream call per TTL. Auth-gated to logged-in users.
 *
 * The stored value is a bare MAJOR ("22", "20") — that's what the builders pin
 * (Nixpacks' `NIXPACKS_NODE_VERSION`, Railpack's `RAILPACK_NODE_VERSION`, the
 * generated Dockerfile's `node:<major>-alpine`). The label carries the LTS
 * codename so the picker reads like the real release train.
 *
 *   GET /api/node-versions → { versions: [{ value: "22", label: "22 · LTS (Jod)" }, …] }
 */
const INDEX_URL = "https://nodejs.org/dist/index.json";
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — Node majors change very slowly.
/** How many distinct majors to surface (newest first). Covers current + recent. */
const MAX_MAJORS = 6;
/** Minimal fallback so the field still works if nodejs.org is unreachable. */
const FALLBACK: NodeVersion[] = [
  { value: "22", label: "22 · LTS (Jod)" },
  { value: "20", label: "20 · LTS (Iron)" },
];

interface NodeVersion {
  value: string;
  label: string;
}

/** One raw entry from nodejs.org/dist/index.json (only the fields we read). */
interface DistEntry {
  version?: string;
  /** false for a non-LTS line, or the LTS codename string (e.g. "Jod"). */
  lts?: false | string;
}

async function fetchVersions(): Promise<NodeVersion[]> {
  const res = await fetch(INDEX_URL, {
    headers: { Accept: "application/json", "User-Agent": "deplo" },
  });
  if (!res.ok) throw new Error(`nodejs.org responded ${res.status}`);
  const entries = (await res.json()) as DistEntry[];

  // The index is newest-first. Collapse to the newest entry per MAJOR so each
  // major is represented once, carrying that line's LTS status.
  const seen = new Set<string>();
  const majors: { value: string; lts: string | null; newest: boolean }[] = [];
  for (const e of entries) {
    const v = typeof e.version === "string" ? e.version.trim() : "";
    const m = v.match(/^v(\d+)\./);
    if (!m) continue;
    const major = m[1];
    if (seen.has(major)) continue;
    seen.add(major);
    const lts = typeof e.lts === "string" && e.lts ? e.lts : null;
    majors.push({ value: major, lts, newest: majors.length === 0 });
  }

  // Curate for a deployment platform: the newest release plus the LTS train.
  // The odd-numbered "Current" lines in between are short-lived (many already
  // EOL) and rarely what you pin in production — and the field still accepts
  // free text for anyone who wants one. Kept newest-first, capped.
  return majors
    .filter((mj) => mj.newest || mj.lts)
    .slice(0, MAX_MAJORS)
    .map((mj) => ({
      value: mj.value,
      label: mj.lts ? `${mj.value} · LTS (${mj.lts})` : `${mj.value} · Current`,
    }));
}

// Process-wide (per server instance) cache. `Date.now()` is fine in a request
// handler — this is app runtime, not a workflow script.
let cache: { at: number; versions: NodeVersion[] } | null = null;

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
    // nodejs.org unreachable — serve the last good cache if any, else a minimal
    // fallback so the field is still usable (it accepts free text too).
    return Response.json({ versions: cache?.versions ?? FALLBACK });
  }
}
