import { getCurrentUser } from "@/lib/auth/current-user";

const INDEX_URL = "https://nodejs.org/dist/index.json";
const TTL_MS = 6 * 60 * 60 * 1000; // 6h - Node majors change very slowly.
const MAX_MAJORS = 6;
const FALLBACK: NodeVersion[] = [
  { value: "22", label: "22 · LTS (Jod)" },
  { value: "20", label: "20 · LTS (Iron)" },
];

interface NodeVersion {
  value: string;
  label: string;
}

interface DistEntry {
  version?: string;
  // false for a non-LTS line, or the LTS codename string (e.g. "Jod").
  lts?: false | string;
}

async function fetchVersions(): Promise<NodeVersion[]> {
  const res = await fetch(INDEX_URL, {
    headers: { Accept: "application/json", "User-Agent": "deplo" },
  });
  if (!res.ok) throw new Error(`nodejs.org responded ${res.status}`);
  const entries = (await res.json()) as DistEntry[];

  // The index is newest-first, so the first entry per major is that line's newest.
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

  return majors
    .filter((mj) => mj.newest || mj.lts)
    .slice(0, MAX_MAJORS)
    .map((mj) => ({
      value: mj.value,
      label: mj.lts ? `${mj.value} · LTS (${mj.lts})` : `${mj.value} · Current`,
    }));
}

// Date.now() is fine in a request handler - app runtime, not a workflow script.
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
    // The field accepts free text, so a stale or minimal list stays usable.
    return Response.json({ versions: cache?.versions ?? FALLBACK });
  }
}
